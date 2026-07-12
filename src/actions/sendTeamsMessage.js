// Proactive Teams message to the requesting user's OWN conversation.
// The target is structurally the user themselves (any target argument is
// ignored), so there is no external-redirect surface — hence no confirmation
// card is required. The proactive send is performed by the app layer, which
// owns the conversation-reference store; this action just validates + carries
// the message text.
module.exports = {
    name: "sendTeamsMessage",
    description:
        "Send yourself (the signed-in user) a Teams message — e.g. a reminder or a saved note. " +
        "Only messages the requesting user's own chat; cannot message anyone else.",
    requiresConfirmation: false,
    parameters: {
        type: "object",
        properties: {
            message: { type: "string", description: "The message text to send to yourself." },
        },
        required: ["message"],
    },
    validate(args) {
        const message = String(args.message || "").trim();
        if (!message) return { ok: false, reason: "empty message" };
        return {
            ok: true,
            args: { message },
            preview: { title: "Send yourself a Teams message", fields: [{ label: "Message", value: message }] },
        };
    },
    /**
     * Execution is delegated to the app layer (it holds the conversation
     * reference for this user). context.sendToSelf is injected per turn.
     */
    async handler(args, context) {
        if (!context || typeof context.sendToSelf !== "function") {
            return { error: "unavailable", message: "Self-messaging is not available in this context." };
        }
        await context.sendToSelf(args.message);
        return { sent: true };
    },
};
