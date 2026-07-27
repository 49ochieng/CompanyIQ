const { test } = require("node:test");
const assert = require("node:assert");
const { attributionFooter, sourceLabelFor } = require("./responseFormatter");

test("maps static and dynamic tool names to human labels", () => {
    assert.strictEqual(sourceLabelFor("queryCompanyData"), "Company database");
    assert.strictEqual(sourceLabelFor("webSearch"), "Public web");
    assert.strictEqual(sourceLabelFor("ask_fabric_healthcare"), "Fabric data agent: healthcare");
    assert.strictEqual(sourceLabelFor("ask_agent_compliance"), "Agent: compliance");
    assert.strictEqual(sourceLabelFor("mcp_billing_lookup"), "External service: billing");
});

test("footer lists only successful sources, de-duplicated, in first-seen order", () => {
    const footer = attributionFooter([
        { tool: "queryCompanyData", ok: true },
        { tool: "webSearch", ok: true },
        { tool: "queryCompanyData", ok: true }, // duplicate collapses
        { tool: "searchEmail", ok: false }, // failed → excluded
    ]);
    assert.strictEqual(footer, "_Sources this turn: Company database, Public web._");
});

test("no successful tool calls yields no footer", () => {
    assert.strictEqual(attributionFooter([]), "");
    assert.strictEqual(attributionFooter([{ tool: "queryCompanyData", ok: false }]), "");
});
