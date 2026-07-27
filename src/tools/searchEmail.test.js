const { test, afterEach } = require("node:test");
const assert = require("node:assert");
const tool = require("./searchEmail");
const { AUTH_REQUIRED } = require("../auth/graph");

const originalFetch = global.fetch;
afterEach(() => {
    global.fetch = originalFetch;
});

function mockFetch(respond) {
    const calls = [];
    global.fetch = async (url, opts) => {
        calls.push({ url, opts });
        return respond(url, opts);
    };
    return calls;
}

function jsonResponse(status, body) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

test("returns AUTH_REQUIRED and never calls fetch when there is no graph token", async () => {
    const calls = mockFetch(() => jsonResponse(200, {}));
    const result = await tool.handler({ query: "from:catherine onboarding" }, {});
    assert.deepStrictEqual(result, AUTH_REQUIRED);
    assert.strictEqual(calls.length, 0);
});

test("searches /me/messages and maps results, falling back to address when no from name", async () => {
    const calls = mockFetch(() =>
        jsonResponse(200, {
            value: [
                {
                    subject: "Q3 onboarding checklist",
                    from: { emailAddress: { name: "Catherine Lee", address: "catherine@armely.com" } },
                    receivedDateTime: "2026-07-20T00:00:00Z",
                    bodyPreview: "Here is the checklist...",
                    webLink: "https://outlook.office.com/m1",
                },
                {
                    subject: "No display name",
                    from: { emailAddress: { address: "noreply@armely.com" } },
                    receivedDateTime: "2026-07-21T00:00:00Z",
                    bodyPreview: "...",
                    webLink: "https://outlook.office.com/m2",
                },
            ],
        })
    );

    const result = await tool.handler({ query: "from:catherine onboarding" }, { graphToken: "tok" });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].opts.headers.Authorization, "Bearer tok");
    assert.match(calls[0].url, /^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/messages\?\$search=/);

    assert.strictEqual(result.resultCount, 2);
    assert.strictEqual(result.results[0].from, "Catherine Lee");
    assert.strictEqual(result.results[1].from, "noreply@armely.com");
});

test("the audit log carries counts only, never the query text or message bodies", async () => {
    mockFetch(() =>
        jsonResponse(200, {
            value: [{ subject: "Secret deal terms", from: {}, bodyPreview: "confidential pricing $$$", webLink: "x" }],
        })
    );

    const logs = [];
    const originalLog = console.log;
    console.log = (line) => logs.push(line);
    try {
        await tool.handler({ query: "confidential pricing" }, { graphToken: "tok", conversationId: "c1" });
    } finally {
        console.log = originalLog;
    }

    const audit = JSON.parse(logs.find((l) => l.includes('"graph_call"')));
    assert.strictEqual(audit.tool, "searchEmail");
    assert.strictEqual(audit.resultCount, 1);
    const serialized = JSON.stringify(audit);
    assert.ok(!serialized.includes("confidential"), "query text leaked into the audit log");
    assert.ok(!serialized.includes("pricing"), "message body leaked into the audit log");
});

test("a Graph error propagates with the HTTP status attached", async () => {
    mockFetch(() => jsonResponse(429, { error: { message: "throttled" } }));
    await assert.rejects(
        () => tool.handler({ query: "x" }, { graphToken: "tok" }),
        (err) => {
            assert.strictEqual(err.status, 429);
            return true;
        }
    );
});
