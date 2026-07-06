const { test } = require("node:test");
const assert = require("node:assert");
const { INTENTS, validateArgs, buildStatement, normalizeCountry } = require("./intents");

test("validateArgs accepts valid UC-01 parameters and normalizes country", () => {
    const result = validateArgs("items_by_ingredient_and_coo", {
        ingredient: "soy protein",
        country_of_origin: "CN",
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.params.ingredient, "soy protein");
    assert.strictEqual(result.params.country_of_origin, "China");
});

test("validateArgs rejects SQL metacharacters", () => {
    for (const evil of [
        "soy'; DROP TABLE sbs_test.items;--",
        "soy' OR '1'='1",
        "soy /* comment */",
        "soy%",
        "soy_protein",
        "[soy]",
        'soy"protein',
    ]) {
        const result = validateArgs("items_by_ingredient", { ingredient: evil });
        assert.strictEqual(result.ok, false, `should reject: ${evil}`);
    }
});

test("validateArgs rejects wrong types", () => {
    assert.strictEqual(validateArgs("items_by_ingredient", { ingredient: 42 }).ok, false);
    assert.strictEqual(validateArgs("items_by_ingredient", { ingredient: { a: 1 } }).ok, false);
    assert.strictEqual(validateArgs("items_by_ingredient", { ingredient: ["soy"] }).ok, false);
});

test("validateArgs enforces length caps", () => {
    const result = validateArgs("items_by_ingredient", { ingredient: "a".repeat(101) });
    assert.strictEqual(result.ok, false);
});

test("validateArgs rejects unknown intent", () => {
    const result = validateArgs("drop_all_tables", { ingredient: "soy" });
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, /unknown intent/);
});

test("validateArgs rejects missing required parameter", () => {
    const result = validateArgs("items_by_ingredient_and_coo", { ingredient: "soy" });
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, /country_of_origin/);
});

test("validateArgs rejects unknown parameter with a value, tolerates empty extras", () => {
    assert.strictEqual(
        validateArgs("items_by_ingredient", { ingredient: "soy", upc: "12345" }).ok,
        false
    );
    assert.strictEqual(
        validateArgs("items_by_ingredient", { ingredient: "soy", upc: "" }).ok,
        true
    );
});

test("scope predicate is present in every intent's generated statement", () => {
    for (const intentName of Object.keys(INTENTS)) {
        const statement = buildStatement(intentName);
        assert.match(
            statement,
            /WHERE ri\.retailer_id = @userScope AND/,
            `scope predicate missing for intent '${intentName}'`
        );
    }
});

test("scope predicate is present in broadened statements too", () => {
    const statement = buildStatement("items_by_ingredient_and_coo", { broadened: true, wordCount: 2 });
    assert.match(statement, /WHERE ri\.retailer_id = @userScope AND/);
    assert.match(statement, /@word0/);
    assert.match(statement, /@word1/);
    assert.match(statement, /@country_of_origin/);
});

test("buildStatement throws for unknown intent", () => {
    assert.throws(() => buildStatement("nope"));
});

test("normalizeCountry maps aliases and passes through unknowns", () => {
    assert.strictEqual(normalizeCountry("usa"), "United States of America");
    assert.strictEqual(normalizeCountry("China"), "China");
    assert.strictEqual(normalizeCountry("Portugal"), "Portugal");
});
