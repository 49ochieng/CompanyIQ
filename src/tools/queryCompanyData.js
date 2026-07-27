// The ONE data tool. It now spans multiple sources, but the model still sees a
// single tool: it names a `source` (from the catalog it was shown) and fills a
// structured query object. It never emits SQL text.
//
// Each source owns its own compiler pass and its own scope policy:
//   company_sql        — row-level predicate injected into EVERY statement
//   healthcare_fabric  — runs on the user's own delegated token; Fabric enforces
//                        their permissions in the engine
//
// Cross-source queries are rejected: a single query may never reference tables
// from more than one source. A question spanning both is answered with two tool
// calls composed in prose.
const sources = require("../data/sources");

function sourceNames() {
    return sources.getSourceNames();
}

/**
 * Observability for stale-parameter contamination: note when a filter value the
 * model supplied does not appear in the user's current message. Legitimate
 * follow-ups ("what about wheat?") carry values forward, so this is logged for
 * audit rather than rejected — the prompt forbids unreferenced carry-over and a
 * regression test covers the failure case.
 */
function filterProvenance(query, userText) {
    const text = String(userText || "").toLowerCase();
    if (!text) return undefined;
    const carried = [];
    for (const f of query.filters || []) {
        const values = Array.isArray(f.value) ? f.value : [f.value];
        for (const v of values) {
            const s = String(v ?? "").toLowerCase().trim();
            if (s.length > 2 && !text.includes(s)) {
                carried.push({ column: f.column, value: s });
            }
        }
    }
    return carried.length > 0 ? carried : undefined;
}

module.exports = {
    name: "queryCompanyData",
    description:
        "Query the organization's structured data — the ONLY source of product, item, supplier, ingredient, " +
        "country-of-origin, and count/breakdown facts (never answer those from documents, the web, or your own " +
        "knowledge). Choose the `source` that holds the data the question is " +
        "about (the available sources, their tables and columns are listed in your instructions), then build a " +
        "structured query against THAT source's schema. Build it fresh from the user's current question — never " +
        "reuse filters from earlier turns unless the user refers back to them. One query may only use tables from " +
        "ONE source; if a question spans two, make two separate calls.",
    parameters: {
        type: "object",
        properties: {
            source: {
                type: "string",
                description: "Which data source to query.",
                enum: sourceNames(),
            },
            table: { type: "string", description: "The table to query, from that source's schema." },
            select: {
                type: "array",
                items: { type: "string" },
                description: "Columns to return. Omit for a sensible default. Ignored for aggregate queries.",
            },
            joins: {
                type: "array",
                items: { type: "string" },
                description: "Other tables (from the SAME source) to join in.",
            },
            filters: {
                type: "array",
                description: "Filter conditions, ANDed. Build these ONLY from the current question.",
                items: {
                    type: "object",
                    properties: {
                        column: { type: "string", description: "Column to filter on." },
                        operator: {
                            type: "string",
                            enum: ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "starts_with", "in", "between"],
                            description: "Comparison. Use 'contains' for substring search.",
                        },
                        value: { description: "Value to compare against. An array for 'in' and 'between'." },
                    },
                    required: ["column", "operator", "value"],
                },
            },
            groupBy: { type: "array", items: { type: "string" }, description: "Columns to group by." },
            aggregations: {
                type: "array",
                description: "Aggregates, e.g. a count per group or a total.",
                items: {
                    type: "object",
                    properties: {
                        fn: { type: "string", enum: ["count", "sum", "avg", "min", "max"] },
                        column: { type: "string", description: "Column to aggregate, or '*' for a row count." },
                    },
                    required: ["fn"],
                },
            },
            orderBy: {
                type: "object",
                properties: {
                    column: { type: "string" },
                    direction: { type: "string", enum: ["asc", "desc"] },
                },
            },
            limit: { type: "integer", description: "Maximum rows to return (capped)." },
        },
        required: ["source", "table"],
    },

    async handler(args, context) {
        const startedAt = Date.now();

        const source = sources.getSource(args.source);
        if (!source) {
            return {
                error: "invalid_query",
                reason: `unknown source '${String(args.source)}' — available: ${sourceNames().join(", ")}`,
                instruction:
                    "Tell the user plainly which data is available and that this question can't be answered from it.",
            };
        }

        // Cross-source guard: every table named must belong to THIS source.
        const referenced = [args.table, ...(args.joins || [])].filter(Boolean);
        const foreign = referenced.filter((t) => !source.catalog.TABLES[t]);
        if (foreign.length > 0) {
            const elsewhere = foreign.filter((t) =>
                sources.getSources().some((s) => s.name !== source.name && s.catalog.TABLES[t])
            );
            const reason = elsewhere.length > 0
                ? `table(s) ${elsewhere.join(", ")} belong to a different source — a single query cannot span sources. ` +
                  "Make one call per source and combine the answers yourself."
                : `unknown table(s) ${foreign.join(", ")} in source '${source.name}'`;
            console.log(JSON.stringify({ event: "db_query_rejected", source: source.name, reason }));
            return { error: "invalid_query", reason, instruction: "Do not approximate with a different query." };
        }

        const compiled = source.compile(args);
        if (!compiled.ok) {
            console.log(
                JSON.stringify({
                    event: "db_query_rejected",
                    conversationId: context && context.conversationId,
                    source: source.name,
                    reason: compiled.reason,
                })
            );
            return {
                error: "invalid_query",
                reason: compiled.reason,
                instruction:
                    "That query doesn't match the schema. Tell the user plainly what the data can and cannot " +
                    "answer — do not approximate with a different query.",
            };
        }

        const outcome = await source.execute(compiled, context);
        if (outcome.error) {
            return outcome.error.error ? outcome.error : { ...outcome.error };
        }

        let rows = outcome.rows;
        const truncated = rows.length > compiled.limit;
        if (truncated) {
            rows = rows.slice(0, compiled.limit);
        }

        console.log(
            JSON.stringify({
                event: "db_query",
                conversationId: context && context.conversationId,
                source: source.name,
                identity: source.identity,
                table: args.table,
                sql: compiled.statement.replace(/\s+/g, " "),
                parameters: compiled.inputs.map((i) => ({ name: i.name, value: i.value })),
                scope: outcome.scope,
                scopePolicy: compiled.scopePolicy,
                rowCount: rows.length,
                truncated,
                carriedFilters: filterProvenance(args, context && context.userText),
                durationMs: Date.now() - startedAt,
            })
        );

        return {
            source: source.name,
            sourceLabel: source.label,
            sourceIdentity: source.identity,
            table: args.table,
            columns: compiled.outputColumns,
            scope: outcome.scope,
            rowCount: rows.length,
            rows,
            ...(rows.length === 0 && {
                note: "No rows matched. Tell the user plainly that nothing matched — never fill in an answer from your own knowledge.",
            }),
            ...(truncated && { note: `Showing the first ${compiled.limit} rows.` }),
        };
    },
};
