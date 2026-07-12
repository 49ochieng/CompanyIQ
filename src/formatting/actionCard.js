// Confirmation card for a proposed action. Shows EXACTLY what will happen —
// recipients, subject, body preview, or flow name + payload — so the user
// approves an accurate, concrete draft. Approve/Cancel are Action.Submit
// buttons carrying the proposalId; the app resolves them against the store.
const { MessageActivity } = require("@microsoft/teams.api");

function truncate(text, max) {
    const s = String(text ?? "");
    return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * @param {string} proposalId
 * @param {{title:string, fields:Array<{label:string,value:string}>}} preview
 */
function buildConfirmationCard(proposalId, preview) {
    const facts = preview.fields.map((f) => ({
        title: f.label,
        value: truncate(f.value, 1800),
    }));

    return {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.5",
        body: [
            {
                type: "TextBlock",
                text: `⚠️ Please confirm: ${preview.title}`,
                weight: "Bolder",
                size: "Medium",
                wrap: true,
            },
            {
                type: "TextBlock",
                text: "This will take an action on your behalf. Review it, then Approve or Cancel.",
                isSubtle: true,
                wrap: true,
                spacing: "None",
            },
            { type: "FactSet", facts },
        ],
        actions: [
            {
                type: "Action.Submit",
                title: "Approve",
                style: "positive",
                data: { companyiqAction: "approve", proposalId },
            },
            {
                type: "Action.Submit",
                title: "Cancel",
                style: "destructive",
                data: { companyiqAction: "cancel", proposalId },
            },
        ],
    };
}

/** MessageActivity carrying just the confirmation card. */
function confirmationActivity(proposalId, preview) {
    return new MessageActivity(`Please confirm: ${preview.title}`).addCard(
        "adaptive",
        buildConfirmationCard(proposalId, preview)
    );
}

module.exports = { buildConfirmationCard, confirmationActivity };
