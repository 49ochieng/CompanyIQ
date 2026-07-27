const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Isolate the file store per run.
const TMP = path.join(os.tmpdir(), `ciq-subs-${process.pid}.json`);
process.env.SUBSCRIPTIONS_PATH = TMP;

const subscriptions = require("./subscriptions");
const digest = require("./digest");
const orchestrator = require("../orchestrator/orchestrator");
const { parseCommand, buildCommandOutcome } = require("../app/commands");

const USER = { aadObjectId: "oid-1", upn: "jane@armely.com" };
const SUB = {
    id: "sub-1",
    userObjectId: USER.aadObjectId,
    teamsUserId: "29:jane",
    channelId: "msteams",
    conversationId: "conv-1",
    schedule: "daily",
    question: "how many items do I carry?",
};

const originalRunTurn = orchestrator.runTurn;
beforeEach(() => {
    try { fs.unlinkSync(TMP); } catch {}
});
afterEach(() => {
    orchestrator.runTurn = originalRunTurn;
    try { fs.unlinkSync(TMP); } catch {}
});

test("subscriptions round-trip through the file store, per user", () => {
    const a = subscriptions.add({ ...SUB, id: undefined });
    subscriptions.add({ ...SUB, id: undefined, userObjectId: "oid-2" });
    assert.strictEqual(subscriptions.listForUser("oid-1").length, 1);
    assert.strictEqual(subscriptions.listForUser("oid-2").length, 1);
    assert.ok(a.id);

    assert.strictEqual(subscriptions.removeAllForUser("oid-1"), 1);
    assert.strictEqual(subscriptions.listForUser("oid-1").length, 0);
    // Another user's subscription is untouched.
    assert.strictEqual(subscriptions.listForUser("oid-2").length, 1);
});

// ---------------------------------------------------------------------------
// THE hard rule: a scheduled digest is strictly read-only.
// ---------------------------------------------------------------------------
test("HARD RULE: a digest run registers NO actions (actionsEnabled is false)", async () => {
    let captured;
    // Intercept the orchestrator to observe exactly how the digest calls it.
    const digestModule = require("./digest");
    const originalModuleRunTurn = require("../orchestrator/orchestrator").runTurn;
    require("../orchestrator/orchestrator").runTurn = async (opts) => {
        captured = opts;
        return { content: "26 items.", toolCalls: [], toolResults: {}, proposals: [], directActions: [] };
    };

    const sent = [];
    try {
        // Re-require digest so it picks up the patched orchestrator.
        delete require.cache[require.resolve("./digest")];
        const d = require("./digest");
        const r = await d.runDigest(SUB, {
            app: { send: async (_c, a) => sent.push(a) },
            getUserToken: async () => "USER-TOKEN",
        });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(captured.actionsEnabled, false, "digests must never enable actions");
        assert.deepStrictEqual(captured.messages, [], "digests are stateless");
        assert.strictEqual(captured.text, SUB.question);
        assert.strictEqual(sent.length, 1, "the digest is delivered proactively");
    } finally {
        require("../orchestrator/orchestrator").runTurn = originalModuleRunTurn;
        delete require.cache[require.resolve("./digest")];
    }
});

test("a missing/expired token asks the user to sign in again, and runs nothing", async () => {
    let ranTurn = false;
    const originalModuleRunTurn = require("../orchestrator/orchestrator").runTurn;
    require("../orchestrator/orchestrator").runTurn = async () => { ranTurn = true; return {}; };

    const sent = [];
    try {
        delete require.cache[require.resolve("./digest")];
        const d = require("./digest");
        const r = await d.runDigest(SUB, {
            app: { send: async (_c, a) => sent.push(a) },
            getUserToken: async () => undefined, // expired
        });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, "token_missing");
        assert.strictEqual(ranTurn, false, "must not run the question without the user's token");
        assert.match(String(sent[0]), /sign in/i);
    } finally {
        require("../orchestrator/orchestrator").runTurn = originalModuleRunTurn;
        delete require.cache[require.resolve("./digest")];
    }
});

test("only known schedules are accepted, and they map to cron expressions", () => {
    assert.strictEqual(digest.isValidSchedule("daily"), true);
    assert.strictEqual(digest.isValidSchedule("hourly"), true);
    assert.strictEqual(digest.isValidSchedule("weekly"), true); // Part C: proactive Monday brief
    assert.strictEqual(digest.cronFor("weekly"), "0 8 * * 1");
    assert.strictEqual(digest.isValidSchedule("nonsense"), false);
    assert.strictEqual(digest.cronFor("daily"), "0 8 * * *");
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
const DEPS = {
    userContext: { user: USER },
    connectorStatus: () => [],
    toolNames: ["queryCompanyData"],
};

test("/subscribe parses the schedule and question, and requires sign-in", () => {
    const parsed = parseCommand("/subscribe daily how many items do I carry?");
    const outcome = buildCommandOutcome(parsed, DEPS);
    assert.strictEqual(outcome.action, "subscribe");
    assert.strictEqual(outcome.schedule, "daily");
    assert.strictEqual(outcome.question, "how many items do I carry?");

    const signedOut = buildCommandOutcome(parsed, { ...DEPS, userContext: {} });
    assert.match(signedOut.reply, /sign in/i);
    assert.strictEqual(signedOut.action, undefined);

    const malformed = buildCommandOutcome(parseCommand("/subscribe"), DEPS);
    assert.match(malformed.reply, /Usage/);
});

test("/unsubscribe returns the unsubscribe action", () => {
    const outcome = buildCommandOutcome(parseCommand("/unsubscribe"), DEPS);
    assert.strictEqual(outcome.action, "unsubscribe");
});
