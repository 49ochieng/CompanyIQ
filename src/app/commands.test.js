const { test } = require("node:test");
const assert = require("node:assert");
const { parseCommand, buildCommandOutcome } = require("./commands");

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

    const signedOut = buildCommandOutcome({ command: "whoami", args: "" }, DEPS);
    assert.match(signedOut.reply, /Not signed in/);
    assert.ok(!signedOut.reply.includes("searchEmail, findPeople"));
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
