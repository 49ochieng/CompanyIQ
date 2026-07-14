const { test } = require("node:test");
const assert = require("node:assert");
const config = require("../../config");
const sources = require("./index");
const { compile, assertScopePolicy } = require("../queryCompiler");
const azureSqlCatalog = require("../catalogs/azureSql");
const fabricCatalog = require("../catalogs/fabricLakehouse");
const tool = require("../../tools/queryCompanyData");
const { formatResponse } = require("../../formatting/responseFormatter");

// ---------------------------------------------------------------------------
// Scope policy is mandatory — a source with none fails at STARTUP.
// ---------------------------------------------------------------------------
test("a catalog with no declared scope policy fails loudly", () => {
    assert.throws(
        () => assertScopePolicy({ name: "rogue", TABLES: {}, JOINS: {} }),
        /does not declare a scope policy/
    );
    assert.throws(
        () => assertScopePolicy({ name: "rogue", scope: { policy: "whatever" } }),
        /does not declare a scope policy/
    );
    // row_predicate without the scope table is also a config error.
    assert.throws(
        () => assertScopePolicy({ name: "rogue", scope: { policy: "row_predicate" } }),
        /missing the scope table/
    );
});

test("a source missing a required field or an unknown identity is rejected", () => {
    assert.throws(() => sources.validateSource({ name: "x", kind: "k", identity: "app" }), /missing 'label'/);
    assert.throws(
        () => sources.validateSource({
            name: "x", kind: "k", identity: "root", label: "L", catalog: azureSqlCatalog,
            probe() {}, describeSchema() {}, compile() {}, execute() {}, isConfigured() {},
        }),
        /must declare identity/
    );
});

test("both shipped catalogs declare an explicit scope policy", () => {
    assert.strictEqual(azureSqlCatalog.scope.policy, "row_predicate");
    assert.strictEqual(fabricCatalog.scope.policy, "enforced_by_source");
});

// ---------------------------------------------------------------------------
// The Azure SQL invariant is untouched by multi-source work.
// ---------------------------------------------------------------------------
test("azure_sql STILL carries the scope predicate on every compiled statement", () => {
    const queries = [
        { table: "items" },
        { table: "items", joins: ["suppliers"] },
        { table: "items", groupBy: ["country_of_origin"], aggregations: [{ fn: "count", column: "*" }] },
        { table: "suppliers", joins: ["items"] },
    ];
    for (const q of queries) {
        const c = compile(q, azureSqlCatalog);
        assert.strictEqual(c.ok, true, c.reason);
        assert.match(c.statement, /WHERE ri\.retailer_id = @userScope/);
    }
});

// ---------------------------------------------------------------------------
// Fabric: no bogus scope predicate, but soft-deletes are always filtered.
// ---------------------------------------------------------------------------
test("fabric compiles WITHOUT a scope predicate (the engine enforces the user)", () => {
    const c = compile({ table: "patients" }, fabricCatalog);
    assert.strictEqual(c.ok, true, c.reason);
    assert.strictEqual(c.scopePolicy, "enforced_by_source");
    assert.ok(!c.statement.includes("@userScope"), "fabric must not fake a scope parameter");
});

test("fabric row filters (soft deletes) are applied unconditionally", () => {
    const c = compile({ table: "patients", joins: ["encounters"] }, fabricCatalog);
    assert.match(c.statement, /p\.delFlag = 0/);
    assert.match(c.statement, /e\.delFlag = 0/);
    // The model cannot address delFlag at all.
    assert.match(compile({ table: "patients", select: ["delFlag"] }, fabricCatalog).reason, /unknown column/);
    assert.match(
        compile({ table: "patients", filters: [{ column: "delFlag", operator: "eq", value: 1 }] }, fabricCatalog).reason,
        /unknown column/
    );
});

test("fabric values are bound parameters, never inlined", () => {
    const c = compile(
        { table: "patients", filters: [{ column: "City", operator: "eq", value: "'; DROP TABLE x;--" }] },
        fabricCatalog
    );
    assert.strictEqual(c.ok, true);
    assert.ok(!c.statement.includes("DROP"));
    assert.strictEqual(c.inputs[0].value, "'; DROP TABLE x;--");
});

// ---------------------------------------------------------------------------
// Cross-source queries are rejected before execution.
// ---------------------------------------------------------------------------
test("a single query may not span two sources", async () => {
    const originalServer = config.sqlServer;
    const originalDatabase = config.sqlDatabase;
    const originalEndpoint = config.fabricEndpoint;
    const originalFabricDb = config.fabricDatabase;
    config.sqlServer = "test.database.windows.net";
    config.sqlDatabase = "TestDb";
    config.fabricEndpoint = "test.datawarehouse.fabric.microsoft.com";
    config.fabricDatabase = "TestLake";
    try {
        // 'patients' lives in the Fabric source, not company_sql.
        const r = await tool.handler({ source: "company_sql", table: "items", joins: ["patients"] }, {});
        assert.strictEqual(r.error, "invalid_query");
        assert.match(r.reason, /different source|cannot span sources/i);

        // …and the reverse.
        const r2 = await tool.handler({ source: "healthcare_fabric", table: "patients", joins: ["items"] }, {});
        assert.strictEqual(r2.error, "invalid_query");
        assert.match(r2.reason, /different source|cannot span sources/i);
    } finally {
        config.sqlServer = originalServer;
        config.sqlDatabase = originalDatabase;
        config.fabricEndpoint = originalEndpoint;
        config.fabricDatabase = originalFabricDb;
    }
});

// ---------------------------------------------------------------------------
// The source label is produced by the FORMATTER and cannot be suppressed.
// ---------------------------------------------------------------------------
test("the source label comes from the formatter, not the model", () => {
    const activity = formatResponse({
        // The model claims the wrong thing; the card must not follow it.
        content: "Here is company data.",
        toolCalls: [],
        toolResults: {
            queryCompanyData: {
                source: "healthcare_fabric",
                sourceLabel: "Healthcare lakehouse (Microsoft Fabric)",
                sourceIdentity: "user",
                columns: ["First Name"],
                rowCount: 1,
                rows: [{ "First Name": "Ada" }],
            },
        },
    });
    const card = activity.attachments[0].content;
    assert.match(card.body[0].text, /Healthcare lakehouse \(Microsoft Fabric\) — 1 row/);
});

// ---------------------------------------------------------------------------
// Fabric credentials/tokens never leak.
// ---------------------------------------------------------------------------
test("no Fabric token or secret appears in a tool result, card, or audit log", async () => {
    const TOKEN = "eyJ-FABRIC-USER-TOKEN-SECRET";
    const originalEndpoint = config.fabricEndpoint;
    const originalFabricDb = config.fabricDatabase;
    config.fabricEndpoint = "test.datawarehouse.fabric.microsoft.com";
    config.fabricDatabase = "TestLake";

    const fabric = require("./fabricLakehouse");
    const originalExecute = fabric.execute;
    // Simulate a successful query without a real network call.
    fabric.execute = async function (compiled, context) {
        // Prove the token IS used for auth…
        const token = await this.getToken(context);
        assert.strictEqual(token, TOKEN);
        return { rows: [{ "First Name": "Ada" }] };
    };

    const logs = [];
    const originalLog = console.log;
    console.log = (l) => logs.push(l);
    let result;
    try {
        result = await tool.handler(
            { source: "healthcare_fabric", table: "patients", select: ["FirstName"] },
            { conversationId: "c1", getAudienceToken: async () => TOKEN }
        );
    } finally {
        console.log = originalLog;
        fabric.execute = originalExecute;
        config.fabricEndpoint = originalEndpoint;
        config.fabricDatabase = originalFabricDb;
    }

    // …but never surfaces anywhere the user or the model can see it.
    const resultJson = JSON.stringify(result);
    const logJson = logs.join("\n");
    const cardJson = JSON.stringify(
        formatResponse({ content: "x", toolCalls: [], toolResults: { queryCompanyData: result } })
    );
    for (const [where, text] of [["tool result", resultJson], ["audit log", logJson], ["card", cardJson]]) {
        assert.ok(!text.includes(TOKEN), `token leaked into the ${where}`);
        assert.ok(!text.includes("FABRIC-USER-TOKEN"), `token fragment leaked into the ${where}`);
    }
    // The audit line still records the source and the compiled SQL.
    assert.match(logJson, /"source":"healthcare_fabric"/);
    assert.match(logJson, /demo_ecw_patients/);
});

// ---------------------------------------------------------------------------
// Registry surface used by /sources and the prompt.
// ---------------------------------------------------------------------------
test("listAll reports identity mode, scope policy and table count per source", () => {
    const all = sources.listAll();
    const sqlSrc = all.find((s) => s.name === "company_sql");
    const fabricSrc = all.find((s) => s.name === "healthcare_fabric");
    assert.strictEqual(sqlSrc.scopePolicy, "row_predicate");
    assert.strictEqual(fabricSrc.identity, "user");
    assert.strictEqual(fabricSrc.scopePolicy, "enforced_by_source");
    assert.ok(fabricSrc.tableCount >= 7);
});

test("the prompt rendering names both sources and never blurs their scoping", () => {
    const originalServer = config.sqlServer;
    const originalEndpoint = config.fabricEndpoint;
    const originalFabricDb = config.fabricDatabase;
    config.sqlServer = "test.database.windows.net";
    config.sqlDatabase = config.sqlDatabase || "TestDb";
    config.fabricEndpoint = "test.datawarehouse.fabric.microsoft.com";
    config.fabricDatabase = "TestLake";
    try {
        const text = sources.describeAllForPrompt();
        assert.match(text, /SOURCE "company_sql"/);
        assert.match(text, /SOURCE "healthcare_fabric"/);
        assert.match(text, /restricted to the signed-in user's own assortment/);
        assert.match(text, /own permissions in Fabric/);
        // No connection details in the prompt.
        assert.ok(!text.includes("datawarehouse.fabric.microsoft.com"));
    } finally {
        config.sqlServer = originalServer;
        config.fabricEndpoint = originalEndpoint;
        config.fabricDatabase = originalFabricDb;
    }
});
