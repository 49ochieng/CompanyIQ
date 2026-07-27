// watchlist_brief — "what's NEW about a watched organization since the last
// brief". Purely diff-based: it compares the latest crawl snapshot to an
// earlier one and reports ONLY genuine changes (new page, changed page, removed
// page), each dated. If nothing changed, it says so plainly — it never restates
// unchanged content to pad the answer.
//
// PUBLIC organizational information only; never about individuals.
"use strict";
const watchlist = require("../web/watchlist");
const webIndex = require("../web/webIndex");
const { diffSnapshots, summarizeDiff } = require("../web/snapshot");
const { wrapUntrusted } = require("../connectors/payload");

module.exports = {
    name: "watchlist_brief",
    description:
        "Report ONLY what has changed on a watched public organization's site since the last brief (new, updated, " +
        "or removed pages — new grants, projects, contracts, press releases), each with a date. If nothing has " +
        "changed, it says so — it never restates old content. Use for 'what's new about <org>' questions. " +
        "PUBLIC organizational information only; never about individuals.",
    parameters: {
        type: "object",
        properties: {
            entity: { type: "string", description: "The watched organization's name, e.g. 'Dallas County'." },
            since: { type: "string", description: "Optional ISO timestamp: report changes since this time (default: the previous snapshot)." },
        },
        required: ["entity"],
    },
    async handler(args, context) {
        const entity = watchlist.findEntity(args.entity);
        if (!entity) {
            return { error: "unknown_entity", message: `'${args.entity}' is not on the watchlist.` };
        }

        // "since last brief": args.since wins; else the scheduler's per-
        // subscription watermark (context.watchlistSince); else the snapshot
        // immediately before the latest.
        const since = args.since || (context && context.watchlistSince);
        let current, previous;
        try {
            current = await webIndex.loadSnapshot(entity.slug); // latest
            previous = await webIndex.loadSnapshot(entity.slug, since || (current && current.takenAt));
        } catch (error) {
            return { error: "snapshot_unavailable", message: `Couldn't read crawl history for ${entity.name}: ${String(error.message).slice(0, 100)}` };
        }

        if (!current) {
            return wrapUntrusted(`watchlist:${entity.slug}`, `No crawl history yet for ${entity.name}. Run the crawler first, then briefs will report what changes.`, { userScoped: true });
        }

        const diff = diffSnapshots(previous, current);
        const summary = summarizeDiff(diff, entity.name);

        let body;
        if (diff.isBaseline) {
            body = summary; // baseline recorded
        } else if (!diff.hasChanges) {
            body = `No changes on ${entity.name}'s site since the last brief (as of ${String(current.takenAt).slice(0, 10)}). Nothing new to report.`;
        } else {
            body = `What's new for ${entity.name} (as of ${String(current.takenAt).slice(0, 10)}):\n\n${summary}`;
        }

        // Diff items already carry URLs + dates; expose them as citations too.
        const citations = [...diff.added, ...diff.changed].map((p) => ({
            title: `${p.title} — ${p.publishedDate ? "published " + String(p.publishedDate).slice(0, 10) : "fetched " + String(p.fetchedAt || current.takenAt).slice(0, 10)}`,
            url: p.url,
        }));

        return wrapUntrusted(`watchlist:${entity.slug}`, body, {
            userScoped: true,
            citations: citations.length ? citations.slice(0, 20) : undefined,
            hasChanges: diff.hasChanges,
            isBaseline: diff.isBaseline,
        });
    },
};
