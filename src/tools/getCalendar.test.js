const { test, afterEach } = require("node:test");
const assert = require("node:assert");
const tool = require("./getCalendar");
const { AUTH_REQUIRED } = require("../auth/graph");

const originalFetch = global.fetch;
afterEach(() => {
    global.fetch = originalFetch;
});

// Records every call and lets the test script a response (or throw) per call.
function mockFetch(respond) {
    const calls = [];
    global.fetch = async (url, opts) => {
        calls.push({ url, opts });
        return respond(url, opts);
    };
    return calls;
}

function jsonResponse(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
}

test("returns AUTH_REQUIRED and never calls fetch when there is no graph token", async () => {
    const calls = mockFetch(() => jsonResponse(200, { value: [] }));
    const result = await tool.handler({}, {});
    assert.deepStrictEqual(result, AUTH_REQUIRED);
    assert.strictEqual(calls.length, 0);
});

test("maps calendar events and sends the bearer token + expected query params", async () => {
    const calls = mockFetch(() =>
        jsonResponse(200, {
            value: [
                {
                    subject: "Vendor sync",
                    start: { dateTime: "2026-07-27T15:00:00.0000000", timeZone: "UTC" },
                    end: { dateTime: "2026-07-27T15:30:00.0000000", timeZone: "UTC" },
                    location: { displayName: "Teams" },
                    organizer: { emailAddress: { name: "Catherine" } },
                    webLink: "https://outlook.office.com/x",
                },
            ],
        })
    );

    const result = await tool.handler(
        { startDateTime: "2026-07-27T00:00:00Z", endDateTime: "2026-07-28T00:00:00Z" },
        { graphToken: "tok123" }
    );

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].opts.headers.Authorization, "Bearer tok123");
    assert.match(calls[0].url, /^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/calendarView\?/);
    assert.match(calls[0].url, /startDateTime=2026-07-27T00%3A00%3A00\.000Z/);
    assert.match(calls[0].url, /\$orderby=start\/dateTime/);

    assert.strictEqual(result.eventCount, 1);
    assert.deepStrictEqual(result.events[0], {
        subject: "Vendor sync",
        start: "2026-07-27T15:00:00.0000000",
        end: "2026-07-27T15:30:00.0000000",
        timeZone: "UTC",
        location: "Teams",
        organizer: "Catherine",
        webLink: "https://outlook.office.com/x",
    });
});

test("defaults to now through +7 days when no range is given", async () => {
    const calls = mockFetch(() => jsonResponse(200, { value: [] }));
    const before = Date.now();
    const result = await tool.handler({}, { graphToken: "tok" });
    const range = result.range;
    const spanMs = new Date(range.end).getTime() - new Date(range.start).getTime();
    assert.ok(Math.abs(spanMs - 7 * 24 * 60 * 60 * 1000) < 1000);
    assert.ok(new Date(range.start).getTime() >= before - 1000);
    assert.strictEqual(calls.length, 1);
});

test("rejects an invalid date range without calling fetch", async () => {
    const calls = mockFetch(() => jsonResponse(200, { value: [] }));
    const result = await tool.handler({ startDateTime: "not-a-date" }, { graphToken: "tok" });
    assert.strictEqual(result.error, "validation_failed");
    assert.strictEqual(calls.length, 0);
});

test("a Graph error propagates with the HTTP status attached", async () => {
    mockFetch(() => jsonResponse(403, { error: { message: "Forbidden" } }));
    await assert.rejects(
        () => tool.handler({}, { graphToken: "tok" }),
        (err) => {
            assert.strictEqual(err.status, 403);
            return true;
        }
    );
});
