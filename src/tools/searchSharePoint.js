const { graphFetch, AUTH_REQUIRED, logGraphCall } = require("../auth/graph");
const config = require("../config");

const MAX_RESULTS = 10;

module.exports = {
    name: "searchSharePoint",
    description:
        "Search the organization's SharePoint sites (documents, pages, lists) as the signed-in user. " +
        "Use for questions about team documents, policies, or content stored in SharePoint. " +
        "Results are limited to what the user is allowed to see.",
    parameters: {
        type: "object",
        properties: {
            query: {
                type: "string",
                description: "The search terms, e.g. 'onboarding guide'.",
            },
        },
        required: ["query"],
    },
    async handler(args, context) {
        if (!context || !context.graphToken) {
            return AUTH_REQUIRED;
        }
        const startedAt = Date.now();

        // Constrain to the configured sites via KQL path filters (the Search
        // API has no site parameter; path: filtering is the documented way).
        let queryString = args.query;
        const sites = (config.sharePointSites || "").split(",").map((s) => s.trim()).filter(Boolean);
        if (sites.length > 0) {
            const paths = sites.map((s) => `path:"${s}"`).join(" OR ");
            queryString = `${queryString} (${paths})`;
        }

        const response = await graphFetch(context.graphToken, "POST", "/search/query", {
            requests: [
                {
                    entityTypes: ["driveItem", "listItem", "site"],
                    query: { queryString },
                    from: 0,
                    size: MAX_RESULTS,
                },
            ],
        });

        const results = [];
        for (const container of response.value?.[0]?.hitsContainers || []) {
            for (const hit of container.hits || []) {
                if (results.length >= MAX_RESULTS) break;
                const resource = hit.resource || {};
                results.push({
                    title: resource.name || resource.displayName || resource.webUrl || "(untitled)",
                    snippet: (hit.summary || "").replace(/<\/?c0>|<ddd\/>/g, ""),
                    webUrl: resource.webUrl,
                });
            }
        }

        logGraphCall(context, "searchSharePoint", results.length, Date.now() - startedAt);
        return { results, resultCount: results.length };
    },
};
