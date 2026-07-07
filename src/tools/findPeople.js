const { graphFetch, AUTH_REQUIRED, logGraphCall } = require("../auth/graph");

const MAX_PEOPLE = 5;

module.exports = {
    name: "findPeople",
    description:
        "Fuzzy person lookup in the organization (name → email address and job title), ranked by " +
        "relevance to the signed-in user. Use FIRST to resolve an ambiguous name like 'Catherine' " +
        "before searching email or calendar.",
    parameters: {
        type: "object",
        properties: {
            name: {
                type: "string",
                description: "The (partial) name to look up, e.g. 'Catherine'.",
            },
        },
        required: ["name"],
    },
    async handler(args, context) {
        if (!context || !context.graphToken) {
            return AUTH_REQUIRED;
        }
        const startedAt = Date.now();

        const q = encodeURIComponent(`"${(args.name || "").replace(/"/g, "")}"`);
        const response = await graphFetch(
            context.graphToken,
            "GET",
            `/me/people?$search=${q}&$top=${MAX_PEOPLE}&$select=displayName,scoredEmailAddresses,jobTitle`
        );

        const people = (response.value || []).slice(0, MAX_PEOPLE).map((p) => ({
            name: p.displayName,
            email: p.scoredEmailAddresses?.[0]?.address,
            title: p.jobTitle,
        }));

        logGraphCall(context, "findPeople", people.length, Date.now() - startedAt);
        return { people, peopleCount: people.length };
    },
};
