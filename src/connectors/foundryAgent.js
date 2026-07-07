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

function buildAgentTool(agent) {
    return {
        name: `ask_agent_${agent.name}`,
        description: `[External agent] ${(agent.description || `Delegate a task to the '${agent.name}' agent.`).trim()}`.slice(
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

            const payload = buildPayload(args.task, context, agent.allowedContext);
            let input = payload.task;
            if (payload.context) {
                input += `\n\n[Context: ${JSON.stringify(payload.context)}]`;
            }

            const text = await circuit.exec(agent.agentIdOrName, async (signal) => {
                const endpoint = agent.projectEndpoint.replace(/\/+$/, "");
                const res = await fetch(`${endpoint}/openai/v1/responses`, {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${await getFoundryToken()}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        input,
                        agent_reference: { name: agent.agentIdOrName, type: "agent_reference" },
                    }),
                    signal,
                });
                if (!res.ok) {
                    const detail = await res.text().catch(() => "");
                    throw new Error(`Foundry responses call failed: ${res.status} ${detail.slice(0, 200)}`);
                }
                return extractOutputText(await res.json());
            });

            return wrapUntrusted(`agent:${agent.name}`, text);
        },
    };
}

function loadFoundryAgents(registerTool) {
    const agents = parseAgents(config.foundryAgents);
    for (const agent of agents) {
        registerTool(buildAgentTool(agent));
    }
    return agents.map((a) => a.name);
}

module.exports = { loadFoundryAgents, buildAgentTool, parseAgents, extractOutputText };
