// A thin subclass of the SDK's OpenAIChatModel that executes an INDEPENDENT
// batch of tool calls concurrently.
//
// Why this exists: the installed @microsoft/teams.openai model runs a batched
// tool-call round (the model emitting several tool_calls in one assistant
// message) in a sequential `for` loop — each handler is awaited before the
// next starts. Multi-hop chaining (call A, see result, then call B) already
// works via the SDK's recursion and is unaffected. This class only changes the
// case where the model asks for several INDEPENDENT things at once (e.g. SQL +
// web + an agent for one question): those now run in parallel.
//
// Scope of the override is deliberately narrow:
//   - 0 or 1 tool calls in the round      -> delegate to super (unchanged).
//   - streaming (onChunk set)             -> delegate to super (we never stream;
//                                            avoids duplicating the stream path).
//   - >1 tool calls                       -> take over: fan out with Promise.all,
//                                            then issue the follow-up completion.
// The follow-up-completion half is a faithful copy of the SDK's own logic
// (same message mapping, same recursion) so the API contract is identical; only
// the execution loop differs. Locked by parallelModel.test.js.
const { OpenAIChatModel } = require("@microsoft/teams.openai");

class ParallelOpenAIChatModel extends OpenAIChatModel {
    async send(input, options = {}) {
        const calls = input && input.role === "model" ? input.function_calls : null;
        if (
            !calls ||
            calls.length <= 1 ||
            options.autoFunctionCalling === false ||
            options.onChunk
        ) {
            return super.send(input, options);
        }

        const memory = options.messages;
        await memory.push(input);

        // The one behavioral change: independent calls in a single round run
        // concurrently instead of one-after-another. A handler that throws is
        // recorded as an error result (matching how the SDK stringifies a failed
        // call) rather than rejecting the whole batch, so one bad call never
        // discards its siblings' work.
        await Promise.all(
            calls.map(async (call) => {
                const fn = (options.functions || {})[call.name];
                let content = "";
                if (!fn) {
                    content = `Error: function ${call.name} not found`;
                } else {
                    try {
                        content = JSON.stringify(await fn.handler(call.arguments));
                    } catch (err) {
                        content = err instanceof Error ? `Error: ${err.name} => ${err.message}` : String(err);
                    }
                }
                await memory.push({ role: "function", content, function_id: call.id });
            })
        );

        // --- From here down mirrors OpenAIChatModel.send (non-streaming path). ---
        const messages = await memory.values();
        if (options.system) {
            messages.unshift(options.system);
        }

        const completion = await this._openai.chat.completions.create({
            ...this.options.requestOptions,
            ...options.request,
            model: "endpoint" in this.options ? "" : this.options.model,
            stream: false,
            tools:
                Object.keys(options.functions || {}).length === 0
                    ? undefined
                    : Object.values(options.functions || {}).map((fn) => ({
                          type: "function",
                          function: { name: fn.name, description: fn.description, parameters: fn.parameters },
                      })),
            messages: messages.map((m) => mapMessage(m)),
        });

        const message = completion.choices[0].message;
        const modelMessage = {
            role: "model",
            audio: message.audio || undefined,
            content: message.content || undefined,
            context: message.context,
            function_calls: message.tool_calls?.map((call) => ({
                id: call.id,
                name: call.function.name,
                arguments: JSON.parse(call.function.arguments || "{}"),
            })),
        };

        // Auto function calling: another round (which may itself be a batch we
        // parallelize, or a single call the SDK handles) — same recursion the SDK uses.
        if (message.tool_calls && message.tool_calls.length > 0) {
            return this.send(modelMessage, { ...options, messages: memory });
        }

        await memory.push(modelMessage);
        return modelMessage;
    }
}

// Identical to the SDK's internal message mapping (model->assistant,
// function->tool, user passthrough incl. image parts).
function mapMessage(message) {
    if (message.role === "model") {
        return {
            role: "assistant",
            content: message.content,
            tool_calls: message.function_calls?.map((fn) => ({
                id: fn.id,
                type: "function",
                function: { name: fn.name, arguments: JSON.stringify(fn.arguments) },
            })),
        };
    }
    if (message.role === "function") {
        return { role: "tool", content: message.content || "", tool_call_id: message.function_id };
    }
    if (message.role === "user") {
        if (!message.content) {
            message.content = "";
        }
        return {
            role: "user",
            content:
                typeof message.content === "string"
                    ? message.content
                    : message.content.map((p) =>
                          p.type === "image_url" ? { type: p.type, image_url: { url: p.image_url } } : p
                      ),
        };
    }
    return message;
}

module.exports = { ParallelOpenAIChatModel };
