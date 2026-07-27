// Crawler orchestrator: breadth-first within an allowlist, obeying robots.txt,
// bounded by depth/page count, polite (delay between fetches), with a short TTL
// cache so re-crawls within the window don't re-hit a site. Pure logic lives in
// allowlist/robots/extract; this wires them to the network. `deps.fetch` is
// injectable so the whole thing is testable offline.
"use strict";
const config = require("../config");
const { normalizeUrl, isAllowed } = require("./allowlist");
const { parseRobots, rulesFor, isPathAllowed, UA } = require("./robots");
const { parsePage } = require("./extract");

const MAX_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 12000;

const globalCache = new Map(); // url -> { at, page }

function fromCache(url, ttlMs, cache) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < ttlMs) return hit.page;
    return undefined;
}

async function defaultFetchText(url) {
    const res = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "User-Agent": `${UA}/1.0 (+internal competitive-intelligence; respects robots.txt)` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get("content-type") || "";
    if (ct && !/text\/html|application\/xhtml/i.test(ct)) return null; // skip binaries/PDated assets
    const text = await res.text();
    return text.slice(0, MAX_BYTES);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(fetchText, url, retries) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fetchText(url);
        } catch (error) {
            if (attempt >= retries) throw error;
            await sleep(500);
        }
    }
}

/**
 * Crawl an entity's domains.
 * @param {{name:string, domains:string[]}} entity
 * @param {object} [deps] { fetchText, robotsText, delayMs, maxPages, maxDepth, ttlMs, cache, now }
 * @returns {Promise<{entity:string, pages:Array, fetched:number, skipped:number}>}
 */
async function crawl(entity, deps = {}) {
    const fetchText = deps.fetchText || defaultFetchText;
    const delayMs = deps.delayMs ?? config.crawlDelayMs;
    const maxPages = deps.maxPages ?? config.crawlMaxPages;
    const maxDepth = deps.maxDepth ?? config.crawlMaxDepth;
    const ttlMs = deps.ttlMs ?? config.crawlCacheTtlMs;
    const cache = deps.cache || globalCache;
    const domains = entity.domains;

    // robots per host (fetched once). deps.robotsText lets tests supply it.
    const robotsByHost = new Map();
    async function robotsAllows(url) {
        const host = new URL(url).host;
        if (!robotsByHost.has(host)) {
            let text = "";
            try {
                text = deps.robotsText ? await deps.robotsText(host) : await fetchText(`https://${host}/robots.txt`);
            } catch {
                text = ""; // no robots.txt → allowed
            }
            robotsByHost.set(host, rulesFor(parseRobots(text || ""), UA));
        }
        return isPathAllowed(robotsByHost.get(host), new URL(url).pathname);
    }

    const seeds = domains.map((d) => `https://${d}`);
    const queue = seeds.map((u) => ({ url: normalizeUrl(u), depth: 0 })).filter((x) => x.url);
    const seen = new Set(queue.map((q) => q.url));
    const pages = [];
    let fetched = 0;
    let skipped = 0;

    while (queue.length > 0 && pages.length < maxPages) {
        const { url, depth } = queue.shift();
        if (!isAllowed(url, domains)) { skipped++; continue; }
        if (!(await robotsAllows(url))) { skipped++; continue; }

        const cached = fromCache(url, ttlMs, cache);
        let page = cached;
        if (!page) {
            try {
                // The seed(s) are worth one retry: a single cold-start timeout on
                // the entry point would otherwise abandon the whole crawl. Deeper
                // pages are not retried (a dead link should just be skipped).
                const html = await fetchWithRetry(fetchText, url, depth === 0 ? 1 : 0);
                if (html == null) { skipped++; continue; }
                page = parsePage(html, url, domains);
                cache.set(url, { at: Date.now(), page });
                fetched++;
                if (delayMs) await sleep(delayMs); // politeness — only on real fetches
            } catch {
                skipped++;
                continue;
            }
        }
        pages.push(page);

        if (depth < maxDepth) {
            for (const link of page.links) {
                if (!seen.has(link) && isAllowed(link, domains)) {
                    seen.add(link);
                    queue.push({ url: link, depth: depth + 1 });
                }
            }
        }
    }

    // `truncated`: we stopped because of the page cap while links remained, so
    // this crawl did NOT fully cover the site. The diff uses this to avoid
    // reporting merely-unreached pages as new/removed.
    const truncated = queue.length > 0 && pages.length >= maxPages;
    return { entity: entity.name, pages, fetched, skipped, truncated };
}

module.exports = { crawl };
