// Action registry — parallel to the tool registry, but actions cause SIDE
// EFFECTS (write operations), so they follow the confirmation/consent model
// in src/actions/runner.js. The model may PROPOSE actions; it can never
// execute one directly.
const config = require("../config");
const sendEmail = require("./sendEmail");
const sendTeamsMessage = require("./sendTeamsMessage");
const { buildRunFlowAction } = require("./runFlow");

const actions = [sendEmail, sendTeamsMessage];

// Flag-gated: with ACTIONS_FLOWS_ENABLED off (or no FLOWS whitelist), the
// action is never registered and the model cannot see it at all.
const runFlow = buildRunFlowAction();
if (runFlow) {
    actions.push(runFlow);
}

function validateAction(a) {
    if (!a.name || !a.description || !a.parameters || typeof a.handler !== "function" || typeof a.validate !== "function") {
        throw new Error(`Action is missing required fields: ${a.name || "<unnamed>"}`);
    }
    const kind = typeof a.requiresConfirmation;
    if (kind !== "boolean" && kind !== "function") {
        throw new Error(`Action ${a.name} must declare requiresConfirmation`);
    }
}

/**
 * Whether this action, with these arguments, must be confirmed by the user.
 * Defaults to TRUE for anything ambiguous — a write is never silently run.
 */
function needsConfirmation(action, args) {
    if (typeof action.requiresConfirmation === "function") {
        return action.requiresConfirmation(args) !== false;
    }
    return action.requiresConfirmation !== false;
}

for (const a of actions) {
    validateAction(a);
}

function registerAction(a) {
    validateAction(a);
    if (actions.some((x) => x.name === a.name)) {
        throw new Error(`Action name collision: '${a.name}'`);
    }
    actions.push(a);
}

function getActions() {
    return actions;
}

function getAction(name) {
    return actions.find((a) => a.name === name);
}

module.exports = { actions, getActions, getAction, registerAction, validateAction, needsConfirmation };
