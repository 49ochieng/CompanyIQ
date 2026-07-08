const { ChatPrompt } = require("@microsoft/teams.ai");
const { OpenAIChatModel } = require("@microsoft/teams.openai");
const fs = require("fs");
const path = require("path");
const config = require("../config");
const { getTools } = require("../tools");
const { getOpenAITokenProvider } = require("../auth/azureCredential");

// AF-1 fallback (UC-01): the exact reply for unknown or unparseable requests.
const AF1_MESSAGE =
    "I am unable to interpret your request. Please rephrase your request and try again. " +
    "If you have additional difficulties, please contact our support team.";

// Load the CompanyIQ system prompt once at startup.
const instructions = fs
    .readFileSync(path.join(__dirname, "..", "app", "instructions.txt"), "utf-8")
    .trim();

/**
 * Per-turn system prompt: the base instructions plus the signed-in user's
 * identity, so "what is my name?"-style questions are answerable and never
 * hit the fallback.
 */
function buildInstructions(context) {
    if (context.user) {
        const scope = context.userScope
            ? `Their company data scope is ${context.userScope}.`
            : "They have no company data scope assigned.";
        return (
            `${instructions}\n\nSigned-in user: ${context.user.name || "(name unknown)"} ` +
            `<${context.user.upn || context.user.aadObjectId}>. ${scope} ` +
            "Answer questions about their own identity directly from this line."
        );
    }
    return (
        `${instructions}\n\nNo user is signed in. If the user asks who they are or anything ` +
        'about their own identity, tell them to type "sign in" — never use the fallback message for that.'
    );
}

/**
 * Run one conversation turn through the LLM with function calling.
 *
 * ChatPrompt wraps `messages` in a LocalMemory that shares the array, so the
 * model's send() appends this round's user turn, any function-call rounds,
 * and the assistant reply to it — the caller persists it afterwards.
 *
 * @param {Object} turn
 * @param {string} turn.text The incoming user message.
 * @param {Array} turn.messages Conversation history (mutated in place).
 * @param {string} turn.conversationId Conversation ID, for audit logging.
 * @param {Object} [turn.context] Extra per-turn context passed to tool handlers.
 * @param {string[]} [turn.allowedTools] Restrict this turn to the named tools
 * (slash-command routing); omitted = all registered tools.
 * @returns {Promise<{content: string, toolCalls: Array, toolResults: Object}>}
 */
async function runTurn({ text, messages, conversationId, context = {}, allowedTools }) {
    const turnStartedAt = Date.now();
    const toolCalls = [];
    // Last result per tool name; the formatter uses these to render cards/citations.
    const toolResults = {};

    const prompt = new ChatPrompt({
        messages,
        instructions: buildInstructions(context),
        model: new OpenAIChatModel({
            model: config.azureOpenAIDeploymentName,
            // Entra (managed identity) auth when no key is configured.
            ...(config.azureOpenAIKey
                ? { apiKey: config.azureOpenAIKey }
                : { azureADTokenProvider: getOpenAITokenProvider() }),
            endpoint: config.azureOpenAIEndpoint,
            apiVersion: config.azureOpenAIApiVersion,
        }),
    });

    const available = allowedTools
        ? getTools().filter((t) => allowedTools.includes(t.name))
        : getTools();

    for (const tool of available) {
        prompt.function(tool.name, tool.description, tool.parameters, async (args) => {
            const startedAt = Date.now();
            try {
                const result = await tool.handler(args, { conversationId, ...context });
                toolResults[tool.name] = result;
                const rejected = !!(result && result.error);
                toolCalls.push({
                    tool: tool.name,
                    args,
                    ok: !rejected,
                    error: rejected ? result.error : undefined,
                    durationMs: Date.now() - startedAt,
                });
                logToolCall(conversationId, tool.name, args, result, Date.now() - startedAt);
                return result;
            } catch (error) {
                toolCalls.push({
                    tool: tool.name,
                    args,
                    ok: false,
                    error: error.message,
                    durationMs: Date.now() - startedAt,
                });
                logToolCall(conversationId, tool.name, args, { error: error.message }, Date.now() - startedAt);
                throw error;
            }
        });
    }

    const response = await prompt.send(text);
    let content = response.content || AF1_MESSAGE;

    // A Graph tool was selected but the user has no token: the caller sends
    // the sign-in flow and retries this question after sign-in completes.
    const authRequired = toolCalls.some((c) => c.error === "auth_required");

    // Hard AF-1 guarantee: if the model tried tools and every call was
    // rejected by validation (with no successful call), never guess.
    if (
        !authRequired &&
        toolCalls.length > 0 &&
        !toolCalls.some((c) => c.ok) &&
        toolCalls.some((c) => c.error === "validation_failed")
    ) {
        content = AF1_MESSAGE;
    }

    // Audit trail seed: one JSON line per turn showing routing.
    console.log(
        JSON.stringify({
            event: "turn",
            conversationId,
            input: text,
            toolsCalled: toolCalls.map((c) => c.tool),
            af1: content === AF1_MESSAGE,
            authRequired,
            userObjectId: context.user ? context.user.aadObjectId : undefined,
            latencyMs: Date.now() - turnStartedAt,
        })
    );

    return { content, toolCalls, toolResults, authRequired };
}

function logToolCall(conversationId, tool, args, result, durationMs) {
    console.log(
        JSON.stringify({
            event: "tool_call",
            conversationId,
            tool,
            args,
            rowCount: result && typeof result.rowCount === "number" ? result.rowCount : undefined,
            documentCount: result && Array.isArray(result.documents) ? result.documents.length : undefined,
            error: result && result.error ? result.error : undefined,
            durationMs,
        })
    );
}

module.exports = { runTurn, buildInstructions, AF1_MESSAGE };
