// WATCHLIST config: the entities we track for client/competitor intelligence.
// Env JSON: [{name, domains[], description, topics[], cadence}].
// Public organizations only — this is enforced socially (tool descriptions) and
// operationally (we only ever crawl the declared domains + public web search).
"use strict";
const config = require("../config");
const { parseDomains } = require("./allowlist");

const VALID_CADENCE = new Set(["daily", "weekly", "hourly", "manual"]);

function parseWatchlist(raw) {
    if (!raw) return [];
    let list;
    try {
        list = JSON.parse(raw);
    } catch (error) {
        console.error("WATCHLIST is not valid JSON; no watchlist entities loaded.", error.message);
        return [];
    }
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const e of list) {
        if (!e || !e.name || !Array.isArray(e.domains) || e.domains.length === 0) {
            console.error(`Watchlist entity skipped (needs name + domains[]): ${JSON.stringify(e && e.name)}`);
            continue;
        }
        out.push({
            name: e.name,
            slug: slugify(e.name),
            domains: parseDomains(e.domains.join(",")),
            description: e.description || "",
            topics: Array.isArray(e.topics) ? e.topics : [],
            cadence: VALID_CADENCE.has((e.cadence || "").toLowerCase()) ? e.cadence.toLowerCase() : "daily",
        });
    }
    return out;
}

function slugify(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function getEntities() {
    return parseWatchlist(config.watchlist);
}

/** Resolve an entity by name or slug, case-insensitively and fuzzily. */
function findEntity(nameOrSlug) {
    const q = slugify(nameOrSlug || "");
    if (!q) return undefined;
    const entities = getEntities();
    return (
        entities.find((e) => e.slug === q) ||
        entities.find((e) => e.slug.includes(q) || q.includes(e.slug))
    );
}

module.exports = { parseWatchlist, getEntities, findEntity, slugify };
