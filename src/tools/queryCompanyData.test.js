const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const db = require("../data/db");
const config = require("../config");
const tool = require("./queryCompanyData");

// Mock pool: records every request's inputs and statement, returns queued recordsets.
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
const originalScope = config.devUserScope;

beforeEach(() => {
    config.devUserScope = "RETAILER_TEST";
});

afterEach(() => {
    db.getPool = originalGetPool;
    config.devUserScope = originalScope;
});

test("executes with the scope input bound on every query", async () => {
    const pool = makeFakePool([[{ Item: "X" }]]);
    db.getPool = async () => pool;

    const result = await tool.handler(
        { intent: "items_by_ingredient_and_coo", parameters: { ingredient: "soy protein", country_of_origin: "China" } },
        { conversationId: "c1" }
    );

    assert.strictEqual(result.rowCount, 1);
    assert.strictEqual(pool.executed.length, 1);
    assert.strictEqual(pool.executed[0].inputs.userScope, "RETAILER_TEST");
    assert.match(pool.executed[0].statement, /ri\.retailer_id = @userScope/);
});

test("context userScope overrides the dev scope", async () => {
    const pool = makeFakePool([[{ Item: "X" }]]);
    db.getPool = async () => pool;

    await tool.handler(
        { intent: "items_by_ingredient", parameters: { ingredient: "soy" } },
        { userScope: "RETAILER_FROM_SSO" }
    );
    assert.strictEqual(pool.executed[0].inputs.userScope, "RETAILER_FROM_SSO");
});

test("refuses to run without any scope", async () => {
    config.devUserScope = undefined;
    const pool = makeFakePool([[{ Item: "X" }]]);
    db.getPool = async () => pool;

    await assert.rejects(
        () => tool.handler({ intent: "items_by_ingredient", parameters: { ingredient: "soy" } }, {}),
        /scope/i
    );
    assert.strictEqual(pool.executed.length, 0);
});

test("returns structured validation error without touching the database", async () => {
    let poolTouched = false;
    db.getPool = async () => {
        poolTouched = true;
        throw new Error("should not connect");
    };

    const bad = await tool.handler(
        { intent: "items_by_ingredient", parameters: { ingredient: "soy'; DROP TABLE x;--" } },
        {}
    );
    assert.strictEqual(bad.error, "validation_failed");
    assert.strictEqual(poolTouched, false);

    const unknown = await tool.handler({ intent: "not_a_real_intent", parameters: {} }, {});
    assert.strictEqual(unknown.error, "validation_failed");
    assert.strictEqual(poolTouched, false);
});

test("broadens to word-level match on zero rows, still scoped", async () => {
    const pool = makeFakePool([[], [{ Item: "Broadened" }]]);
    db.getPool = async () => pool;

    const result = await tool.handler(
        { intent: "items_by_ingredient_and_coo", parameters: { ingredient: "soy lecithin", country_of_origin: "China" } },
        {}
    );

    assert.strictEqual(pool.executed.length, 2);
    assert.match(pool.executed[1].statement, /@word0/);
    assert.match(pool.executed[1].statement, /ri\.retailer_id = @userScope/);
    assert.strictEqual(pool.executed[1].inputs.word0, "soy");
    assert.strictEqual(pool.executed[1].inputs.word1, "lecithin");
    assert.strictEqual(pool.executed[1].inputs.userScope, "RETAILER_TEST");
    assert.strictEqual(result.broadened, true);
    assert.strictEqual(result.rowCount, 1);
});

test("caps results at 50 rows with a truncation note", async () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({ Item: `Item ${i}` }));
    const pool = makeFakePool([rows]);
    db.getPool = async () => pool;

    const result = await tool.handler(
        { intent: "items_by_ingredient", parameters: { ingredient: "soy" } },
        {}
    );
    assert.strictEqual(result.rowCount, 50);
    assert.strictEqual(result.rows.length, 50);
    assert.match(result.note, /truncated/i);
    // rowLimit asks for MAX+1 so truncation is detectable
    assert.strictEqual(pool.executed[0].inputs.rowLimit, 51);
});
