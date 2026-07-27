const { test } = require("node:test");
const assert = require("node:assert");
const { formatResponse } = require("./responseFormatter");

test("web results render in a separated labeled section with source URLs", () => {
    const activity = formatResponse({
        content: "Internal answer first.",
        toolCalls: [],
        toolResults: {
            webSearch: {
                results: [
                    { url: "https://armely.com/about", title: "About Armely", snippet: "We build things." },
                ],
                resultCount: 1,
                external: true,
            },
        },
    });
    assert.match(activity.text, /^Internal answer first\./);
    assert.match(activity.text, /---/);
    assert.match(activity.text, /External information \(public web/);
    assert.match(activity.text, /https:\/\/armely\.com\/about/);
});

test("no web section when webSearch returned nothing", () => {
    const activity = formatResponse({
        content: "Answer.",
        toolCalls: [],
        toolResults: { webSearch: { results: [], resultCount: 0 } },
    });
    assert.strictEqual(activity.text, "Answer.");
});

test("a non-user-scoped external result is labeled as possibly beyond the user's access", () => {
    const activity = formatResponse({
        content: "Here is what the assistant found.",
        toolCalls: [{ tool: "ask_agent_work", ok: true }],
        toolResults: {
            ask_agent_work: {
                external: true,
                source: "agent:work",
                raw: "Some SharePoint content.",
                userScoped: false,
            },
        },
    });
    assert.match(activity.text, /may include information beyond your own access/i);
});

test("a user-scoped external result carries NO access-warning label", () => {
    const activity = formatResponse({
        content: "Answer.",
        toolCalls: [{ tool: "ask_fabric_healthcare", ok: true }],
        toolResults: {
            ask_fabric_healthcare: {
                external: true,
                source: "fabric:healthcare",
                raw: "Rows you are entitled to see.",
                userScoped: true,
            },
        },
    });
    assert.doesNotMatch(activity.text, /beyond your own access/i);
});

test("external result citations render as source links", () => {
    const activity = formatResponse({
        content: "Per the agent:",
        toolCalls: [{ tool: "ask_agent_work", ok: true }],
        toolResults: {
            ask_agent_work: {
                external: true,
                source: "agent:work",
                raw: "Dallas County announced X.",
                userScoped: false,
                citations: [{ title: "Press release, July 6 2026", url: "https://www.dallascounty.org/x.pdf" }],
            },
        },
    });
    assert.match(activity.text, /Sources:/);
    assert.match(activity.text, /https:\/\/www\.dallascounty\.org\/x\.pdf/);
});

test("data rows still render as an adaptive card table", () => {
    const activity = formatResponse({
        content: "Rows below.",
        toolCalls: [],
        toolResults: {
            queryCompanyData: { rowCount: 1, rows: [{ Item: "X", Brand: "B", UPC: "1", Supplier: "S", COO: "US", "Mtl<>USA": "N", "Ingredients Statement": "i" }] },
        },
    });
    const card = activity.attachments?.[0];
    assert.strictEqual(card?.contentType, "application/vnd.microsoft.card.adaptive");
});
