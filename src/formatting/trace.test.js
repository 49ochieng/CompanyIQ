const { test } = require("node:test");
const assert = require("node:assert");
const { renderTrace } = require("./trace");

test("no trace yet returns a helpful hint", () => {
    const out = renderTrace(undefined);
    assert.match(out, /No trace yet/);
});

test("a multi-tool turn lists each call in order with status and timing", () => {
    const out = renderTrace({
        input: "soy items from China and what the label rules are",
        latencyMs: 1234,
        calls: [
            { step: 1, tool: "queryCompanyData", ok: true, summary: "1 row", durationMs: 40 },
            { step: 2, tool: "ask_agent_compliance", ok: true, summary: "external result from agent:compliance", durationMs: 900 },
        ],
    });
    assert.match(out, /1\. ✅ \*\*queryCompanyData\*\* — 1 row · 40 ms/);
    assert.match(out, /2\. ✅ \*\*ask_agent_compliance\*\*/);
    assert.match(out, /2 tool calls, 940 ms of tool time in 1234 ms total/);
});

test("a rejected call shows a stop marker and its error summary", () => {
    const out = renderTrace({
        input: "another retailer's data",
        latencyMs: 20,
        calls: [{ step: 1, tool: "queryCompanyData", ok: false, summary: "error: validation_failed", durationMs: 5 }],
    });
    assert.match(out, /⛔ \*\*queryCompanyData\*\* — error: validation_failed/);
});

test("a no-tool turn explains it answered directly", () => {
    const out = renderTrace({ input: "who am I?", latencyMs: 12, calls: [] });
    assert.match(out, /No tools were called/);
});

test("an auth-required turn is flagged", () => {
    const out = renderTrace({
        input: "my emails",
        latencyMs: 30,
        authRequired: true,
        calls: [{ step: 1, tool: "searchEmail", ok: false, summary: "error: auth_required", durationMs: 3 }],
    });
    assert.match(out, /needed sign-in/);
});
