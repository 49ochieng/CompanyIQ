// watchlist_search — on-demand client/competitor Q&A about a watched public
// organization. Blends TWO clearly-separated sources: (1) our crawl of the
// entity's own site, and (2) live public-web search via Bing grounding. Every
// item carries a source URL and a date; nothing undated is presented as recent.
//
// Scope discipline is in the description on purpose: this tool is for PUBLIC
// organizational information (news, contracts, grants, press releases, public
// meeting agendas) — never for surveilling or profiling individuals.
"use strict";
// Namespace requires so tests can stub the I/O without a network or Azure.
const watchlist = require("../web/watchlist");
const webIndex = require("../web/webIndex");
const grounding = require("../connectors/grounding");
const { wrapUntrusted } = require("../connectors/payload");

const SCOPE_LINE =
    "PUBLIC organizational information only — news, contracts, grants, press releases, public meeting agendas. " +
    "Never surveil, profile, or infer about specific individuals at the organization.";

function dateLabel(hit) {
    if (hit.publishedDate) return `published ${String(hit.publishedDate).slice(0, 10)}`;
    if (hit.fetchedAt) return `seen on their site ${String(hit.fetchedAt).slice(0, 10)}`;
    return "date unknown";
}

module.exports = {
    name: "watchlist_search",
    description:
        "Answer an on-demand question about a watched public organization (e.g. a client or competitor like " +
        "Dallas County): what their own website says AND what current public web sources report. Results are " +
        "cited and dated, and clearly separated into 'their site' vs 'the open web'. " +
        SCOPE_LINE,
    parameters: {
        type: "object",
        properties: {
            entity: { type: "string", description: "The watched organization's name, e.g. 'Dallas County'." },
            question: { type: "string", description: "The public-information question, self-contained." },
            freshness: { type: "string", enum: ["day", "week", "month"], description: "Optional recency limit for web search." },
        },
        required: ["entity", "question"],
    },
    async handler(args, context) {
        const entity = watchlist.findEntity(args.entity);
        if (!entity) {
            return { error: "unknown_entity", message: `'${args.entity}' is not on the watchlist. Ask an administrator to add it.` };
        }

        const sections = [];
        const citations = [];

        // 1) Their own site (our crawl index).
        let siteHits = [];
        try {
            siteHits = await webIndex.searchPages(entity.slug, args.question, 5);
        } catch (error) {
            console.log(JSON.stringify({ event: "watchlist_search_site_error", entity: entity.slug, message: String(error.message).slice(0, 120) }));
        }
        if (siteHits.length > 0) {
            const lines = siteHits.map((h) => `- ${h.title} (${dateLabel(h)}): ${h.snippet}`);
            sections.push(`From ${entity.name}'s own site (${entity.domains.join(", ")}):\n${lines.join("\n")}`);
            for (const h of siteHits) citations.push({ title: `${h.title} — ${dateLabel(h)}`, url: h.url });
        } else {
            sections.push(`From ${entity.name}'s own site: nothing matching in the latest crawl.`);
        }

        // 2) The open web (Bing grounding), if configured.
        const groundingCfg = grounding.getGroundingConfig();
        if (groundingCfg) {
            try {
                const q = `${args.question} (about the public organization ${entity.name}, ${entity.domains.join(", ")}). ${SCOPE_LINE}`;
                const web = await grounding.groundedSearch(groundingCfg, q, { freshness: args.freshness });
                if (web.text) {
                    sections.push(`From the open web (Bing, live):\n${web.text}`);
                    for (const c of web.citations || []) citations.push(c);
                }
            } catch (error) {
                console.log(JSON.stringify({ event: "watchlist_search_web_error", entity: entity.slug, message: String(error.message).slice(0, 120) }));
                sections.push("From the open web: live search is temporarily unavailable.");
            }
        } else {
            sections.push("From the open web: not configured (their-site results only).");
        }

        // Public web data → userScoped:true (nothing beyond any caller's access).
        // Wrapped untrusted so the model treats it as data, never instructions.
        return wrapUntrusted(`watchlist:${entity.slug}`, sections.join("\n\n"), {
            userScoped: true,
            citations: citations.length ? citations.slice(0, 15) : undefined,
        });
    },
};
