// Foundry Agent Service connector (current, non-classic surface).
// Config: FOUNDRY_AGENTS env JSON — [{name, description, projectEndpoint,
// agentIdOrName, allowedContext?}]
//
// Invocation is the Responses API on the Foundry project endpoint with an
// agent_reference (verified against learn.microsoft.com, 2026-07):
//   POST {projectEndpoint}/openai/v1/responses
//   { "input": ..., "agent_reference": { "name": ..., "type": "agent_reference" } }
// Auth: Entra bearer for https://ai.azure.com/.default via DefaultAzureCredential
// (managed identity in Azure, az login locally). Stateless per delegation.
// The user's Graph OBO token is never forwarded (see payload.js).
const { getBearerTokenProvider } = require("@azure/identity");
const config = require("../config");
const { getAzureCredential } = require("../auth/azureCredential");
const { getCircuit, unavailableResult } = require("./circuit");
const { buildPayload, wrapUntrusted } = require("./payload");
const { assertUserScoped } = require("./validate");
const { isAccessDenied } = require("./mcpClient");
const { AUTH_REQUIRED } = require("../auth/graph");

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_DESCRIPTION = 500;

let tokenProvider;
function getFoundryToken() {
    if (!tokenProvider) {
        tokenProvider = getBearerTokenProvider(getAzureCredential(), "https://ai.azure.com/.default");
    }
    return tokenProvider();
}

function parseAgents(raw) {
    if (!raw) return [];
    let agents;
    try {
        agents = JSON.parse(raw);
    } catch (error) {
        console.error("FOUNDRY_AGENTS is not valid JSON; no Foundry agents loaded.", error.message);
        return [];
    }
    if (!Array.isArray(agents)) return [];
    return agents.filter((a) => {
        if (!a || !NAME_RE.test(a.name || "") || !a.projectEndpoint || !a.agentIdOrName) {
            console.error(`Foundry agent entry skipped (invalid): ${JSON.stringify(a?.name)}`);
            return false;
        }
        return true;
    });
}

function extractOutputText(data) {
    if (typeof data.output_text === "string" && data.output_text) {
        return data.output_text;
    }
    const parts = [];
    for (const item of data.output || []) {
        if (item.type === "message") {
            for (const c of item.content || []) {
                if (c.type === "output_text" && c.text) {
                    parts.push(c.text);
                }
            }
        }
    }
    return parts.join("\n");
}

// Preserve the agent's own web/knowledge citations (url_citation annotations on
// the Responses output) so agent web results carry sources and dates we can
// render — mirroring the httpAgent `citations[]` shape. De-duplicated by URL.
function extractCitations(data) {
    const citations = [];
    const seen = new Set();
    for (const item of data.output || []) {
        if (item.type !== "message") continue;
        for (const c of item.content || []) {
            for (const a of c.annotations || []) {
                if (a.type === "url_citation" && a.url && !seen.has(a.url)) {
                    seen.add(a.url);
                    citations.push({ title: String(a.title || a.url).slice(0, 120), url: a.url });
                }
            }
        }
    }
    return citations;
}

function buildAgentTool(agent) {
    // identity: "app" (default) uses the bot's own credential;
    // identity: "user" propagates the signed-in user's token so Foundry-side
    // and downstream permissions bind to the person asking (HR-agent pattern).
    const userIdentity = agent.identity === "user";
    return {
        name: `ask_agent_${agent.name}`,
        description: `[External agent${userIdentity ? ", runs as the signed-in user" : ""}] ${(agent.description || `Delegate a task to the '${agent.name}' agent.`).trim()}`.slice(
            0,
            MAX_DESCRIPTION
        ),
        parameters: {
            type: "object",
            properties: {
                task: {
                    type: "string",
                    description: "The task or question to delegate to this agent, self-contained.",
                },
            },
            required: ["task"],
        },
        async handler(args, context) {
            const circuit = getCircuit(`foundry:${agent.name}`);
            if (circuit.isOpen()) {
                return unavailableResult(`foundry:${agent.name}`, circuit.status().retryInMs);
            }

            // HARD RULE: a user-identity agent uses the user's token or
            // nothing. There is no fallback to the app credential — an access
            // failure must never silently escalate privileges.
            let bearer;
            if (userIdentity) {
                const token = context && context.getAudienceToken
                    ? await context.getAudienceToken(config.foundryConnectionName)
                    : undefined;
                if (!token) {
                    return { ...AUTH_REQUIRED, connectionName: config.foundryConnectionName };
                }
                bearer = token;
            } else {
                bearer = await getFoundryToken();
            }

            const payload = buildPayload(args.task, context, agent.allowedContext);
            let input = payload.task;
            if (payload.context) {
                input += `\n\n[Context: ${JSON.stringify(payload.context)}]`;
            }

            const outcome = await circuit.exec(agent.agentIdOrName, async (signal) => {
                const endpoint = agent.projectEndpoint.replace(/\/+$/, "");
                const res = await fetch(`${endpoint}/openai/v1/responses`, {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${bearer}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        input,
                        agent_reference: { name: agent.agentIdOrName, type: "agent_reference" },
                    }),
                    signal,
                });
                if (!res.ok) {
                    if (userIdentity && (res.status === 401 || res.status === 403)) {
                        return { accessDenied: true };
                    }
                    const detail = await res.text().catch(() => "");
                    throw new Error(`Foundry responses call failed: ${res.status} ${detail.slice(0, 200)}`);
                }
                const data = await res.json();
                return { text: extractOutputText(data), citations: extractCitations(data) };
            }).catch((error) => {
                if (userIdentity && isAccessDenied(error)) {
                    return { accessDenied: true };
                }
                throw error;
            });

            if (outcome.accessDenied) {
                return {
                    error: "access_denied",
                    message:
                        `You don't have access to the '${agent.name}' agent with your account ` +
                        "(Azure AI User role on its Foundry project is required). This is the permission " +
                        "model working — relay it to the user; never retry with a different identity.",
                };
            }
            return wrapUntrusted(`agent:${agent.name}`, outcome.text, {
                userScoped: agent.userScoped,
                citations: outcome.citations && outcome.citations.length ? outcome.citations : undefined,
            });
        },
    };
}

function loadFoundryAgents(registerTool) {
    const agents = parseAgents(config.foundryAgents);
    for (const agent of agents) {
        assertUserScoped(agent, "Foundry agent");
        registerTool(buildAgentTool(agent));
    }
    return agents.map((a) => a.name);
}

module.exports = { loadFoundryAgents, buildAgentTool, parseAgents, extractOutputText, extractCitations };
