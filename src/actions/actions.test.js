const { test, beforeEach } = require("node:test");
const assert = require("node:assert");
const store = require("./store");
const config = require("../config");
const { proposeAction, executeApproved, cancelApproved, executeDirect } = require("./runner");
const sendEmail = require("./sendEmail");

beforeEach(() => store._reset());

const USER_A = "oid-aaa";
const USER_B = "oid-bbb";
const VALID_EMAIL = { to: ["bob@armely.com"], subject: "Q soy products", body: "Here is the summary." };

test("sendEmail is always confirmation-required and validates recipients", () => {
    assert.strictEqual(sendEmail.requiresConfirmation, true);
    assert.strictEqual(sendEmail.validate({ ...VALID_EMAIL, to: ["not-an-email"] }).ok, false);
    assert.strictEqual(sendEmail.validate({ ...VALID_EMAIL, to: [] }).ok, false);
    assert.strictEqual(sendEmail.validate({ ...VALID_EMAIL, body: "" }).ok, false);
    assert.strictEqual(sendEmail.validate(VALID_EMAIL).ok, true);
});

test("proposal is bound to the proposing user — another user cannot execute it", async () => {
    const proposed = proposeAction("sendEmail", VALID_EMAIL, { userId: USER_A });
    assert.ok(proposed.proposalId);

    // User B clicks the card → rejected, proposal survives for the owner.
    const wrong = await executeApproved(proposed.proposalId, { userId: USER_B, context: {} });
    assert.strictEqual(wrong.error, "wrong_user");

    // A tries — reaches the handler (which needs a graph token; stub it).
    let sent = false;
    const original = sendEmail.handler;
    sendEmail.handler = async () => { sent = true; return { sent: true }; };
    try {
        const ok = await executeApproved(proposed.proposalId, { userId: USER_A, context: { graphToken: "t" } });
        assert.strictEqual(ok.ok, true);
        assert.strictEqual(sent, true);
    } finally {
        sendEmail.handler = original;
    }
});

test("a claimed proposal cannot be executed twice", async () => {
    const proposed = proposeAction("sendEmail", VALID_EMAIL, { userId: USER_A });
    const original = sendEmail.handler;
    sendEmail.handler = async () => ({ sent: true });
    try {
        await executeApproved(proposed.proposalId, { userId: USER_A, context: { graphToken: "t" } });
        const second = await executeApproved(proposed.proposalId, { userId: USER_A, context: { graphToken: "t" } });
        assert.strictEqual(second.error, "not_found");
    } finally {
        sendEmail.handler = original;
    }
});

test("expired proposals do not execute", async () => {
    const realNow = Date.now;
    const id = store.createProposal(USER_A, "sendEmail", VALID_EMAIL);
    try {
        // Jump past the TTL, then attempt to claim.
        Date.now = () => realNow() + store.PROPOSAL_TTL_MS + 1000;
        const claim = store.claimProposal(id, USER_A);
        assert.strictEqual(claim.ok, false);
        assert.strictEqual(claim.reason, "expired");
    } finally {
        Date.now = realNow;
    }
    // Unknown id is likewise a no-op.
    const missing = await executeApproved("no-such-id", { userId: USER_A, context: {} });
    assert.strictEqual(missing.error, "not_found");
});

test("rate limit blocks after the configured number of executions", async () => {
    const originalMax = config.actionRateLimitPerHour;
    config.actionRateLimitPerHour = 2;
    const originalHandler = sendEmail.handler;
    sendEmail.handler = async () => ({ sent: true });
    try {
        for (let i = 0; i < 2; i++) {
            const p = proposeAction("sendEmail", VALID_EMAIL, { userId: USER_A });
            const r = await executeApproved(p.proposalId, { userId: USER_A, context: { graphToken: "t" } });
            assert.strictEqual(r.ok, true);
        }
        const p3 = proposeAction("sendEmail", VALID_EMAIL, { userId: USER_A });
        const blocked = await executeApproved(p3.proposalId, { userId: USER_A, context: { graphToken: "t" } });
        assert.strictEqual(blocked.error, "rate_limited");
    } finally {
        config.actionRateLimitPerHour = originalMax;
        sendEmail.handler = originalHandler;
    }
});

test("cancel removes the proposal and only the owner can cancel", () => {
    const proposed = proposeAction("sendEmail", VALID_EMAIL, { userId: USER_A });
    assert.strictEqual(cancelApproved(proposed.proposalId, USER_B), false);
    assert.strictEqual(cancelApproved(proposed.proposalId, USER_A), true);
});

test("no-confirmation self-message executes directly via executeDirect", async () => {
    let delivered = null;
    const context = { sendToSelf: async (m) => { delivered = m; } };
    const r = await executeDirect("sendTeamsMessage", { message: "remember milk" }, { userId: USER_A, context });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(delivered, "remember milk");
});

test("executeDirect refuses a confirmation-required action", async () => {
    const r = await executeDirect("sendEmail", VALID_EMAIL, { userId: USER_A, context: {} });
    assert.strictEqual(r.error, "not_direct_executable");
});
