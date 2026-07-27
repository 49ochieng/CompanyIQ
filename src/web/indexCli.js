// `npm run web:index [entityName]` — crawl watchlist entities (or armely.com via
// a WATCHLIST self-entry), index pages into Azure AI Search, and append a dated
// snapshot for diffing. Re-runnable and incremental (merge/upsert). Logs a
// concise per-entity summary including the diff vs the previous snapshot.
"use strict";
const { getEntities, findEntity } = require("./watchlist");
const { crawl } = require("./crawler");
const { ensureIndexes, upsertPages, saveSnapshot, loadSnapshot } = require("./webIndex");
const { buildSnapshot, diffSnapshots } = require("./snapshot");

async function indexEntity(entity) {
    const startedAt = Date.now();
    const result = await crawl(entity);
    await upsertPages(entity.slug, result.pages);

    const prev = await loadSnapshot(entity.slug); // latest existing, before we save the new one
    const snapshot = buildSnapshot(entity.slug, result.pages, undefined, !result.truncated);
    await saveSnapshot(entity.slug, snapshot);
    const diff = diffSnapshots(prev, snapshot);

    console.log(
        JSON.stringify({
            event: "web_index",
            entity: entity.slug,
            fetched: result.fetched,
            skipped: result.skipped,
            pages: result.pages.length,
            complete: !result.truncated,
            baseline: diff.isBaseline,
            added: diff.added.length,
            changed: diff.changed.length,
            removed: diff.removed.length,
            suppressed: diff.suppressed || 0,
            durationMs: Date.now() - startedAt,
        })
    );
    return diff;
}

async function main() {
    const only = process.argv[2];
    const entities = only ? [findEntity(only)].filter(Boolean) : getEntities();
    if (entities.length === 0) {
        console.error(only ? `No watchlist entity matches '${only}'.` : "WATCHLIST is empty — nothing to crawl.");
        process.exit(1);
    }
    await ensureIndexes();
    for (const entity of entities) {
        try {
            await indexEntity(entity);
        } catch (error) {
            console.error(`Crawl/index failed for ${entity.slug}: ${error.message}`);
        }
    }
}

if (require.main === module) {
    main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { indexEntity, main };
