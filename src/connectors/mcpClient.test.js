const { test } = require("node:test");
const assert = require("node:assert");
const { buildToolDefinition, filterTools, parseServers, MAX_DESCRIPTION } = require("./mcpClient");

const SERVER = { name: "kb", url: "https://mcp.example.com/mcp" };

test("MCP tools register namespaced as mcp_<server>_<tool>", () => {
    const built = buildToolDefinition(SERVER, { name: "search", description: "Search KB" }, []);
    assert.strictEqual(built.ok, true);
    assert.strictEqual(built.tool.name, "mcp_kb_search");
    assert.match(built.tool.description, /External MCP tool from 'kb'/);
});

test("name collisions with built-ins or other namespaced tools are rejected", () => {
    const collision = buildToolDefinition(SERVER, { name: "search" }, ["mcp_kb_search", "queryCompanyData"]);
    assert.strictEqual(collision.ok, false);
    assert.match(collision.reason, /collision/);
});

test("invalid tool names are rejected", () => {
    for (const bad of ["", "has space", "a".repeat(65), "semi;colon", null]) {
        const built = buildToolDefinition(SERVER, { name: bad }, []);
        assert.strictEqual(built.ok, false, `should reject name: ${bad}`);
    }
});

test("descriptions are capped so a verbose server cannot flood the prompt", () => {
    const built = buildToolDefinition(SERVER, { name: "t", description: "x".repeat(5000) }, []);
    assert.strictEqual(built.ok, true);
    assert.ok(built.tool.description.length <= MAX_DESCRIPTION);
});

test("non-object input schemas are replaced with an empty object schema", () => {
    const built = buildToolDefinition(SERVER, { name: "t", inputSchema: "not a schema" }, []);
    assert.deepStrictEqual(built.tool.parameters, { type: "object", properties: {} });
});

test("allowedTools filters the discovered tool list", () => {
    const tools = [{ name: "a" }, { name: "b" }, { name: "c" }];
    assert.deepStrictEqual(filterTools(tools, ["b"]).map((t) => t.name), ["b"]);
    assert.strictEqual(filterTools(tools, []).length, 3);
    assert.strictEqual(filterTools(tools, undefined).length, 3);
});

test("malformed MCP_SERVERS config degrades to no servers", () => {
    assert.deepStrictEqual(parseServers("{not json"), []);
    assert.deepStrictEqual(parseServers(JSON.stringify([{ name: "bad name!", url: "x" }])), []);
    assert.strictEqual(parseServers(JSON.stringify([SERVER])).length, 1);
});
