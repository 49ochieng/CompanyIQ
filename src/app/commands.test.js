const { test } = require("node:test");
const assert = require("node:assert");
const { parseCommand, buildCommandOutcome, isSignInMessage } = require("./commands");
const { buildInstructions, AF1_MESSAGE } = require("../orchestrator/orchestrator");

const DEPS = {
    userContext: {},
    connectorStatus: () => [],
    toolNames: ["queryCompanyData", "searchDocuments", "searchEmail", "findPeople", "getCalendar"],
};

test("plain messages are not commands", () => {
    assert.strictEqual(parseCommand("list my products"), null);
    assert.strictEqual(parseCommand("what about /data though"), null);
    assert.strictEqual(parseCommand(""), null);
});

test("commands parse with case-insensitive name and args", () => {
    assert.deepStrictEqual(parseCommand("/HELP"), { command: "help", args: "" });
    assert.deepStrictEqual(parseCommand("/data list soy products"), {
        command: "data",
        args: "list soy products",
    });
});

test("unknown command returns help text, not AF-1", () => {
    const outcome = buildCommandOutcome({ command: "frobnicate", args: "" }, DEPS);
    assert.ok(outcome.reply);
    assert.match(outcome.reply, /Unknown command/);
    assert.match(outcome.reply, /\/data/);
    assert.strictEqual(outcome.turn, undefined);
});

test("/data routes a restricted turn to queryCompanyData only", () => {
    const outcome = buildCommandOutcome(
        { command: "data", args: "list products with soy protein from China" },
        DEPS
    );
    assert.deepStrictEqual(outcome.turn, {
        text: "list products with soy protein from China",
        allowedTools: ["queryCompanyData"],
    });
});

test("/data without args explains usage", () => {
    const outcome = buildCommandOutcome({ command: "data", args: "" }, DEPS);
    assert.match(outcome.reply, /Usage/);
});

test("/web is refused while the flag is off", () => {
    const outcome = buildCommandOutcome({ command: "web", args: "armely news" }, DEPS);
    assert.match(outcome.reply, /disabled/);
});

test("/whoami reports identity, scope, and gated tools", () => {
    const outcome = buildCommandOutcome(
        { command: "whoami", args: "" },
        {
            ...DEPS,
            userContext: {
                user: { upn: "jane@armely.com", name: "Jane" },
                userScope: "RETAILER_100",
                graphToken: "tok",
            },
        }
    );
    assert.match(outcome.reply, /jane@armely\.com/);
    assert.match(outcome.reply, /RETAILER_100/);
    assert.match(outcome.reply, /searchEmail/);
    assert.match(outcome.reply, /Scope map:.*\(you matched\)/);

    const signedOut = buildCommandOutcome({ command: "whoami", args: "" }, DEPS);
    assert.match(signedOut.reply, /Not signed in/);
    assert.match(signedOut.reply, /Scope map:/);
    assert.ok(!signedOut.reply.includes("searchEmail, findPeople"));
});

test("/whoami flags a signed-in user the scope map failed to match", () => {
    const config = require("../config");
    const original = config.userScopeMap;
    config.userScopeMap = JSON.stringify({ "other@armely.com": "RETAILER_200" });
    try {
        const outcome = buildCommandOutcome(
            { command: "whoami", args: "" },
            { ...DEPS, userContext: { user: { upn: "jane@armely.com" }, graphToken: "tok" } }
        );
        assert.match(outcome.reply, /none assigned/);
        assert.match(outcome.reply, /1 entry loaded — none matched/);
    } finally {
        config.userScopeMap = original;
    }
});

test("plain 'sign in'/'login' messages are detected as sign-in requests", () => {
    for (const yes of ["sign in", "Sign In", "SIGNIN", "log in", "login", "  sign in!  ", "sign-in"]) {
        assert.strictEqual(isSignInMessage(yes), true, `should match: ${yes}`);
    }
    for (const no of ["sign in to sharepoint please", "what is a login", "design", "", null]) {
        assert.strictEqual(isSignInMessage(no), false, `should not match: ${no}`);
    }
});

test("/signin and /signout return actions for the app to execute", () => {
    assert.deepStrictEqual(buildCommandOutcome({ command: "signin", args: "" }, DEPS), { action: "signin" });
    assert.deepStrictEqual(buildCommandOutcome({ command: "signout", args: "" }, DEPS), { action: "signout" });
});

test("turn instructions carry the signed-in identity for name questions", () => {
    const signedIn = buildInstructions({
        user: { name: "Edgar O.", upn: "edgar.mcochieng@armely.com" },
        userScope: "RETAILER_100",
    });
    assert.match(signedIn, /Signed-in user: Edgar O\. <edgar\.mcochieng@armely\.com>/);
    assert.match(signedIn, /RETAILER_100/);

    const signedOut = buildInstructions({});
    assert.match(signedOut, /No user is signed in/);
    assert.match(signedOut, /type "sign in"/);
    // AF-1 text is still present as the narrow fallback, not removed
    assert.ok(signedOut.includes(AF1_MESSAGE));
});

test("/trace routes to the trace action", () => {
    assert.deepStrictEqual(buildCommandOutcome({ command: "trace", args: "" }, DEPS), { action: "trace" });
});

test("/agents lists connector circuit status", () => {
    const outcome = buildCommandOutcome(
        { command: "agents", args: "" },
        {
            ...DEPS,
            connectorStatus: () => [
                { name: "test", kind: "foundry", state: "closed", consecutiveFailures: 0 },
                { name: "kb", kind: "mcp", state: "open", consecutiveFailures: 3 },
            ],
        }
    );
    assert.match(outcome.reply, /test.*available/);
    assert.match(outcome.reply, /kb.*unavailable/);
});
