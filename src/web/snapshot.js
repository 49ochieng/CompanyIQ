// Snapshot + diff — the heart of watchlist_brief. A snapshot is a per-entity,
// dated map of pages by URL, each with a content hash. Diffing two snapshots
// yields ONLY genuine changes (new page, gone page, changed content) — never a
// restatement of unchanged pages. A brief that finds nothing new says so.
"use strict";

/**
 * Build a snapshot from crawled page records.
 * @param {string} entity
 * @param {Array<{url,title,hash,publishedDate,fetchedAt}>} pages
 */
function buildSnapshot(entity, pages, takenAt = new Date().toISOString(), complete = true) {
    const byUrl = {};
    for (const p of pages) {
        byUrl[p.url] = {
            url: p.url,
            title: p.title || p.url,
            hash: p.hash,
            publishedDate: p.publishedDate || null,
            fetchedAt: p.fetchedAt || takenAt,
        };
    }
    // `complete` = the crawl exhausted the frontier (was NOT truncated by the
    // page cap). Diffing uses this so a partial crawl can't fabricate "new" or
    // "removed" pages that were merely not reached this time.
    return { entity, takenAt, complete: complete !== false, pages: byUrl };
}

/**
 * Diff current vs previous snapshot.
 * @returns {{isBaseline:boolean, added:Array, removed:Array, changed:Array, unchanged:number, hasChanges:boolean}}
 * `added`/`changed` carry the current page record; `removed` the previous one.
 * When `prev` is absent this is the first crawl — a baseline, NOT a pile of
 * "new" news; the caller reports it as such rather than dumping the whole site.
 */
function diffSnapshots(prev, curr) {
    const currPages = (curr && curr.pages) || {};
    if (!prev || !prev.pages) {
        return {
            isBaseline: true,
            added: [],
            removed: [],
            changed: [],
            unchanged: Object.keys(currPages).length,
            hasChanges: false,
        };
    }
    const prevPages = prev.pages;
    const prevComplete = prev.complete !== false;
    const currComplete = curr && curr.complete !== false;
    const prevTaken = prev.takenAt ? new Date(prev.takenAt).getTime() : 0;

    const added = [];
    const changed = [];
    let unchanged = 0;
    let suppressed = 0; // coverage-churn we deliberately did NOT report
    for (const url of Object.keys(currPages)) {
        const cur = currPages[url];
        if (!prevPages[url]) {
            // A URL absent from the previous snapshot is only genuinely NEW if
            // the previous crawl was complete, OR the page itself is dated after
            // the previous crawl. Otherwise it's likely a page the earlier
            // (truncated) crawl just didn't reach — not news.
            const datedNew = cur.publishedDate && new Date(cur.publishedDate).getTime() > prevTaken;
            if (prevComplete || datedNew) added.push(cur);
            else suppressed++;
        } else if (prevPages[url].hash !== cur.hash) {
            changed.push(cur); // both crawls captured it → a real content change
        } else {
            unchanged++;
        }
    }
    const removed = [];
    for (const url of Object.keys(prevPages)) {
        // A URL missing from the current snapshot is only "removed" if THIS
        // crawl was complete; a truncated crawl simply may not have reached it.
        if (!currPages[url]) {
            if (currComplete) removed.push(prevPages[url]);
            else suppressed++;
        }
    }
    return {
        isBaseline: false,
        added,
        removed,
        changed,
        unchanged,
        suppressed,
        partialCoverage: !prevComplete || !currComplete,
        hasChanges: added.length > 0 || removed.length > 0 || changed.length > 0,
    };
}

/**
 * Render a diff as plain, dated brief lines. Returns "" when there is nothing
 * new so the caller can say so honestly instead of padding.
 */
function summarizeDiff(diff, entityName) {
    if (diff.isBaseline) {
        return `Baseline snapshot recorded for ${entityName} (${diff.unchanged} pages). Future briefs will report only what changes.`;
    }
    if (!diff.hasChanges) {
        return "";
    }
    const lines = [];
    const dateOf = (p) => p.publishedDate || (p.fetchedAt ? `fetched ${p.fetchedAt.slice(0, 10)}` : "date unknown");
    if (diff.added.length) {
        lines.push(`**New pages (${diff.added.length}):**`);
        for (const p of diff.added) lines.push(`- [${p.title}](${p.url}) — ${dateOf(p)}`);
    }
    if (diff.changed.length) {
        lines.push(`**Updated pages (${diff.changed.length}):**`);
        for (const p of diff.changed) lines.push(`- [${p.title}](${p.url}) — ${dateOf(p)}`);
    }
    if (diff.removed.length) {
        lines.push(`**Removed pages (${diff.removed.length}):**`);
        for (const p of diff.removed) lines.push(`- ${p.title} (${p.url})`);
    }
    if (diff.partialCoverage) {
        lines.push("");
        lines.push("_Note: coverage was partial this run (the crawl was truncated), so only content-verified changes and dated-new pages are reported._");
    }
    return lines.join("\n");
}

module.exports = { buildSnapshot, diffSnapshots, summarizeDiff };
