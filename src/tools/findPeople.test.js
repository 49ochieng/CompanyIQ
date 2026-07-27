const { test, afterEach } = require("node:test");
const assert = require("node:assert");
const tool = require("./findPeople");
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
    const result = await tool.handler({ name: "Catherine" }, {});
    assert.deepStrictEqual(result, AUTH_REQUIRED);
    assert.strictEqual(calls.length, 0);
});

test("searches /me/people and maps name/email/title", async () => {
    const calls = mockFetch(() =>
        jsonResponse(200, {
            value: [
                {
                    displayName: "Catherine Lee",
                    scoredEmailAddresses: [{ address: "catherine@armely.com" }],
                    jobTitle: "Ops Lead",
                },
            ],
        })
    );

    const result = await tool.handler({ name: "Catherine" }, { graphToken: "tok" });

    assert.strictEqual(calls[0].opts.headers.Authorization, "Bearer tok");
    assert.match(calls[0].url, /^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/people\?\$search=/);
    assert.strictEqual(result.peopleCount, 1);
    assert.deepStrictEqual(result.people[0], { name: "Catherine Lee", email: "catherine@armely.com", title: "Ops Lead" });
});

test("a person with no scored email address maps to email: undefined, not a throw", async () => {
    mockFetch(() =>
        jsonResponse(200, { value: [{ displayName: "No Email Person", scoredEmailAddresses: [], jobTitle: "Intern" }] })
    );
    const result = await tool.handler({ name: "No Email" }, { graphToken: "tok" });
    assert.strictEqual(result.people[0].email, undefined);
});

test("a Graph error propagates with the HTTP status attached", async () => {
    mockFetch(() => jsonResponse(403, { error: { message: "forbidden" } }));
    await assert.rejects(
        () => tool.handler({ name: "x" }, { graphToken: "tok" }),
        (err) => {
            assert.strictEqual(err.status, 403);
            return true;
        }
    );
});
