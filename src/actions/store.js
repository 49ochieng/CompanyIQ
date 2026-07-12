// Pending action proposals + per-user rate limiting.
// A proposal is bound to the user who triggered it, expires after 10 minutes,
// and can only be executed by that same user (another user's card click must
// not execute it). In-memory for local; a deploy target would back this with
// Azure Table/Cosmos so proposals survive restarts.
const crypto = require("crypto");

const PROPOSAL_TTL_MS = 10 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 60 * 1000;

const proposals = new Map(); // proposalId -> { userId, action, args, createdAt }
const executions = new Map(); // userId -> number[] (execution timestamps)

function now() {
    return Date.now();
}

function createProposal(userId, actionName, args) {
    const id = crypto.randomUUID();
    proposals.set(id, { userId, actionName, args, createdAt: now() });
    return id;
}

/**
 * Resolve a proposal for execution. Enforces existence, expiry, and that the
 * clicking user is the proposing user.
 * @returns {{ok:true, actionName, args} | {ok:false, reason}}
 */
function claimProposal(proposalId, userId) {
    const p = proposals.get(proposalId);
    if (!p) {
        return { ok: false, reason: "not_found" };
    }
    if (now() - p.createdAt > PROPOSAL_TTL_MS) {
        proposals.delete(proposalId);
        return { ok: false, reason: "expired" };
    }
    if (p.userId !== userId) {
        // Do NOT delete — it still belongs to the proposing user.
        return { ok: false, reason: "wrong_user" };
    }
    proposals.delete(proposalId);
    return { ok: true, actionName: p.actionName, args: p.args };
}

function cancelProposal(proposalId, userId) {
    const p = proposals.get(proposalId);
    if (!p || p.userId !== userId) {
        return false;
    }
    proposals.delete(proposalId);
    return true;
}

/** Rate limit: max N executed actions per user per rolling hour. */
function checkRateLimit(userId, max) {
    const cutoff = now() - RATE_WINDOW_MS;
    const recent = (executions.get(userId) || []).filter((t) => t > cutoff);
    executions.set(userId, recent);
    return { allowed: recent.length < max, used: recent.length, max };
}

function recordExecution(userId) {
    const recent = executions.get(userId) || [];
    recent.push(now());
    executions.set(userId, recent);
}

// Test-only reset.
function _reset() {
    proposals.clear();
    executions.clear();
}

module.exports = {
    createProposal,
    claimProposal,
    cancelProposal,
    checkRateLimit,
    recordExecution,
    PROPOSAL_TTL_MS,
    _reset,
};
