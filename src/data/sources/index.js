// The data source registry. A source is a first-class concept: it owns its
// connection, its identity model, its catalog, and its scope policy.
//
// Every source's catalog MUST declare a scope policy. A source whose row-level
// access rules are undefined fails HERE, at startup — never silently at query
// time.
const azureSql = require("./azureSql");
const fabricLakehouse = require("./fabricLakehouse");
const { assertScopePolicy } = require("../queryCompiler");

const ALL = [azureSql, fabricLakehouse];

const REQUIRED = ["name", "kind", "identity", "label", "catalog"];
const REQUIRED_FNS = ["probe", "describeSchema", "compile", "execute", "isConfigured"];

function validateSource(source) {
    for (const field of REQUIRED) {
        if (!source[field]) {
            throw new Error(`Data source is missing '${field}': ${source.name || "<unnamed>"}`);
        }
    }
    for (const fn of REQUIRED_FNS) {
        if (typeof source[fn] !== "function") {
            throw new Error(`Data source '${source.name}' must implement ${fn}()`);
        }
    }
    if (!["app", "user"].includes(source.identity)) {
        throw new Error(`Data source '${source.name}' must declare identity: "app" | "user"`);
    }
    // Throws when the catalog has no declared scope policy.
    assertScopePolicy(source.catalog);
}

// Validate every source at load time, configured or not — a broken source
// definition is a bug we want to fail on immediately, not on first use.
for (const source of ALL) {
    validateSource(source);
}

/** Sources that have their configuration present. */
function getSources() {
    return ALL.filter((s) => s.isConfigured());
}

function getSource(name) {
    return getSources().find((s) => s.name === name);
}

function getSourceNames() {
    return getSources().map((s) => s.name);
}

/** Every configured source, including ones that are configured but unhealthy. */
function listAll() {
    return ALL.map((s) => ({
        name: s.name,
        kind: s.kind,
        identity: s.identity,
        label: s.label,
        description: s.description,
        configured: s.isConfigured(),
        scopePolicy: s.catalog.scope.policy,
        tableCount: Object.keys(s.catalog.TABLES).length,
    }));
}

/** Render every configured catalog for the system prompt. */
function describeAllForPrompt() {
    const blocks = [];
    for (const source of getSources()) {
        const scopeNote =
            source.catalog.scope.policy === "row_predicate"
                ? "Scoping: automatically restricted to the signed-in user's own assortment."
                : "Scoping: runs with the signed-in user's own permissions in Fabric; they see exactly what they are entitled to see.";
        blocks.push(
            `SOURCE "${source.name}" — ${source.label}\n` +
            `${source.description}\n${scopeNote}\n` +
            renderCatalog(source.catalog)
        );
    }
    return blocks.join("\n\n");
}

function renderCatalog(catalog) {
    const lines = [];
    for (const [tableName, table] of Object.entries(catalog.TABLES)) {
        lines.push(`  - ${tableName}: ${table.description}`);
        for (const [colName, col] of Object.entries(table.columns)) {
            const caps = [];
            if (col.filterable) caps.push("filterable");
            if (col.groupable) caps.push("groupable");
            if (col.aggregatable) caps.push("aggregatable");
            lines.push(`      - ${colName} (${col.type}${caps.length ? ", " + caps.join("/") : ""}): ${col.description}`);
        }
    }
    const joins = Object.keys(catalog.JOINS || {});
    if (joins.length > 0) {
        const pairs = [...new Set(joins.map((k) => k.split("->").sort().join(" ↔ ")))];
        lines.push(`  Joins available: ${pairs.join(", ")}`);
    }
    return lines.join("\n");
}

/** Warm every configured source at startup and log what loaded. */
async function initSources(context) {
    const sources = getSources();
    const summary = [];
    for (const source of sources) {
        let probe = { ok: false, reason: "not_probed" };
        try {
            probe = source.warmUp ? await source.warmUp(context) : await source.probe(context);
        } catch (error) {
            probe = { ok: false, reason: "error", message: String(error.message).slice(0, 120) };
        }
        summary.push({
            source: source.name,
            kind: source.kind,
            identity: source.identity,
            scopePolicy: source.catalog.scope.policy,
            tables: Object.keys(source.catalog.TABLES).length,
            healthy: !!probe.ok,
            reason: probe.ok ? undefined : probe.reason,
        });
    }
    console.log(JSON.stringify({ event: "sources_init", sources: summary }));
    return summary;
}

module.exports = {
    getSources,
    getSource,
    getSourceNames,
    listAll,
    describeAllForPrompt,
    initSources,
    validateSource,
};
