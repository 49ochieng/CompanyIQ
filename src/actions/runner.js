// Executes actions under the confirmation/consent + rate-limit model, and
// emits the audit trail. Nothing here runs a write without either an approved
// proposal (requiresConfirmation:true) or a no-confirmation action whose
// effect is structurally safe (requiresConfirmation:false, e.g. self-message).
const config = require("../config");
const { getAction, needsConfirmation } = require("./index");
const {
    createProposal,
    claimProposal,
    cancelProposal,
    checkRateLimit,
    recordExecution,
} = require("./store");

function audit(event, extra) {
    console.log(JSON.stringify({ event, ...extra }));
}

/**
 * Validate an action's args and create a pending proposal (for confirmed
 * actions). Returns the card preview or a structured error for the model.
 */
function proposeAction(actionName, args, { userId }) {
    const action = getAction(actionName);
    if (!action) {
        return { error: "unknown_action", message: `No such action: ${actionName}` };
    }
    const validation = action.validate(args);
    if (!validation.ok) {
        return { error: "validation_failed", message: validation.reason };
    }
    const confirm = needsConfirmation(action, validation.args);
    if (!confirm) {
        // No confirmation needed for this action/arguments — the caller executes
        // it directly after the turn (structurally safe actions only).
        return { direct: true, args: validation.args, requiresConfirmation: false };
    }
    const proposalId = createProposal(userId, actionName, validation.args);
    audit("action_proposed", { action: actionName, userObjectId: userId, proposalId });
    return { proposalId, preview: validation.preview, requiresConfirmation: true };
}

async function runHandler(action, args, context, userId) {
    const limit = checkRateLimit(userId, config.actionRateLimitPerHour);
    if (!limit.allowed) {
        audit("action_rate_limited", { action: action.name, userObjectId: userId, used: limit.used, max: limit.max });
        return { error: "rate_limited", message: `Action limit reached (${limit.max}/hour). Try again later.` };
    }
    try {
        const result = await action.handler(args, context);
        if (result && result.error) {
            audit("action_failed", { action: action.name, userObjectId: userId, error: result.error });
            return result;
        }
        recordExecution(userId);
        audit("action_executed", { action: action.name, userObjectId: userId });
        return { ok: true, result };
    } catch (error) {
        audit("action_failed", { action: action.name, userObjectId: userId, error: String(error.message || error).slice(0, 200) });
        return { error: "execution_failed", message: "The action could not be completed." };
    }
}

/** Execute a previously proposed action after the user approves the card. */
async function executeApproved(proposalId, { userId, context }) {
    const claim = claimProposal(proposalId, userId);
    if (!claim.ok) {
        audit("action_claim_rejected", { proposalId, userObjectId: userId, reason: claim.reason });
        return { error: claim.reason };
    }
    const action = getAction(claim.actionName);
    if (!action) {
        return { error: "unknown_action" };
    }
    return runHandler(action, claim.args, context, userId);
}

/** Cancel a pending proposal (Cancel button). */
function cancelApproved(proposalId, userId) {
    const cancelled = cancelProposal(proposalId, userId);
    audit(cancelled ? "action_cancelled" : "action_cancel_rejected", { proposalId, userObjectId: userId });
    return cancelled;
}

/** Directly execute a no-confirmation action (validated first). */
async function executeDirect(actionName, args, { userId, context }) {
    const action = getAction(actionName);
    if (!action) {
        return { error: "not_direct_executable" };
    }
    const validation = action.validate(args);
    if (!validation.ok) {
        return { error: "validation_failed", message: validation.reason };
    }
    // A confirmation-required action can NEVER be executed on this path.
    if (needsConfirmation(action, validation.args)) {
        return { error: "not_direct_executable" };
    }
    return runHandler(action, validation.args, context, userId);
}

module.exports = { proposeAction, executeApproved, cancelApproved, executeDirect };
