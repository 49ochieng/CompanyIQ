// Confirmation card for a proposed action. Shows EXACTLY what will happen —
// recipients, subject, body preview, or flow name + payload — so the user
// approves an accurate, concrete draft. Approve/Cancel are Action.Submit
// buttons carrying the proposalId; the app resolves them against the store.
//
// Card conventions:
//  - plain header ("Confirm: <title>"); no warning icon for routine actions.
//    An action may set `sensitive: true` to get an explicit caution line.
//  - payloads render in a monospace block, not a FactSet row.
//  - truncation is ALWAYS disclosed — never silently clipped.
const { MessageActivity } = require("@microsoft/teams.api");

const MAX_FIELD_CHARS = 1500;

/** Truncate with an explicit, visible disclosure of what was cut. */
function truncate(text, max = MAX_FIELD_CHARS) {
    const s = String(text ?? "");
    if (s.length <= max) {
        return s;
    }
    const hidden = s.length - max;
    return `${s.slice(0, max)}\n… [truncated — ${hidden} more character${hidden === 1 ? "" : "s"} will still be included when this runs]`;
}

/**
 * @param {string} proposalId
 * @param {{title:string, sensitive?:boolean, fields:Array<{label:string,value:string,monospace?:boolean}>}} preview
 */
function buildConfirmationCard(proposalId, preview) {
    const body = [
        {
            type: "TextBlock",
            text: `Confirm: ${preview.title}`,
            weight: "Bolder",
            size: "Medium",
            wrap: true,
        },
        {
            type: "TextBlock",
            text: preview.sensitive
                ? "⚠️ This is a sensitive action. Review it carefully before approving."
                : "Review the details below, then Approve or Cancel. Nothing happens until you approve.",
            isSubtle: true,
            wrap: true,
            spacing: "None",
        },
    ];

    // Plain fields go in a FactSet; monospace fields (payloads) get their own block.
    const factFields = preview.fields.filter((f) => !f.monospace);
    const codeFields = preview.fields.filter((f) => f.monospace);

    if (factFields.length > 0) {
        body.push({
            type: "FactSet",
            facts: factFields.map((f) => ({ title: f.label, value: truncate(f.value) })),
        });
    }

    for (const f of codeFields) {
        body.push({
            type: "TextBlock",
            text: f.label,
            weight: "Bolder",
            wrap: true,
            spacing: "Medium",
        });
        body.push({
            type: "Container",
            style: "emphasis",
            spacing: "Small",
            items: [
                {
                    type: "TextBlock",
                    text: truncate(f.value),
                    fontType: "Monospace",
                    wrap: true,
                },
            ],
        });
    }

    return {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.5",
        body,
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
    return new MessageActivity(`Confirm: ${preview.title}`).addCard(
        "adaptive",
        buildConfirmationCard(proposalId, preview)
    );
}

module.exports = { buildConfirmationCard, confirmationActivity, truncate, MAX_FIELD_CHARS };
