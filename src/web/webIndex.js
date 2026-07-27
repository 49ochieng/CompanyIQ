// Azure AI Search plumbing for crawled web content + dated snapshots.
// Two indexes (both separate from the document RAG index):
//   companyiq-web            — one doc per crawled page (entity, url, title,
//                              content, fetchedAt, publishedDate, contentHash)
//   companyiq-web-snapshots  — one doc per (entity, takenAt) crawl snapshot,
//                              body = JSON page map, for diffing over time.
// Keys use the admin key (write) via config; watchlist_search reads with the
// query key. Content is public web data — no per-user trimming applies.
"use strict";
const crypto = require("crypto");
const { AzureKeyCredential, SearchClient, SearchIndexClient } = require("@azure/search-documents");
const config = require("../config");

function idFor(entitySlug, url) {
    return crypto.createHash("sha1").update(`${entitySlug}|${url}`).digest("hex");
}

// Azure AI Search document keys allow only letters/digits/_/-/=. Timestamps
// contain ':' and '.', so snapshot keys are sanitized to a safe form.
function snapshotId(entitySlug, takenAt) {
    return `${entitySlug}_${String(takenAt).replace(/[^0-9A-Za-z]/g, "")}`;
}

function adminClient(indexName) {
    return new SearchClient(config.azureSearchEndpoint, indexName, new AzureKeyCredential(config.azureSearchAdminKey));
}
function queryClient(indexName) {
    return new SearchClient(config.azureSearchEndpoint, indexName, new AzureKeyCredential(config.azureSearchKey));
}

async function ensureIndexes() {
    const client = new SearchIndexClient(config.azureSearchEndpoint, new AzureKeyCredential(config.azureSearchAdminKey));
    await client.createOrUpdateIndex({
        name: config.webIndexName,
        fields: [
            { name: "id", type: "Edm.String", key: true, filterable: true },
            { name: "entity", type: "Edm.String", filterable: true, facetable: true },
            { name: "url", type: "Edm.String", filterable: true },
            { name: "title", type: "Edm.String", searchable: true },
            { name: "content", type: "Edm.String", searchable: true, analyzerName: "en.lucene" },
            { name: "fetchedAt", type: "Edm.DateTimeOffset", filterable: true, sortable: true },
            { name: "publishedDate", type: "Edm.DateTimeOffset", filterable: true, sortable: true },
            { name: "contentHash", type: "Edm.String", filterable: true },
        ],
    });
    await client.createOrUpdateIndex({
        name: config.webSnapshotIndexName,
        fields: [
            { name: "id", type: "Edm.String", key: true, filterable: true },
            { name: "entity", type: "Edm.String", filterable: true },
            { name: "takenAt", type: "Edm.DateTimeOffset", filterable: true, sortable: true },
            { name: "complete", type: "Edm.Boolean", filterable: true },
            { name: "pagesJson", type: "Edm.String" }, // serialized snapshot.pages
        ],
    });
}

/** Upsert crawled pages for an entity. `content` is capped to keep docs small. */
async function upsertPages(entitySlug, pages) {
    if (pages.length === 0) return;
    const client = adminClient(config.webIndexName);
    const docs = pages.map((p) => ({
        id: idFor(entitySlug, p.url),
        entity: entitySlug,
        url: p.url,
        title: p.title,
        content: (p.text || "").slice(0, 32000),
        fetchedAt: p.fetchedAt,
        publishedDate: p.publishedDate || null,
        contentHash: p.hash,
    }));
    await client.mergeOrUploadDocuments(docs);
}

async function saveSnapshot(entitySlug, snapshot) {
    const client = adminClient(config.webSnapshotIndexName);
    await client.mergeOrUploadDocuments([
        {
            id: snapshotId(entitySlug, snapshot.takenAt),
            entity: entitySlug,
            takenAt: snapshot.takenAt,
            complete: snapshot.complete !== false,
            pagesJson: JSON.stringify(snapshot.pages),
        },
    ]);
}

/** The most recent snapshot strictly before `before` (or the latest). */
async function loadSnapshot(entitySlug, before) {
    const client = queryClient(config.webSnapshotIndexName);
    let filter = `entity eq '${entitySlug}'`;
    // OData DateTimeOffset comparisons need ISO 8601. The SDK deserializes
    // takenAt to a JS Date, so callers may pass a Date here — coerce it.
    if (before) filter += ` and takenAt lt ${new Date(before).toISOString()}`;
    const results = await client.search("*", { filter, orderBy: ["takenAt desc"], top: 1 });
    for await (const r of results.results) {
        const d = r.document;
        return {
            entity: entitySlug,
            takenAt: new Date(d.takenAt).toISOString(),
            complete: d.complete !== false,
            pages: JSON.parse(d.pagesJson || "{}"),
        };
    }
    return null;
}

/** Keyword search over an entity's crawled pages; returns cited, dated hits. */
async function searchPages(entitySlug, query, top = 5) {
    const client = queryClient(config.webIndexName);
    const results = await client.search(query, {
        filter: `entity eq '${entitySlug}'`,
        top,
        select: ["url", "title", "content", "fetchedAt", "publishedDate"],
    });
    const hits = [];
    for await (const r of results.results) {
        const d = r.document;
        hits.push({
            url: d.url,
            title: d.title,
            snippet: (d.content || "").slice(0, 400),
            publishedDate: d.publishedDate || null,
            fetchedAt: d.fetchedAt,
        });
    }
    return hits;
}

module.exports = { ensureIndexes, upsertPages, saveSnapshot, loadSnapshot, searchPages, idFor };
