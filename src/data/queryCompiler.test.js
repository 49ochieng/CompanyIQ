const { test } = require("node:test");
const assert = require("node:assert");
const { compile } = require("./queryCompiler");
const catalog = require("./catalog");

const SCOPE_RE = /WHERE\s+ri\.retailer_id = @userScope/;

// ---------------------------------------------------------------------------
// THE security invariant: no compiled statement may ever lack the scope
// predicate — not for plain selects, joins, aggregates, or grouped queries.
// ---------------------------------------------------------------------------
test("EVERY compiled statement carries the scope predicate", () => {
    const queries = [
        { table: "items" },
        { table: "items", select: ["item_name", "brand"] },
        { table: "items", joins: ["suppliers"], select: ["item_name", "supplier_name"] },
        { table: "suppliers" },
        { table: "suppliers", joins: ["items"], select: ["supplier_name", "item_name"] },
        { table: "items", filters: [{ column: "country_of_origin", operator: "eq", value: "China" }] },
        { table: "items", aggregations: [{ fn: "count", column: "*" }] },
        { table: "items", groupBy: ["country_of_origin"], aggregations: [{ fn: "count", column: "*" }] },
        { table: "suppliers", joins: ["items"], groupBy: ["supplier_name"], aggregations: [{ fn: "count", column: "*" }] },
        { table: "items", orderBy: { column: "item_name", direction: "desc" }, limit: 5 },
    ];
    for (const q of queries) {
        const c = compile(q);
        assert.strictEqual(c.ok, true, `should compile: ${JSON.stringify(q)} → ${c.reason}`);
        assert.match(c.statement, SCOPE_RE, `MISSING SCOPE: ${JSON.stringify(q)}\n${c.statement}`);
        assert.match(c.statement, /JOIN sbs_test\.retailer_items AS ri/, `scope table not joined: ${JSON.stringify(q)}`);
    }
});

test("scope predicate leads the WHERE clause even with filters", () => {
    const c = compile({
        table: "items",
        filters: [
            { column: "ingredients_statement", operator: "contains", value: "soy protein" },
            { column: "country_of_origin", operator: "eq", value: "China" },
        ],
    });
    assert.match(c.statement, /WHERE ri\.retailer_id = @userScope AND \(/);
});

test("every value is a bound parameter — no literals in the statement", () => {
    const c = compile({
        table: "items",
        filters: [{ column: "ingredients_statement", operator: "contains", value: "soy protein" }],
    });
    assert.ok(!c.statement.includes("soy protein"), "value leaked into SQL text");
    assert.deepStrictEqual(c.inputs.map((i) => i.value), ["soy protein"]);
});

// ---------------------------------------------------------------------------
// Allowlist enforcement
// ---------------------------------------------------------------------------
test("unknown table, column, operator, join, aggregation are all rejected", () => {
    assert.match(compile({ table: "dbo.users" }).reason, /unknown table/);
    assert.match(compile({ table: "audit_logs" }).reason, /unknown table/);
    assert.match(compile({ table: "items", select: ["password"] }).reason, /unknown column/);
    assert.match(
        compile({ table: "items", filters: [{ column: "brand", operator: "regex", value: "x" }] }).reason,
        /unknown operator/
    );
    assert.match(compile({ table: "items", joins: ["sessions"] }).reason, /unknown join target/);
    assert.match(
        compile({ table: "items", aggregations: [{ fn: "median", column: "item_id" }] }).reason,
        /unknown aggregation/
    );
});

test("the scope column itself is not addressable by the model", () => {
    // retailer_items is not an exposed table; its column cannot be selected or
    // filtered — the model can never widen or change its own scope.
    assert.match(compile({ table: "retailer_items" }).reason, /unknown table/);
    assert.match(compile({ table: "items", select: ["retailer_id"] }).reason, /unknown column/);
    assert.match(
        compile({ table: "items", filters: [{ column: "retailer_id", operator: "eq", value: "RETAILER_200" }] }).reason,
        /unknown column/
    );
});

test("capability flags are enforced (non-aggregatable, non-groupable)", () => {
    assert.match(
        compile({ table: "items", aggregations: [{ fn: "sum", column: "item_name" }] }).reason,
        /not aggregatable/
    );
    assert.match(
        compile({ table: "items", groupBy: ["ingredients_statement"], aggregations: [{ fn: "count", column: "*" }] }).reason,
        /not groupable/
    );
});

// ---------------------------------------------------------------------------
// Injection resistance
// ---------------------------------------------------------------------------
test("SQL metacharacters in values stay inert (parameterized, LIKE-escaped)", () => {
    const evil = "'; DROP TABLE sbs_test.items;--";
    const c = compile({
        table: "items",
        filters: [{ column: "brand", operator: "eq", value: evil }],
    });
    assert.strictEqual(c.ok, true);
    assert.ok(!c.statement.includes("DROP"), "value must never reach the SQL text");
    assert.strictEqual(c.inputs[0].value, evil); // bound, inert

    // LIKE wildcards cannot broaden a contains match.
    const wild = compile({
        table: "items",
        filters: [{ column: "ingredients_statement", operator: "contains", value: "%" }],
    });
    assert.strictEqual(wild.inputs[0].value, "\\%");
});

test("column names are never taken from model text — only catalog lookups", () => {
    const c = compile({ table: "items", select: ["item_name; DROP TABLE x"] });
    assert.strictEqual(c.ok, false);
    assert.match(c.reason, /unknown column/);
});

// ---------------------------------------------------------------------------
// Correctness of the shapes the demo needs
// ---------------------------------------------------------------------------
test("UC-01 query compiles to the expected shape", () => {
    const c = compile({
        table: "items",
        joins: ["suppliers"],
        select: ["item_name", "brand", "upc", "supplier_name", "country_of_origin", "mtl_neq_usa", "ingredients_statement"],
        filters: [
            { column: "ingredients_statement", operator: "contains", value: "soy protein" },
            { column: "country_of_origin", operator: "eq", value: "China" },
        ],
    });
    assert.strictEqual(c.ok, true);
    assert.match(c.statement, /JOIN sbs_test\.suppliers AS s/);
    assert.match(c.statement, SCOPE_RE);
    assert.deepStrictEqual(c.outputColumns, [
        "Item", "Brand", "UPC", "Supplier", "COO", "Mtl<>USA", "Ingredients Statement",
    ]);
});

test("aggregate breakdown compiles with GROUP BY and a count", () => {
    const c = compile({
        table: "items",
        groupBy: ["country_of_origin"],
        aggregations: [{ fn: "count", column: "*" }],
        orderBy: { column: "Count", direction: "desc" },
    });
    assert.strictEqual(c.ok, true);
    assert.match(c.statement, /GROUP BY i\.country_of_origin/);
    assert.match(c.statement, /COUNT\(\*\) AS \[Count\]/);
    assert.match(c.statement, /ORDER BY \[Count\] DESC/);
    assert.match(c.statement, SCOPE_RE);
});

test("joined row queries are DISTINCT so scope joins can't duplicate rows", () => {
    const c = compile({ table: "suppliers", joins: ["items"], select: ["supplier_name"] });
    assert.match(c.statement, /SELECT DISTINCT/);
});

test("limit is capped at the row cap", () => {
    assert.strictEqual(compile({ table: "items", limit: 5000 }).limit, catalog.MAX_ROWS);
    assert.strictEqual(compile({ table: "items", limit: 5 }).limit, 5);
    assert.match(compile({ table: "items", limit: 0 }).reason, /positive/);
});

test("in / between operators bind every value", () => {
    const c = compile({
        table: "items",
        filters: [{ column: "country_of_origin", operator: "in", value: ["China", "Mexico", "Thailand"] }],
    });
    assert.strictEqual(c.inputs.length, 3);
    assert.match(c.statement, /IN \(@p0, @p1, @p2\)/);

    const b = compile({
        table: "items",
        filters: [{ column: "item_id", operator: "between", value: [1, 10] }],
    });
    assert.match(b.statement, /BETWEEN @p0 AND @p1/);
    assert.deepStrictEqual(b.inputs.map((i) => i.value), [1, 10]);
});
