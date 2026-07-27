const { test } = require("node:test");
const assert = require("node:assert");
const { assertUserScoped } = require("./validate");

test("an explicit boolean is accepted and returned", () => {
    assert.strictEqual(assertUserScoped({ name: "a", userScoped: true }, "Foundry agent"), true);
    assert.strictEqual(assertUserScoped({ name: "b", userScoped: false }, "MCP server"), false);
});

test("a missing userScoped fails fast with an actionable message", () => {
    assert.throws(
        () => assertUserScoped({ name: "ghost" }, "Foundry agent"),
        /Foundry agent 'ghost' must declare "userScoped"/
    );
});

test("a non-boolean userScoped is rejected (no truthy coercion)", () => {
    for (const bad of ["true", 1, 0, null, "yes", {}]) {
        assert.throws(() => assertUserScoped({ name: "x", userScoped: bad }, "HTTP agent"), /must declare "userScoped"/);
    }
});
