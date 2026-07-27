const { test, afterEach } = require("node:test");
const assert = require("node:assert");
const tool = require("./searchSharePoint");
const config = require("../config");
const { AUTH_REQUIRED } = require("../auth/graph");

const originalFetch = global.fetch;
const originalSites = config.sharePointSites;
afterEach(() => {
    global.fetch = originalFetch;
    config.sharePointSites = originalSites;
});

function mockFetch(respond) {
    const calls = [];
    global.fetch = async (url, opts) => {
        calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : undefined });
        return respond(url, opts);
    };
    return calls;
}

function jsonResponse(status, body) {
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

test("returns AUTH_REQUIRED and never calls fetch when there is no graph token", async () => {
    const calls = mockFetch(() => jsonResponse(200, {}));
    const result = await tool.handler({ query: "onboarding" }, {});
    assert.deepStrictEqual(result, AUTH_REQUIRED);
    assert.strictEqual(calls.length, 0);
});

test("constrains the query to configured SharePoint sites via path: filters", async () => {
    config.sharePointSites = "armely.sharepoint.com/sites/HR, armely.sharepoint.com/sites/IT";
    const calls = mockFetch(() =>
        jsonResponse(200, {
            value: [
                {
                    hitsContainers: [
                        {
                            hits: [
                                {
                                    summary: "The <c0>onboarding</c0> guide<ddd/> covers day one.",
                                    resource: { name: "Onboarding Guide.docx", webUrl: "https://sp/onboarding" },
                                },
                            ],
                        },
                    ],
                },
            ],
        })
    );

    const result = await tool.handler({ query: "onboarding" }, { graphToken: "tok" });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].opts.headers.Authorization, "Bearer tok");
    const q = calls[0].body.requests[0].query.queryString;
    assert.match(q, /path:"armely\.sharepoint\.com\/sites\/HR"/);
    assert.match(q, /path:"armely\.sharepoint\.com\/sites\/IT"/);
    assert.match(q, / OR /);

    assert.strictEqual(result.resultCount, 1);
    assert.deepStrictEqual(result.results[0], {
        title: "Onboarding Guide.docx",
        snippet: "The onboarding guide covers day one.",
        webUrl: "https://sp/onboarding",
    });
});

test("with no configured sites, the query is sent unfiltered", async () => {
    config.sharePointSites = "";
    const calls = mockFetch(() => jsonResponse(200, { value: [{ hitsContainers: [{ hits: [] }] }] }));
    await tool.handler({ query: "policy" }, { graphToken: "tok" });
    assert.strictEqual(calls[0].body.requests[0].query.queryString, "policy");
});

test("a missing hitsContainers/hits shape yields zero results, not a throw", async () => {
    mockFetch(() => jsonResponse(200, { value: [] }));
    const result = await tool.handler({ query: "x" }, { graphToken: "tok" });
    assert.strictEqual(result.resultCount, 0);
    assert.deepStrictEqual(result.results, []);
});

test("a Graph error propagates with the HTTP status attached", async () => {
    mockFetch(() => jsonResponse(500, { error: { message: "boom" } }));
    await assert.rejects(
        () => tool.handler({ query: "x" }, { graphToken: "tok" }),
        (err) => {
            assert.strictEqual(err.status, 500);
            return true;
        }
    );
});
