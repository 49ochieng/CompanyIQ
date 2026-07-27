const { test, afterEach } = require("node:test");
const assert = require("node:assert");
const { OpenAIChatModel } = require("@microsoft/teams.openai");
const { ParallelOpenAIChatModel } = require("./parallelModel");
const config = require("../config");
const { selectModelClass } = require("./orchestrator");

const original = config.parallelToolCallsEnabled;
afterEach(() => {
    config.parallelToolCallsEnabled = original;
});

test("kill switch ON (default): parallel fan-out model is selected", () => {
    config.parallelToolCallsEnabled = true;
    assert.strictEqual(selectModelClass(), ParallelOpenAIChatModel);
});

test("kill switch OFF: falls back to the stock SDK model, not our subclass", () => {
    config.parallelToolCallsEnabled = false;
    assert.strictEqual(selectModelClass(), OpenAIChatModel);
    assert.notStrictEqual(selectModelClass(), ParallelOpenAIChatModel);
});
