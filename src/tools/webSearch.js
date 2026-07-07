// Public web tool — flag-gated by CONNECTOR_PUBLIC_WEB_ENABLED. When the flag
// is false the registry never registers this tool, so the model cannot see it.
//
// Production path (not yet available in this subscription): Grounding with
// Bing Search via Azure AI Foundry Agents. That requires a
// `Microsoft.Bing/accounts` resource (kind `Bing.Grounding`) connected to an
// AI Foundry project; none exists today. Until one is provisioned, this
// implementation fetches pages directly and is restricted to the domains in
// ORG_WEBSITE_ALLOWLIST.
const config = require("../config");

const MAX_RESULTS = 5;
const FETCH_TIMEOUT_MS = 10000;
const MAX_BYTES = 512 * 1024;

function allowlistedDomains() {
    return (config.orgWebsiteAllowlist || "")
        .split(",")
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean);
}

function isAllowed(url, domains) {
    let host;
    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return false;
    }
    return domains.some((d) => host === d || host === `www.${d}` || host.endsWith(`.${d}`));
}

async function fetchPage(url) {
    const res = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "User-Agent": "CompanyIQ-bot/1.0 (+internal assistant)" },
    });
    if (!res.ok) {
        throw new Error(`fetch failed: ${res.status}`);
    }
    const html = (await res.text()).slice(0, MAX_BYTES);
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || url;
    const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&[a-z]+;/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
    return { title: title.trim(), text };
}

function snippetsFor(text, query, count) {
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const lower = text.toLowerCase();
    const snippets = [];
    for (const word of words) {
        let idx = 0;
        while (snippets.length < count && (idx = lower.indexOf(word, idx)) !== -1) {
            const start = Math.max(0, idx - 120);
            const snippet = text.slice(start, idx + 180).trim();
            if (!snippets.some((s) => s === snippet)) {
                snippets.push(snippet);
            }
            idx += word.length;
        }
        if (snippets.length >= count) break;
    }
    return snippets;
}

module.exports = {
    name: "webSearch",
    description:
        "Fetch information from the organization's public websites. Use only when internal sources " +
        "(company data, documents, SharePoint) cannot answer and the question concerns public web content. " +
        "Results are external information and are rendered in a separate, clearly labeled section.",
    parameters: {
        type: "object",
        properties: {
            query: {
                type: "string",
                description: "The search terms to look for on the allowed websites.",
            },
            url: {
                type: "string",
                description: "Optional specific page URL to fetch. Must be on an allowed domain.",
            },
        },
        required: ["query"],
    },
    async handler(args, context) {
        const startedAt = Date.now();
        const domains = allowlistedDomains();
        if (domains.length === 0) {
            return { error: "not_configured", message: "No allowed web domains are configured." };
        }

        const targets = [];
        if (args.url) {
            if (!isAllowed(args.url, domains)) {
                return {
                    error: "domain_not_allowed",
                    message: `Only these domains may be fetched: ${domains.join(", ")}.`,
                };
            }
            targets.push(args.url);
        } else {
            for (const domain of domains.slice(0, 3)) {
                targets.push(`https://${domain}`);
            }
        }

        const results = [];
        for (const url of targets) {
            if (results.length >= MAX_RESULTS) break;
            try {
                const page = await fetchPage(url);
                const snippets = snippetsFor(page.text, args.query, 2);
                if (snippets.length > 0) {
                    results.push({ url, title: page.title, snippet: snippets.join(" … ") });
                } else if (args.url) {
                    // An explicitly requested page counts even without keyword hits.
                    results.push({ url, title: page.title, snippet: page.text.slice(0, 300) });
                }
            } catch (error) {
                console.log(
                    JSON.stringify({ event: "web_fetch_failed", url, error: error.message.slice(0, 120) })
                );
            }
        }

        console.log(
            JSON.stringify({
                event: "web_search",
                conversationId: context && context.conversationId,
                resultCount: results.length,
                durationMs: Date.now() - startedAt,
            })
        );

        return { results, resultCount: results.length, external: true };
    },
};
