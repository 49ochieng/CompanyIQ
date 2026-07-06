const { graphFetch, AUTH_REQUIRED, logGraphCall } = require("../auth/graph");

const MAX_RESULTS = 10;

module.exports = {
    name: "searchOneDrive",
    description:
        "Search the signed-in user's own OneDrive files. Use for questions about the user's personal " +
        "documents ('my files', 'my drive', a document they saved themselves).",
    parameters: {
        type: "object",
        properties: {
            query: {
                type: "string",
                description: "The search terms, e.g. 'expense report draft'.",
            },
        },
        required: ["query"],
    },
    async handler(args, context) {
        if (!context || !context.graphToken) {
            return AUTH_REQUIRED;
        }
        const startedAt = Date.now();

        // /me/drive scopes the search to the user's own drive (the Search API
        // with entityTypes=driveItem spans every drive the user can reach,
        // which is searchSharePoint's job).
        const q = encodeURIComponent(args.query.replace(/'/g, "''"));
        const response = await graphFetch(
            context.graphToken,
            "GET",
            `/me/drive/root/search(q='${q}')?$top=${MAX_RESULTS}&$select=name,webUrl,lastModifiedDateTime,size`
        );

        const results = (response.value || []).slice(0, MAX_RESULTS).map((item) => ({
            title: item.name,
            webUrl: item.webUrl,
            lastModified: item.lastModifiedDateTime,
        }));

        logGraphCall(context, "searchOneDrive", results.length, Date.now() - startedAt);
        return { results, resultCount: results.length };
    },
};
