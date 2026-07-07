// Generic self-hosted agent connector — the contract Mela AI or other Armely
// workers can implement: POST {task, context?} with a bearer token, respond
// {result, citations?}. Config: HTTP_AGENTS env JSON —
// [{name, description, url, tokenEnv, allowedContext?}]
// tokenEnv names the environment variable holding the bearer token, so tokens
// stay out of the (non-secret) connector config.
const config = require("../config");
const { getCircuit, unavailableResult } = require("./circuit");
const { buildPayload, wrapUntrusted } = require("./payload");

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

            const payload = buildPayload(args.task, context, agent.allowedContext);
            const token = agent.tokenEnv ? process.env[agent.tokenEnv] : undefined;

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
                citations: Array.isArray(body.citations) ? body.citations.slice(0, 10) : undefined,
            });
        },
    };
}

function loadHttpAgents(registerTool) {
    const agents = parseAgents(config.httpAgents);
    for (const agent of agents) {
        registerTool(buildAgentTool(agent));
    }
    return agents.map((a) => a.name);
}

module.exports = { loadHttpAgents, buildAgentTool, parseAgents };
