const { test, afterEach } = require("node:test");
const assert = require("node:assert");
const tool = require("./searchOneDrive");
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
    const result = await tool.handler({ query: "expense report" }, {});
    assert.deepStrictEqual(result, AUTH_REQUIRED);
    assert.strictEqual(calls.length, 0);
});

test("scopes the search to /me/drive and maps results", async () => {
    const calls = mockFetch(() =>
        jsonResponse(200, {
            value: [
                { name: "Expense Draft.xlsx", webUrl: "https://od/x", lastModifiedDateTime: "2026-07-20T00:00:00Z", size: 1024 },
            ],
        })
    );

    const result = await tool.handler({ query: "expense draft" }, { graphToken: "tok" });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].opts.headers.Authorization, "Bearer tok");
    assert.match(calls[0].url, /^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/drive\/root\/search\(q='/);

    assert.strictEqual(result.resultCount, 1);
    assert.deepStrictEqual(result.results[0], {
        title: "Expense Draft.xlsx",
        webUrl: "https://od/x",
        lastModified: "2026-07-20T00:00:00Z",
    });
});

test("doubles a single quote in the query for OData escaping", async () => {
    const calls = mockFetch(() => jsonResponse(200, { value: [] }));
    await tool.handler({ query: "vendor's report" }, { graphToken: "tok" });
    assert.match(decodeURIComponent(calls[0].url), /vendor''s report/);
});

test("a Graph error propagates with the HTTP status attached", async () => {
    mockFetch(() => jsonResponse(401, { error: { message: "unauthorized" } }));
    await assert.rejects(
        () => tool.handler({ query: "x" }, { graphToken: "expired" }),
        (err) => {
            assert.strictEqual(err.status, 401);
            return true;
        }
    );
});
