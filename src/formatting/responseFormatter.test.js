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
