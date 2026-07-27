// Copilot Studio agent connector — always runs as the signed-in user.
// Config: COPILOT_STUDIO_AGENTS env JSON —
// [{name, description, environmentId?, schemaName?, directConnectUrl?, userScoped}]
// Either directConnectUrl, OR both environmentId and schemaName, are required
// (directConnectUrl wins if both are given — same precedence the SDK uses).
//
// Verified against the installed @microsoft/agents-copilotstudio-client
// source (node_modules/@microsoft/agents-copilotstudio-client/src), not just
// docs, 2026-07-27:
//   - `new CopilotStudioClient(settings, token)` takes a plain bearer token —
//     no MSAL dependency needed. We supply OUR OWN token via the bot's
//     'copilotstudio' OAuth connection (context.getAudienceToken), the same
//     identity-propagating pattern as fabric/foundry. Direct Line (the
//     app-only alternative) was deliberately rejected in the design writeup
//     because it does not propagate the caller's identity — this connector
//     exists specifically to preserve that guarantee, so there is no
//     app-identity mode here.
//   - The token audience for Prod cloud (our tenant) is
//     https://api.powerplatform.com/.default — confirmed two ways: reading
//     powerPlatformEnvironment.ts's getEndpointSuffix()/getTokenAudience(),
//     and an independent live check (`az account get-access-token --resource
//     https://api.powerplatform.com`, decoded `aud` claim matched exactly).
//   - The protocol is conversation-based over Server-Sent Events
//     (eventsource-client), not a single POST/response like Foundry. Each
//     call here starts a fresh conversation (stateless per delegation,
//     matching every other connector's "self-contained task" contract) then
//     sends one activity — two round trips, not one.
//
// KNOWN LIMITATION (read before trusting an access_denied classification):
// eventsource-client's onFetchResponse (node_modules/eventsource-client/src/
// client.ts) only special-cases HTTP 204; it does NOT check response.ok, so
// a 401/403 response body is handed to the SSE parser as if it were a valid
// stream instead of surfacing as a clean thrown error the way Foundry/Fabric
// give us. In practice this likely means an access-denied call comes back as
// zero yielded activities, indistinguishable from some other "nothing to
// say" case, NOT a clean access_denied result. Do not assume the two are
// distinguishable until an empirical two-account test proves otherwise
// (same bar as the AWA/Fabric checks) — this is called out for that test.
const { CopilotStudioClient } = require("@microsoft/agents-copilotstudio-client");
const { Activity, ActivityTypes } = require("@microsoft/agents-activity");
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
        console.error("COPILOT_STUDIO_AGENTS is not valid JSON; no Copilot Studio agents loaded.", error.message);
        return [];
    }
    if (!Array.isArray(agents)) return [];
    return agents.filter((a) => {
        const hasDirect = !!(a && a.directConnectUrl);
        const hasEnvSchema = !!(a && a.environmentId && a.schemaName);
        if (!a || !NAME_RE.test(a.name || "") || !(hasDirect || hasEnvSchema)) {
            console.error(
                `Copilot Studio agent entry skipped (invalid): ${JSON.stringify(a?.name)} — ` +
                    "needs directConnectUrl, or both environmentId and schemaName."
            );
            return false;
        }
        return true;
    });
}

/** Join every Message-type reply activity's text, in order. */
function extractText(activities) {
    return activities
        .filter((a) => a.type === ActivityTypes.Message && a.text)
        .map((a) => a.text)
        .join("\n")
        .trim();
}

function buildAgentTool(agent) {
    const settings = {
        environmentId: agent.environmentId,
        schemaName: agent.schemaName,
        directConnectUrl: agent.directConnectUrl,
    };
    return {
        name: `ask_agent_${agent.name}`,
        description: `[External agent, runs as the signed-in user] ${(agent.description || `Delegate a task to the '${agent.name}' Copilot Studio agent.`).trim()}`.slice(
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
            const circuit = getCircuit(`copilotstudio:${agent.name}`);
            if (circuit.isOpen()) {
                return unavailableResult(`copilotstudio:${agent.name}`, circuit.status().retryInMs);
            }

            const connectionName = config.copilotStudioConnectionName;
            const token = context && context.getAudienceToken
                ? await context.getAudienceToken(connectionName)
                : undefined;
            if (!token) {
                return { ...AUTH_REQUIRED, connectionName };
            }

            const payload = buildPayload(args.task, context, agent.allowedContext);
            let taskText = payload.task;
            if (payload.context) {
                taskText += `\n\n[Context: ${JSON.stringify(payload.context)}]`;
            }

            const text = await circuit.exec(agent.name, async () => {
                const client = new CopilotStudioClient(settings, token);

                let conversationId = "";
                for await (const activity of client.startConversationStreaming(true)) {
                    if (activity.conversation && activity.conversation.id) {
                        conversationId = activity.conversation.id;
                    }
                }

                const outgoing = Activity.fromObject({ type: "message", text: taskText });
                const replies = [];
                for await (const activity of client.sendActivityStreaming(outgoing, conversationId)) {
                    replies.push(activity);
                }
                return extractText(replies);
            });

            if (!text) {
                return {
                    error: "no_response",
                    message:
                        `The '${agent.name}' agent returned no reply. This connector cannot yet distinguish ` +
                        "an access-denied response from a genuinely empty one (see module header) — relay " +
                        "that this capability didn't return an answer; do not assume it means no access.",
                };
            }

            return wrapUntrusted(`agent:${agent.name}`, text, { userScoped: agent.userScoped });
        },
    };
}

function loadCopilotStudioAgents(registerTool) {
    const agents = parseAgents(config.copilotStudioAgents);
    for (const agent of agents) {
        assertUserScoped(agent, "Copilot Studio agent");
        registerTool(buildAgentTool(agent));
    }
    return agents.map((a) => a.name);
}

module.exports = { loadCopilotStudioAgents, buildAgentTool, parseAgents, extractText };
