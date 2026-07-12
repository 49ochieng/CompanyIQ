const { graphFetch, AUTH_REQUIRED } = require("../auth/graph");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS = 10;

module.exports = {
    name: "sendEmail",
    description:
        "Send an email as the signed-in user. Use ONLY when the user explicitly asks to send or email " +
        "something in their own message. The user always sees and approves the final draft before it sends.",
    // Always confirmed: even a user-typed request shows the draft card first.
    requiresConfirmation: true,
    parameters: {
        type: "object",
        properties: {
            to: {
                type: "array",
                items: { type: "string" },
                description: "Recipient email addresses.",
            },
            subject: { type: "string", description: "Email subject line." },
            body: { type: "string", description: "Email body (plain text or simple HTML)." },
        },
        required: ["to", "subject", "body"],
    },
    /**
     * Validate the proposal. Never sends here — execution happens only after
     * the user approves the confirmation card (see handler).
     * @returns {{ok:true, args, preview} | {ok:false, reason}}
     */
    validate(args) {
        const to = Array.isArray(args.to) ? args.to.map((s) => String(s).trim()).filter(Boolean) : [];
        if (to.length === 0) return { ok: false, reason: "no recipients" };
        if (to.length > MAX_RECIPIENTS) return { ok: false, reason: `too many recipients (max ${MAX_RECIPIENTS})` };
        for (const addr of to) {
            if (!EMAIL_RE.test(addr)) return { ok: false, reason: `invalid email address: ${addr}` };
        }
        const subject = String(args.subject || "").slice(0, 255);
        const body = String(args.body || "");
        if (!body.trim()) return { ok: false, reason: "empty body" };
        return {
            ok: true,
            args: { to, subject, body },
            preview: {
                title: "Send email",
                fields: [
                    { label: "To", value: to.join(", ") },
                    { label: "Subject", value: subject },
                    { label: "Body", value: body },
                ],
            },
        };
    },
    /** Executes only after approval. Requires the user's Graph token. */
    async handler(args, context) {
        if (!context || !context.graphToken) {
            return AUTH_REQUIRED;
        }
        await graphFetch(context.graphToken, "POST", "/me/sendMail", {
            message: {
                subject: args.subject,
                body: { contentType: "Text", content: args.body },
                toRecipients: args.to.map((address) => ({ emailAddress: { address } })),
            },
            saveToSentItems: true,
        });
        return { sent: true, to: args.to };
    },
};
