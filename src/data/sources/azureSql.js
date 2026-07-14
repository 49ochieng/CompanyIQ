// Azure SQL source — the company product/assortment data (sbs_test).
//
// IDENTITY: the application's least-privilege login (SELECT on sbs_test only).
// Row-level access is enforced by the compiler, which injects
// `retailer_id = @userScope` into EVERY statement. That predicate is mandatory
// and unconditional; nothing in the multi-source work weakens it.
const db = require("../db");
const { sql } = db;
const catalog = require("../catalogs/azureSql");
const { compile } = require("../queryCompiler");
const config = require("../../config");

const PROBE_TIMEOUT_MS = 10000;

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

module.exports = {
    name: "company_sql",
    kind: "azure_sql",
    identity: "app", // app login, but every row is filtered by the user's scope
    label: "Company product data (Azure SQL)",
    description:
        "The company's own product/assortment data: items, brands, UPCs, suppliers, ingredients, country of origin. " +
        "Every query is automatically restricted to the signed-in user's own retailer assortment.",
    catalog,

    isConfigured() {
        return !!(config.sqlServer && config.sqlDatabase) || !!config.sqlConnectionString;
    },

    /** Fast, single-attempt health check — never retries, never stalls a turn. */
    async probe() {
        const startedAt = Date.now();
        try {
            const pool = await db.getPool();
            const req = pool.request();
            req.timeout = PROBE_TIMEOUT_MS;
            await req.query("SELECT 1 AS ok");
            return { ok: true, latencyMs: Date.now() - startedAt };
        } catch (error) {
            return {
                ok: false,
                reason: db.isColdStartError(error) ? "waking" : "unreachable",
                message: "The company database isn't reachable right now.",
                latencyMs: Date.now() - startedAt,
            };
        }
    },

    describeSchema() {
        return catalog;
    },

    compile(query) {
        return compile(query, catalog);
    },

    async execute(compiled, context) {
        const resolved = resolveScope(context);
        if (resolved.error) {
            return { error: resolved.error };
        }
        const scope = resolved.scope;

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
            request.input("rowLimit", sql.Int, compiled.limit + 1);
            // The scope value the compiler's mandatory predicate binds against.
            request.input("userScope", sql.VarChar(50), scope);
            for (const input of compiled.inputs) {
                request.input(input.name, input.sqlType, input.value);
            }
            const result = await request.query(compiled.statement);
            return { rows: result.recordset, scope };
        } catch (error) {
            const cold = db.isColdStartError(error);
            console.log(
                JSON.stringify({
                    event: "db_error",
                    source: "company_sql",
                    coldStart: cold,
                    errorClass: error.code || error.name || "Error",
                    detail: String(error.message || error).slice(0, 300),
                })
            );
            return {
                error: {
                    error: "database_unavailable",
                    message: cold
                        ? "The company database is waking up and didn't respond in time — please ask again in a few seconds."
                        : "The company database is temporarily unavailable — please try again in a moment.",
                },
            };
        }
    },

    async warmUp() {
        const ok = await db.warmUp("startup");
        if (ok) db.startKeepAlive();
        return { ok };
    },
};
