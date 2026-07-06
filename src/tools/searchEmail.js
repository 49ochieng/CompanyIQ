const { graphFetch, AUTH_REQUIRED, logGraphCall } = require("../auth/graph");

const MAX_RESULTS = 10;

module.exports = {
    name: "searchEmail",
    description:
        "Search the signed-in user's own mailbox. Use for questions about emails the user received or " +
        "sent ('emails from Catherine', 'that invoice email last week').",
    parameters: {
        type: "object",
        properties: {
            query: {
                type: "string",
                description:
                    "Search terms. Supports KQL like from:name or subject:topic, e.g. 'from:catherine onboarding'.",
            },
        },
        required: ["query"],
    },
    async handler(args, context) {
        if (!context || !context.graphToken) {
            return AUTH_REQUIRED;
        }
        const startedAt = Date.now();

        const q = encodeURIComponent(`"${args.query.replace(/"/g, "")}"`);
        const response = await graphFetch(
            context.graphToken,
            "GET",
            `/me/messages?$search=${q}&$top=${MAX_RESULTS}&$select=subject,from,receivedDateTime,bodyPreview,webLink`
        );

        const results = (response.value || []).slice(0, MAX_RESULTS).map((m) => ({
            subject: m.subject,
            from: m.from?.emailAddress?.name || m.from?.emailAddress?.address,
            receivedDateTime: m.receivedDateTime,
            bodyPreview: m.bodyPreview,
            webLink: m.webLink,
        }));

        // Audit logs carry counts only — never message bodies or queries.
        logGraphCall(context, "searchEmail", results.length, Date.now() - startedAt);
        return { results, resultCount: results.length };
    },
};
