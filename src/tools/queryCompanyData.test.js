const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const db = require("../data/db");
const config = require("../config");
const tool = require("./queryCompanyData");

// Mock pool: records every executed statement and its bound inputs.
function makeFakePool(recordsets) {
    const executed = [];
    let call = 0;
    return {
        executed,
        request() {
            const inputs = {};
            const req = {
                input(name, _type, value) {
                    inputs[name] = value;
                    return req;
                },
                async query(statement) {
                    executed.push({ statement, inputs: { ...inputs } });
                    return { recordset: recordsets[Math.min(call++, recordsets.length - 1)] };
                },
            };
            return req;
        },
    };
}

const originalGetPool = db.getPool;
const originalIsWarm = db.isWarm;
const originalScope = config.devUserScope;

beforeEach(() => {
    config.devUserScope = "RETAILER_TEST";
    db.isWarm = () => true;
});

afterEach(() => {
    db.getPool = originalGetPool;
    db.isWarm = originalIsWarm;
    config.devUserScope = originalScope;
});

const UC01 = {
    table: "items",
    joins: ["suppliers"],
    filters: [
        { column: "ingredients_statement", operator: "contains", value: "soy protein" },
        { column: "country_of_origin", operator: "eq", value: "China" },
    ],
};

test("binds the scope on every executed query", async () => {
    const pool = makeFakePool([[{ Item: "X" }]]);
    db.getPool = async () => pool;

    const result = await tool.handler(UC01, { conversationId: "c1" });
    assert.strictEqual(result.rowCount, 1);
    assert.strictEqual(pool.executed[0].inputs.userScope, "RETAILER_TEST");
    assert.match(pool.executed[0].statement, /ri\.retailer_id = @userScope/);
});

test("context userScope overrides the dev scope", async () => {
    const pool = makeFakePool([[{ Item: "X" }]]);
    db.getPool = async () => pool;
    await tool.handler(UC01, { userScope: "RETAILER_FROM_SSO" });
    assert.strictEqual(pool.executed[0].inputs.userScope, "RETAILER_FROM_SSO");
});

test("signed-in but unmapped user gets no_data_scope, never the dev scope", async () => {
    let touched = false;
    db.getPool = async () => { touched = true; throw new Error("must not connect"); };
    const result = await tool.handler(UC01, { user: { upn: "stranger@armely.com" } });
    assert.strictEqual(result.error, "no_data_scope");
    assert.strictEqual(touched, false);
});

test("an invalid query is rejected without touching the database", async () => {
    let touched = false;
    db.getPool = async () => { touched = true; throw new Error("must not connect"); };

    const bad = await tool.handler({ table: "audit_logs" }, {});
    assert.strictEqual(bad.error, "invalid_query");
    assert.match(bad.reason, /unknown table/);
    assert.strictEqual(touched, false);

    const badCol = await tool.handler({ table: "items", select: ["password"] }, {});
    assert.strictEqual(badCol.error, "invalid_query");
    assert.strictEqual(touched, false);
});

test("the model cannot reach another retailer's rows by filtering the scope column", async () => {
    let touched = false;
    db.getPool = async () => { touched = true; throw new Error("must not connect"); };
    const attempt = await tool.handler(
        {
            table: "items",
            filters: [{ column: "retailer_id", operator: "eq", value: "RETAILER_200" }],
        },
        { userScope: "RETAILER_100" }
    );
    assert.strictEqual(attempt.error, "invalid_query");
    assert.strictEqual(touched, false);
});

test("zero rows returns an explicit do-not-invent instruction", async () => {
    const pool = makeFakePool([[]]);
    db.getPool = async () => pool;
    const result = await tool.handler(UC01, {});
    assert.strictEqual(result.rowCount, 0);
    assert.match(result.note, /never fill in an answer from your own knowledge/i);
});

test("results are capped at the row cap with a note", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ Item: `Item ${i}` }));
    const pool = makeFakePool([rows]);
    db.getPool = async () => pool;
    const result = await tool.handler({ table: "items" }, {});
    assert.strictEqual(result.rowCount, 50);
    assert.match(result.note, /first 50 rows/i);
    assert.strictEqual(pool.executed[0].inputs.rowLimit, 51);
});

test("a database failure returns one clean sentence, never driver text", async () => {
    db.getPool = async () => {
        const err = new Error("Failed to connect to armely.database.windows.net:1433 (sequence)");
        err.code = "ETIMEOUT";
        throw err;
    };
    const result = await tool.handler(UC01, {});
    assert.strictEqual(result.error, "database_unavailable");
    assert.ok(!/ETIMEOUT|1433|windows\.net|sequence/i.test(result.message));
});

test("a cold database notifies the user before waiting", async () => {
    const pool = makeFakePool([[{ Item: "X" }]]);
    db.isWarm = () => false;
    db.getPool = async () => pool;
    const notices = [];
    await tool.handler(UC01, { notify: async (m) => notices.push(m) });
    assert.match(notices[0], /Waking the database/i);
});

// ---------------------------------------------------------------------------
// The regression that motivated Phase 9: a stateless tool must not carry
// filters between calls, and an unfiltered follow-up query must be unfiltered.
// ---------------------------------------------------------------------------
test("STALE PARAMETERS: a plain supplier list executes with no leftover filters", async () => {
    const pool = makeFakePool([[{ Item: "X" }], [{ Supplier: "Fletcher Inc." }]]);
    db.getPool = async () => pool;

    // Turn 1: the UC-01 soy/China question.
    await tool.handler(UC01, { conversationId: "c1", userText: "soy protein products from China" });

    // Turn 2: an unrelated question — the tool is called with a fresh query.
    await tool.handler(
        { table: "suppliers", select: ["supplier_name"] },
        { conversationId: "c1", userText: "list all suppliers" }
    );

    const second = pool.executed[1];
    const boundValues = JSON.stringify(second.inputs).toLowerCase();
    assert.ok(!boundValues.includes("soy"), "soy leaked into the supplier query");
    assert.ok(!boundValues.includes("china"), "China leaked into the supplier query");
    // Only the scope + row cap are bound; no filter parameters at all.
    assert.deepStrictEqual(Object.keys(second.inputs).sort(), ["rowLimit", "userScope"]);
    assert.match(second.statement, /ri\.retailer_id = @userScope/);
});

test("carried-over filter values are flagged in the audit line", async () => {
    const pool = makeFakePool([[{ Supplier: "X" }]]);
    db.getPool = async () => pool;
    const logs = [];
    const originalLog = console.log;
    console.log = (line) => logs.push(line);
    try {
        await tool.handler(
            {
                table: "items",
                filters: [{ column: "ingredients_statement", operator: "contains", value: "soy protein" }],
            },
            { conversationId: "c1", userText: "list all suppliers" } // never mentions soy
        );
    } finally {
        console.log = originalLog;
    }
    const audit = JSON.parse(logs.find((l) => l.includes('"db_query"')));
    assert.ok(audit.carriedFilters, "stale filter should be flagged for audit");
    assert.strictEqual(audit.carriedFilters[0].value, "soy protein");
    assert.ok(audit.sql.includes("@userScope"));
});
