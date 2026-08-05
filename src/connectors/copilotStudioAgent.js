// Copilot Studio agent connector — always runs as the signed-in user.
// Config: COPILOT_STUDIO_AGENTS env JSON —
// [{name, description, environmentId?, schemaName?, directConnectUrl?, userScoped}]
// Either directConnectUrl, OR both environmentId and schemaName, are required
// (directConnectUrl wins if both are given — same precedence the SDK uses).
//
// DELIBERATELY BYPASSES the high-level CopilotStudioClient class from
// @microsoft/agents-copilotstudio-client and talks to the SSE endpoint
// directly, using only the package's exported low-level helpers
// (getCopilotStudioConnectionUrl, ExecuteTurnRequest, UserAgentHelper) plus
// Activity/ActivityTypes from @microsoft/agents-activity and eventsource-
// parser's createParser (a real, already-resolved transitive dependency,
// added here as our own direct one). Reasons, found by reading the
// installed source, not docs (2026-07-27):
//   1. ACCESS-DENIED DETECTION: CopilotStudioClient's internal transport
//      (eventsource-client) never checks response.ok — a 401/403 body gets
//      handed to the SSE parser as if it were a valid stream. Our own
//      request function below checks res.ok BEFORE touching the body, so a
//      401/403 throws with `.status` set and is translated to a clean
//      access_denied result, same contract as foundryAgent.js/fabricAgent.js.
//   2. RUNAWAY RETRY: worse than just "can't detect the status" — when the
//      response body stream ends without a recognized SSE 'end' event (which
//      is what a non-SSE error body produces), eventsource-client's read
//      loop (node_modules/eventsource-client/src/client.ts, the `do { ...
//      scheduleReconnect() ... } while (open)` block) treats it as a DROPPED
//      connection and automatically reconnects — it does not error, it
//      retries. For a single stateless tool call that's the wrong behavior
//      regardless of the detection question: we want one request, one
//      answer, no open-ended reconnect loop hidden inside a `handler()`
//      call. Talking to the endpoint directly avoids that entirely — no
//      reconnect logic exists here.
// Token audience confirmed two ways: reading getEndpointSuffix()/
// getTokenAudience() in the installed powerPlatformEnvironment.ts, and an
// independent live check (`az account get-access-token --resource
// https://api.powerplatform.com`, decoded `aud` claim matched exactly).
const {
    getCopilotStudioConnectionUrl,
    ExecuteTurnRequest,
    UserAgentHelper,
} = require("@microsoft/agents-copilotstudio-client");
const { Activity, ActivityTypes } = require("@microsoft/agents-activity");
const { createParser } = require("eventsource-parser");
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

/**
 * POST one SSE request and collect the activities it yields. Checks
 * response.ok BEFORE reading the body — see module header for why that
 * matters here specifically. No reconnect: one request, one answer.
 * @returns {Promise<{activities: Activity[], conversationId: string|undefined}>}
 */
async function postAndCollectActivities(url, token, body, signal) {
    const res = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "User-Agent": UserAgentHelper.getProductInfo(),
        },
        body: JSON.stringify(body),
        signal,
    });

    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        const error = new Error(`Copilot Studio call failed: ${res.status} ${detail.slice(0, 200)}`);
        error.status = res.status;
        throw error;
    }

    const conversationId = res.headers.get("x-ms-conversationid") || undefined;
    const activities = [];
    const parser = createParser({
        onEvent(event) {
            if (event.event === "activity" && event.data) {
                try {
                    activities.push(Activity.fromJson(event.data));
                } catch {
                    // Malformed frame: skip it, don't fail the whole call.
                }
            }
        },
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
        const { done, value } = await reader.read();
        if (value) {
            parser.feed(decoder.decode(value, { stream: !done }));
        }
        if (done) break;
    }

    return { activities, conversationId };
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

            const outcome = await circuit
                .exec(agent.name, async (signal) => {
                    const startUrl = getCopilotStudioConnectionUrl(settings);
                    const start = await postAndCollectActivities(
                        startUrl,
                        token,
                        { emitStartConversationEvent: true },
                        signal
                    );
                    let conversationId = start.conversationId;
                    for (const a of start.activities) {
                        if (a.conversation && a.conversation.id) conversationId = a.conversation.id;
                    }

                    const outgoing = Activity.fromObject({ type: "message", text: taskText });
                    const sendUrl = getCopilotStudioConnectionUrl(settings, conversationId);
                    const turnRequest = new ExecuteTurnRequest(outgoing);
                    const sent = await postAndCollectActivities(sendUrl, token, turnRequest, signal);
                    return { text: extractText(sent.activities) };
                })
                .catch((error) => {
                    if (error.status === 401 || error.status === 403) {
                        return { accessDenied: true };
                    }
                    throw error;
                });

            if (outcome.accessDenied) {
                return {
                    error: "access_denied",
                    message:
                        `You don't have access to the '${agent.name}' agent with your account. ` +
                        "This is the permission model working — relay it to the user; never retry with a different identity.",
                };
            }
            if (!outcome.text) {
                return {
                    error: "no_response",
                    message: `The '${agent.name}' agent returned no reply. Relay that this capability didn't return an answer.`,
                };
            }

            return wrapUntrusted(`agent:${agent.name}`, outcome.text, { userScoped: agent.userScoped });
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

module.exports = { loadCopilotStudioAgents, buildAgentTool, parseAgents, extractText, postAndCollectActivities };
