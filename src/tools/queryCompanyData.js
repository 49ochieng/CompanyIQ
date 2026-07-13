// Company data tool (v2, schema-driven).
//
// The model fills a STRUCTURED QUERY OBJECT — table, select, filters, joins,
// groupBy, aggregations, orderBy, limit — using only names from the catalog.
// It never emits SQL text. src/data/queryCompiler.js compiles that object into
// parameterized T-SQL and appends the row-level scope predicate to EVERY
// statement it produces.
//
// The tool is stateless: each call is compiled from the arguments given, with
// no memory of previous turns.
const db = require("../data/db");
const { sql } = db;
const catalog = require("../data/catalog");
const { compile } = require("../data/queryCompiler");
const config = require("../config");

const MAX_ROWS = catalog.MAX_ROWS;

function resolveScope(context) {
    if (context && context.userScope) {
        return { scope: context.userScope };
    }
    if (context && context.user) {
        return {
            error: {
                error: "no_data_scope",
                message:
                    "Your account doesn't have a company data scope assigned yet, so I can't run data " +
                    "queries for you — please ask your administrator to grant access.",
            },
        };
    }
    if (config.devUserScope) {
        return { scope: config.devUserScope };
    }
    return {
        error: {
            error: "no_data_scope",
            message: "Please sign in first so I can look up company data for your account.",
        },
    };
}

/**
 * Observability for stale-parameter contamination: note when a filter value
 * the model supplied does not appear in the user's current message. Legitimate
 * follow-ups ("what about wheat?") carry values forward, so this is logged for
 * audit rather than rejected — the prompt forbids unreferenced carry-over and
 * a regression test covers the failure case.
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
        "Query the company's product/item and supplier data by building a structured query against the " +
        "schema shown in your instructions. Use for ANY question about items, brands, UPCs, suppliers, " +
        "ingredients, country of origin, counts or breakdowns. Build the query fresh from the user's " +
        "current question — never reuse filters from earlier turns unless the user refers to them.",
    parameters: {
        type: "object",
        properties: {
            table: {
                type: "string",
                description: "The table to query from.",
                enum: Object.keys(catalog.TABLES),
            },
            select: {
                type: "array",
                items: { type: "string" },
                description:
                    "Columns to return. Omit for a sensible default set. Ignored for aggregate queries.",
            },
            joins: {
                type: "array",
                items: { type: "string", enum: Object.keys(catalog.TABLES) },
                description:
                    "Other tables to join in, to select or filter their columns (e.g. query 'items' and join 'suppliers' to show the supplier name).",
            },
            filters: {
                type: "array",
                description: "Filter conditions, ANDed together. Build these ONLY from the current question.",
                items: {
                    type: "object",
                    properties: {
                        column: { type: "string", description: "Column to filter on." },
                        operator: {
                            type: "string",
                            enum: Object.keys(catalog.OPERATORS),
                            description:
                                "Comparison. Use 'contains' for substring search (e.g. an ingredient inside the ingredients statement).",
                        },
                        value: {
                            description: "Value to compare against. An array for 'in' and 'between'.",
                        },
                    },
                    required: ["column", "operator", "value"],
                },
            },
            groupBy: {
                type: "array",
                items: { type: "string" },
                description: "Columns to group by, for breakdowns.",
            },
            aggregations: {
                type: "array",
                description: "Aggregates to compute, e.g. a count per group, or a total count.",
                items: {
                    type: "object",
                    properties: {
                        fn: { type: "string", enum: Object.keys(catalog.AGGREGATIONS) },
                        column: {
                            type: "string",
                            description: "Column to aggregate, or '*' for count of rows.",
                        },
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
                description: "Sort order.",
            },
            limit: {
                type: "integer",
                description: `Maximum rows to return (capped at ${MAX_ROWS}).`,
            },
        },
        required: ["table"],
    },

    async handler(args, context) {
        const startedAt = Date.now();

        const resolved = resolveScope(context);
        if (resolved.error) {
            return resolved.error;
        }
        const scope = resolved.scope;

        // Compile: unknown table/column/operator/join/aggregation is rejected
        // here, and the scope predicate is injected unconditionally.
        const compiled = compile(args);
        if (!compiled.ok) {
            console.log(
                JSON.stringify({
                    event: "db_query_rejected",
                    conversationId: context && context.conversationId,
                    reason: compiled.reason,
                })
            );
            return {
                error: "invalid_query",
                reason: compiled.reason,
                instruction:
                    "That query doesn't match the company database schema. Tell the user plainly what the " +
                    "database can and cannot answer — do not approximate with a different query.",
            };
        }

        let rows;
        try {
            let pool;
            if (db.isWarm()) {
                pool = await db.getPool();
            } else {
                if (context && typeof context.notify === "function") {
                    await context.notify("Waking the database, one moment…");
                }
                pool = await db.getPool();
            }

            const request = pool.request();
            request.input("rowLimit", sql.Int, compiled.limit + 1); // +1 detects truncation
            request.input("userScope", sql.VarChar(50), scope);
            for (const input of compiled.inputs) {
                request.input(input.name, input.sqlType, input.value);
            }
            const result = await request.query(compiled.statement);
            rows = result.recordset;
        } catch (error) {
            const cold = db.isColdStartError(error);
            console.log(
                JSON.stringify({
                    event: "db_error",
                    conversationId: context && context.conversationId,
                    coldStart: cold,
                    errorClass: error.code || error.name || "Error",
                    detail: String(error.message || error).slice(0, 300),
                    durationMs: Date.now() - startedAt,
                })
            );
            return {
                error: "database_unavailable",
                message: cold
                    ? "The company database is waking up and didn't respond in time — please ask again in a few seconds."
                    : "The company database is temporarily unavailable — please try again in a moment.",
            };
        }

        const truncated = rows.length > compiled.limit;
        if (truncated) {
            rows = rows.slice(0, compiled.limit);
        }

        // Audit: the exact statement executed, its scope, and the outcome.
        console.log(
            JSON.stringify({
                event: "db_query",
                conversationId: context && context.conversationId,
                table: args.table,
                sql: compiled.statement.replace(/\s+/g, " "),
                parameters: compiled.inputs.map((i) => ({ name: i.name, value: i.value })),
                scope,
                rowCount: rows.length,
                truncated,
                carriedFilters: filterProvenance(args, context && context.userText),
                durationMs: Date.now() - startedAt,
            })
        );

        return {
            table: args.table,
            columns: compiled.outputColumns,
            scope,
            rowCount: rows.length,
            rows,
            ...(rows.length === 0 && {
                note: "No rows matched. Tell the user plainly that nothing in the company database matches — never fill in an answer from your own knowledge.",
            }),
            ...(truncated && { note: `Showing the first ${compiled.limit} rows.` }),
        };
    },
};
