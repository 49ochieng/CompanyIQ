const { test, afterEach } = require("node:test");
const assert = require("node:assert");
const tool = require("./getPlannerTasks");
const { AUTH_REQUIRED } = require("../auth/graph");

const originalFetch = global.fetch;
afterEach(() => {
    global.fetch = originalFetch;
});

function jsonResponse(status, body) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

// Routes by URL path so the two-stage tasks->plan-titles flow can be scripted.
function mockFetchRouted(routes) {
    const calls = [];
    global.fetch = async (url, opts) => {
        calls.push({ url, opts });
        for (const [pattern, respond] of routes) {
            if (pattern.test(url)) return respond(url);
        }
        throw new Error(`Unmocked URL: ${url}`);
    };
    return calls;
}

test("returns AUTH_REQUIRED and never calls fetch when there is no graph token", async () => {
    const calls = mockFetchRouted([[/.*/, () => jsonResponse(200, { value: [] })]]);
    const result = await tool.handler({}, {});
    assert.deepStrictEqual(result, AUTH_REQUIRED);
    assert.strictEqual(calls.length, 0);
});

test("resolves plan titles, filters completed tasks by default, and caps at MAX_TASKS", async () => {
    const calls = mockFetchRouted([
        [
            /\/me\/planner\/tasks$/,
            () =>
                jsonResponse(200, {
                    value: [
                        { title: "Open task", dueDateTime: "2026-08-01T00:00:00Z", percentComplete: 0, planId: "planA" },
                        { title: "Done task", dueDateTime: "2026-07-01T00:00:00Z", percentComplete: 100, planId: "planA" },
                        { title: "Other plan task", dueDateTime: null, percentComplete: 50, planId: "planB" },
                    ],
                }),
        ],
        [/\/planner\/plans\/planA/, () => jsonResponse(200, { title: "Onboarding Plan" })],
        [/\/planner\/plans\/planB/, () => jsonResponse(200, { title: "Vendor Plan" })],
    ]);

    const result = await tool.handler({}, { graphToken: "tok" });

    assert.strictEqual(calls[0].opts.headers.Authorization, "Bearer tok");
    assert.strictEqual(result.taskCount, 2);
    assert.ok(result.tasks.every((t) => t.title !== "Done task"), "completed task should be excluded by default");
    assert.strictEqual(result.tasks.find((t) => t.title === "Open task").planTitle, "Onboarding Plan");
    assert.strictEqual(result.tasks.find((t) => t.title === "Other plan task").planTitle, "Vendor Plan");
});

test("onlyOpen:false includes completed tasks", async () => {
    mockFetchRouted([
        [
            /\/me\/planner\/tasks$/,
            () => jsonResponse(200, { value: [{ title: "Done task", percentComplete: 100, planId: "planA" }] }),
        ],
        [/\/planner\/plans\/planA/, () => jsonResponse(200, { title: "Onboarding Plan" })],
    ]);

    const result = await tool.handler({ onlyOpen: false }, { graphToken: "tok" });
    assert.strictEqual(result.taskCount, 1);
    assert.strictEqual(result.tasks[0].title, "Done task");
});

test("a plan-title lookup failure leaves planTitle undefined instead of failing the whole call", async () => {
    mockFetchRouted([
        [
            /\/me\/planner\/tasks$/,
            () => jsonResponse(200, { value: [{ title: "Task", percentComplete: 0, planId: "brokenPlan" }] }),
        ],
        [/\/planner\/plans\/brokenPlan/, () => jsonResponse(404, { error: { message: "not found" } })],
    ]);

    const result = await tool.handler({}, { graphToken: "tok" });
    assert.strictEqual(result.taskCount, 1);
    assert.strictEqual(result.tasks[0].planTitle, undefined);
});

test("a failure on the main task list still propagates with its HTTP status", async () => {
    mockFetchRouted([[/\/me\/planner\/tasks$/, () => jsonResponse(500, { error: { message: "boom" } })]]);
    await assert.rejects(
        () => tool.handler({}, { graphToken: "tok" }),
        (err) => {
            assert.strictEqual(err.status, 500);
            return true;
        }
    );
});
