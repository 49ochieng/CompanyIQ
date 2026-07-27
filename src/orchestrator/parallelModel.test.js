const { test } = require("node:test");
const assert = require("node:assert");
const { LocalMemory } = require("@microsoft/teams.ai");
const { ParallelOpenAIChatModel } = require("./parallelModel");

// Build a model whose network call is a scripted fake, so we exercise our
// override (batched tool execution + the follow-up completion + recursion)
// without hitting Azure. The constructor needs a plausible Azure config.
function makeModel(scriptedCompletions) {
    const model = new ParallelOpenAIChatModel({
        model: "test-deployment",
        endpoint: "https://example.openai.azure.com",
        apiKey: "test",
        apiVersion: "2024-10-21",
    });
    let call = 0;
    model._openai = {
        chat: {
            completions: {
                create: async () => {
                    const next = scriptedCompletions[Math.min(call, scriptedCompletions.length - 1)];
                    call++;
                    return next;
                },
            },
        },
    };
    model._createCalls = () => call;
    return model;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function completionWithToolCalls(calls) {
    return {
        choices: [
            {
                message: {
                    content: null,
                    tool_calls: calls.map((c) => ({
                        id: c.id,
                        type: "function",
                        function: { name: c.name, arguments: c.arguments || "{}" },
                    })),
                },
            },
        ],
    };
}
const finalCompletion = (text) => ({ choices: [{ message: { content: text } }] });

test("independent tool calls in one round run concurrently", async () => {
    const model = makeModel([
        completionWithToolCalls([
            { id: "c1", name: "toolA" },
            { id: "c2", name: "toolB" },
        ]),
        finalCompletion("done"),
    ]);

    const timeline = {};
    const handler = (name) => async () => {
        timeline[`${name}_start`] = Date.now();
        await sleep(60);
        timeline[`${name}_end`] = Date.now();
        return { ok: true, name };
    };
    const functions = {
        toolA: { name: "toolA", description: "A", parameters: {}, handler: handler("toolA") },
        toolB: { name: "toolB", description: "B", parameters: {}, handler: handler("toolB") },
    };

    const messages = new LocalMemory();
    const res = await model.send({ role: "user", content: "hi" }, { messages, functions });

    // Concurrency: the later start happened before the earlier end (overlap).
    assert.ok(
        Math.max(timeline.toolA_start, timeline.toolB_start) < Math.min(timeline.toolA_end, timeline.toolB_end),
        "handlers did not overlap — they ran sequentially"
    );
    assert.strictEqual(res.content, "done");

    // Both function results were recorded in memory as role:function.
    const fnMsgs = (await messages.values()).filter((m) => m.role === "function");
    assert.strictEqual(fnMsgs.length, 2);
});

test("a single tool call still works (delegates to the SDK path)", async () => {
    const model = makeModel([
        completionWithToolCalls([{ id: "c1", name: "solo" }]),
        finalCompletion("single-done"),
    ]);
    let ran = false;
    const functions = {
        solo: { name: "solo", description: "S", parameters: {}, handler: async () => { ran = true; return { ok: true }; } },
    };
    const res = await model.send({ role: "user", content: "hi" }, { messages: new LocalMemory(), functions });
    assert.ok(ran, "single tool did not run");
    assert.strictEqual(res.content, "single-done");
});

test("multi-hop: a second round after a batch still chains to a final answer", async () => {
    // Round 1: a 2-call batch. Round 2: a single follow-up call. Round 3: final.
    const model = makeModel([
        completionWithToolCalls([
            { id: "c1", name: "toolA" },
            { id: "c2", name: "toolB" },
        ]),
        completionWithToolCalls([{ id: "c3", name: "toolC" }]),
        finalCompletion("composed answer"),
    ]);
    const calls = [];
    const mk = (name) => ({ name, description: name, parameters: {}, handler: async () => { calls.push(name); return { ok: true }; } });
    const functions = { toolA: mk("toolA"), toolB: mk("toolB"), toolC: mk("toolC") };

    const res = await model.send({ role: "user", content: "hi" }, { messages: new LocalMemory(), functions });
    assert.deepStrictEqual(calls.sort(), ["toolA", "toolB", "toolC"]);
    assert.strictEqual(res.content, "composed answer");
});

test("one throwing call in a batch does not discard its siblings", async () => {
    const model = makeModel([
        completionWithToolCalls([
            { id: "c1", name: "bad" },
            { id: "c2", name: "good" },
        ]),
        finalCompletion("resilient"),
    ]);
    let goodRan = false;
    const functions = {
        bad: { name: "bad", description: "bad", parameters: {}, handler: async () => { throw new Error("boom"); } },
        good: { name: "good", description: "good", parameters: {}, handler: async () => { goodRan = true; return { ok: true }; } },
    };
    const messages = new LocalMemory();
    const res = await model.send({ role: "user", content: "hi" }, { messages, functions });
    assert.ok(goodRan, "sibling call was discarded when its peer threw");
    assert.strictEqual(res.content, "resilient");
    const fnMsgs = (await messages.values()).filter((m) => m.role === "function");
    assert.strictEqual(fnMsgs.length, 2);
    assert.ok(
        fnMsgs.some((m) => /Error:/.test(m.content)),
        "the throwing call should be recorded as an error result"
    );
});
