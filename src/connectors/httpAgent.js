// Generic self-hosted agent connector — the contract Mela AI or other Armely
// workers can implement: POST {task, context?} with a bearer token, respond
// {result, citations?}. Config: HTTP_AGENTS env JSON —
// [{name, description, url, tokenEnv?, oboConnection?, allowedContext?, userScoped}]
//
// Two mutually exclusive auth modes:
//   - tokenEnv: a STATIC app-level bearer token from an env var. The same
//     token for every caller — appropriate only for genuinely org-wide
//     services with no per-user access difference. userScoped:false.
//   - oboConnection: the NAME of one of the bot's own OAuth connections
//     (e.g. "graph", "fabric") — NOT an arbitrary audience string. The
//     caller's own delegated token for that connection's audience is
//     forwarded, so a service we own can validate it and enforce the
//     caller's actual access. This only provides a real guarantee if the
//     receiving service verifies the token (signature/issuer/audience) and
//     authorizes on its claims — forwarding it alone is not a control.
//     userScoped:true is only honest once that's confirmed, same bar as
//     every other connector.
const config = require("../config");
const { getCircuit, unavailableResult } = require("./circuit");
const { buildPayload, wrapUntrusted } = require("./payload");
const { assertUserScoped } = require("./validate");
const { AUTH_REQUIRED } = require("../auth/graph");

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_DESCRIPTION = 500;

function parseAgents(raw) {
    if (!raw) return [];
    let agents;
    try {
        agents = JSON.parse(raw);
    } catch (error) {
        console.error("HTTP_AGENTS is not valid JSON; no HTTP agents loaded.", error.message);
        return [];
    }
    if (!Array.isArray(agents)) return [];
    return agents.filter((a) => {
        if (!a || !NAME_RE.test(a.name || "") || !a.url) {
            console.error(`HTTP agent entry skipped (invalid): ${JSON.stringify(a?.name)}`);
            return false;
        }
        if (a.tokenEnv && a.oboConnection) {
            console.error(
                `HTTP agent entry skipped (invalid): '${a.name}' sets both tokenEnv and oboConnection — pick one auth mode.`
            );
            return false;
        }
        return true;
    });
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
            const circuit = getCircuit(`http:${agent.name}`);
            if (circuit.isOpen()) {
                return unavailableResult(`http:${agent.name}`, circuit.status().retryInMs);
            }

            let token;
            if (agent.oboConnection) {
                token =
                    context && context.getAudienceToken
                        ? await context.getAudienceToken(agent.oboConnection)
                        : undefined;
                if (!token) {
                    return { ...AUTH_REQUIRED, connectionName: agent.oboConnection };
                }
            } else if (agent.tokenEnv) {
                token = process.env[agent.tokenEnv];
            }

            const payload = buildPayload(args.task, context, agent.allowedContext);

            const body = await circuit.exec(agent.name, async (signal) => {
                const res = await fetch(agent.url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        ...(token ? { Authorization: `Bearer ${token}` } : {}),
                    },
                    body: JSON.stringify(payload),
                    signal,
                });
                if (!res.ok) {
                    const detail = await res.text().catch(() => "");
                    throw new Error(`HTTP agent call failed: ${res.status} ${detail.slice(0, 200)}`);
                }
                return res.json();
            });

            return wrapUntrusted(`agent:${agent.name}`, body.result, {
                userScoped: agent.userScoped,
                citations: Array.isArray(body.citations) ? body.citations.slice(0, 10) : undefined,
            });
        },
    };
}

function loadHttpAgents(registerTool) {
    const agents = parseAgents(config.httpAgents);
    for (const agent of agents) {
        assertUserScoped(agent, "HTTP agent");
        registerTool(buildAgentTool(agent));
    }
    return agents.map((a) => a.name);
}

module.exports = { loadHttpAgents, buildAgentTool, parseAgents };
