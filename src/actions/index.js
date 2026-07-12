// Action registry — parallel to the tool registry, but actions cause SIDE
// EFFECTS (write operations), so they follow the confirmation/consent model
// in src/actions/runner.js. The model may PROPOSE actions; it can never
// execute one directly.
const config = require("../config");
const sendEmail = require("./sendEmail");
const sendTeamsMessage = require("./sendTeamsMessage");

const actions = [sendEmail, sendTeamsMessage];

function validateAction(a) {
    if (!a.name || !a.description || !a.parameters || typeof a.handler !== "function" || typeof a.validate !== "function") {
        throw new Error(`Action is missing required fields: ${a.name || "<unnamed>"}`);
    }
    if (typeof a.requiresConfirmation !== "boolean") {
        throw new Error(`Action ${a.name} must declare requiresConfirmation`);
    }
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

module.exports = { actions, getActions, getAction, registerAction, validateAction };
