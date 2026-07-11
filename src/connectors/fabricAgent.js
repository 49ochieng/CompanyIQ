// Fabric data agent connector — identity-propagating delegation.
// Config: FABRIC_DATA_AGENTS env JSON — [{name, description, workspaceId, dataAgentId}]
//
// Each published data agent exposes an MCP endpoint:
//   https://api.fabric.microsoft.com/v1/mcp/workspaces/{workspaceId}/dataagents/{dataAgentId}/agent
// Requests carry the SIGNED-IN USER's token (audience api.fabric.microsoft.com,
// resolved from the bot's 'fabric' OAuth connection at call time), so Fabric
// enforces the caller's own workspace/agent permissions. A 401/403 is the
// security model working: it surfaces as a clean "you don't have access"
// message and is never retried with another identity.
const config = require("../config");
const { getCircuit, unavailableResult } = require("./circuit");
const { wrapUntrusted } = require("./payload");
const { withClient, textFromContent, isAccessDenied } = require("./mcpClient");
const { AUTH_REQUIRED } = require("../auth/graph");

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_DESCRIPTION = 500;

function endpointFor(agent) {
    return (
        "https://api.fabric.microsoft.com/v1/mcp/workspaces/" +
        `${encodeURIComponent(agent.workspaceId)}/dataagents/${encodeURIComponent(agent.dataAgentId)}/agent`
    );
}

function parseAgents(raw) {
    if (!raw) return [];
    let agents;
    try {
        agents = JSON.parse(raw);
    } catch (error) {
        console.error("FABRIC_DATA_AGENTS is not valid JSON; no Fabric agents loaded.", error.message);
        return [];
    }
    if (!Array.isArray(agents)) return [];
    return agents.filter((a) => {
        if (!a || !NAME_RE.test(a.name || "") || !a.workspaceId || !a.dataAgentId) {
            console.error(`Fabric data agent entry skipped (invalid): ${JSON.stringify(a?.name)}`);
            return false;
        }
        return true;
    });
}

/** Map our {question} onto whatever input schema the remote MCP tool declares. */
function argumentsFor(mcpTool, question) {
    const props = (mcpTool.inputSchema && mcpTool.inputSchema.properties) || {};
    if (props.question) return { question };
    const firstString = Object.entries(props).find(([, s]) => s && s.type === "string");
    if (firstString) return { [firstString[0]]: question };
    return { question };
}

function buildAgentTool(agent) {
    return {
        name: `ask_fabric_${agent.name}`,
        description: `[Fabric data agent, runs as the signed-in user] ${(agent.description || `Query the '${agent.name}' Fabric data agent.`).trim()}`.slice(
            0,
            MAX_DESCRIPTION
        ),
        parameters: {
            type: "object",
            properties: {
                question: {
                    type: "string",
                    description: "The data question to ask this agent, self-contained.",
                },
            },
            required: ["question"],
        },
        async handler(args, context) {
            const circuit = getCircuit(`fabric:${agent.name}`);
            if (circuit.isOpen()) {
                return unavailableResult(`fabric:${agent.name}`, circuit.status().retryInMs);
            }

            const connectionName = config.fabricConnectionName;
            const token = context && context.getAudienceToken
                ? await context.getAudienceToken(connectionName)
                : undefined;
            if (!token) {
                return { ...AUTH_REQUIRED, connectionName };
            }

            const server = { name: `fabric_${agent.name}`, url: endpointFor(agent) };
            const outcome = await circuit.exec(agent.name, (signal) =>
                withClient(server, async (client) => {
                    const listed = await client.listTools();
                    const tools = listed.tools || [];
                    if (tools.length === 0) {
                        throw new Error("Fabric data agent exposed no MCP tools");
                    }
                    const target = tools.find((t) => /ask|question|query|agent/i.test(t.name)) || tools[0];
                    const result = await client.callTool(
                        { name: target.name, arguments: argumentsFor(target, args.question) },
                        undefined,
                        { signal }
                    );
                    if (result.isError) {
                        throw new Error(textFromContent(result.content) || "Fabric data agent returned an error");
                    }
                    return { text: textFromContent(result.content) };
                }, `Bearer ${token}`).catch((error) => {
                    if (isAccessDenied(error)) {
                        return { accessDenied: true };
                    }
                    throw error;
                })
            );

            if (outcome.accessDenied) {
                return {
                    error: "access_denied",
                    message:
                        `You don't have access to the '${agent.name}' data agent with your account. ` +
                        "This is the permission model working — relay it to the user; never retry with a different identity or tool.",
                };
            }
            return wrapUntrusted(`fabric:${agent.name}`, outcome.text);
        },
    };
}

function loadFabricAgents(registerTool) {
    const agents = parseAgents(config.fabricDataAgents);
    for (const agent of agents) {
        registerTool(buildAgentTool(agent));
    }
    return agents.map((a) => a.name);
}

module.exports = { loadFabricAgents, buildAgentTool, parseAgents, endpointFor, argumentsFor };
