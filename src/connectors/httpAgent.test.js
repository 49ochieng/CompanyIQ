const { test } = require("node:test");
const assert = require("node:assert");
const { buildAgentTool, parseAgents } = require("./httpAgent");

test("HTTP_AGENTS config validates name/url, and rejects an entry declaring both auth modes", () => {
    assert.strictEqual(parseAgents(JSON.stringify([{ name: "svc", url: "https://x/y" }])).length, 1);
    assert.strictEqual(parseAgents(JSON.stringify([{ name: "bad name!", url: "https://x" }])).length, 0);
    assert.strictEqual(parseAgents(JSON.stringify([{ name: "x" }])).length, 0);
    assert.deepStrictEqual(parseAgents("{nope"), []);
    // Ambiguous auth config: both a static token and an OBO connection.
    assert.strictEqual(
        parseAgents(JSON.stringify([{ name: "ambiguous", url: "https://x", tokenEnv: "T", oboConnection: "graph" }]))
            .length,
        0
    );
});

test("static tokenEnv mode: sends the env var's token, same for every caller", async () => {
    process.env.TEST_HTTP_AGENT_TOKEN = "STATIC-SECRET";
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, init) => {
        calls.push({ url, auth: init.headers.Authorization });
        return { ok: true, json: async () => ({ result: "answer" }) };
    };
    try {
        const tool = buildAgentTool({
            name: "static1",
            url: "https://svc.example.com/task",
            tokenEnv: "TEST_HTTP_AGENT_TOKEN",
            userScoped: false,
        });
        const result = await tool.handler({ task: "x" }, { user: { upn: "jane@armely.com" } });
        assert.strictEqual(calls[0].auth, "Bearer STATIC-SECRET");
        assert.strictEqual(result.userScoped, false);
    } finally {
        global.fetch = originalFetch;
        delete process.env.TEST_HTTP_AGENT_TOKEN;
    }
});

test("oboConnection mode: forwards the caller's own delegated token for that connection", async () => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, init) => {
        calls.push({ url, auth: init.headers.Authorization });
        return { ok: true, json: async () => ({ result: "answer", citations: [{ title: "src", url: "https://x" }] }) };
    };
    try {
        const tool = buildAgentTool({ name: "obo1", url: "https://svc.example.com/task", oboConnection: "graph", userScoped: true });
        const result = await tool.handler(
            { task: "x" },
            { user: { upn: "jane@armely.com" }, getAudienceToken: async (conn) => (conn === "graph" ? "USER-GRAPH-TOKEN" : undefined) }
        );
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].auth, "Bearer USER-GRAPH-TOKEN");
        assert.strictEqual(result.userScoped, true);
        assert.strictEqual(result.citations[0].title, "src");
    } finally {
        global.fetch = originalFetch;
    }
});

test("oboConnection mode without a token → auth_required carrying that connection name, no network call", async () => {
    let fetched = false;
    const originalFetch = global.fetch;
    global.fetch = async () => { fetched = true; throw new Error("must not be called"); };
    try {
        const tool = buildAgentTool({ name: "obo2", url: "https://svc.example.com/task", oboConnection: "fabric", userScoped: true });
        const result = await tool.handler({ task: "x" }, { user: { upn: "jane@armely.com" }, getAudienceToken: async () => undefined });
        assert.strictEqual(result.error, "auth_required");
        assert.strictEqual(result.connectionName, "fabric");
        assert.strictEqual(fetched, false);
    } finally {
        global.fetch = originalFetch;
    }
});

test("oboConnection mode when the context has no getAudienceToken at all → auth_required, never an unauthenticated call", async () => {
    let fetched = false;
    const originalFetch = global.fetch;
    global.fetch = async () => { fetched = true; throw new Error("must not be called"); };
    try {
        const tool = buildAgentTool({ name: "obo3", url: "https://svc.example.com/task", oboConnection: "fabric", userScoped: true });
        const result = await tool.handler({ task: "x" }, {});
        assert.strictEqual(result.error, "auth_required");
        assert.strictEqual(fetched, false);
    } finally {
        global.fetch = originalFetch;
    }
});

test("neither auth mode configured → the call is sent with no Authorization header", async () => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, init) => {
        calls.push({ url, headers: init.headers });
        return { ok: true, json: async () => ({ result: "public answer" }) };
    };
    try {
        const tool = buildAgentTool({ name: "anon1", url: "https://svc.example.com/task", userScoped: false });
        await tool.handler({ task: "x" }, {});
        assert.strictEqual(calls[0].headers.Authorization, undefined);
    } finally {
        global.fetch = originalFetch;
    }
});

test("an oboConnection call never forwards the token to the static tokenEnv path (mutually exclusive at runtime too)", async () => {
    process.env.TEST_HTTP_AGENT_TOKEN2 = "SHOULD-NOT-BE-SENT";
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, init) => {
        calls.push({ auth: init.headers.Authorization });
        return { ok: true, json: async () => ({ result: "x" }) };
    };
    try {
        // Config only sets oboConnection — tokenEnv is absent, so even though
        // an env var of that name-ish exists elsewhere it must never be used.
        const tool = buildAgentTool({ name: "obo4", url: "https://svc.example.com/task", oboConnection: "graph", userScoped: true });
        await tool.handler({ task: "x" }, { getAudienceToken: async () => "USER-TOKEN" });
        assert.strictEqual(calls[0].auth, "Bearer USER-TOKEN");
    } finally {
        global.fetch = originalFetch;
        delete process.env.TEST_HTTP_AGENT_TOKEN2;
    }
});
