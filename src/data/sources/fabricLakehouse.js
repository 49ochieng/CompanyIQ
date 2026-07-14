// Fabric lakehouse source — the SQL analytics endpoint, over TDS.
//
// IDENTITY: the SIGNED-IN USER. We authenticate by handing `mssql` an access
// token, never a client id/secret in the connection string. The token comes
// from `getToken(context)` — today that returns the user's delegated token from
// the bot's `fabric_sql` OAuth connection (audience https://database.windows.net/).
// Swapping identity later is a change to that ONE function, nothing else.
//
// Hard-won configuration details (do not "simplify" these):
//  - encrypt: true + trustServerCertificate: false is MANDATORY. Omitting it
//    fails the Entra handshake and surfaces as a generic login timeout that
//    looks exactly like a bad password.
//  - A fast 18456 login failure AFTER a token was successfully acquired means
//    Fabric-side authorization is missing (tenant setting / workspace grant),
//    NOT a bad credential. Do not rotate secrets chasing it.
//  - The TDS audience is https://database.windows.net/ — NOT
//    api.fabric.microsoft.com (that one is rejected by TDS; it is only for the
//    Fabric REST/MCP surface).
//  - Cold endpoints are slow to first connect. Warm up at startup and retry
//    real queries, but probe() must fail FAST so one dead source cannot stall
//    every user turn.
const sql = require("mssql");
const config = require("../../config");
const catalog = require("../catalogs/fabricLakehouse");
const { compile } = require("../queryCompiler");

const PROBE_TIMEOUT_MS = 10000; // fast-fail: a dead source must not stall a turn
const QUERY_TIMEOUT_MS = 60000;

// Fabric's SQL analytics endpoint speaks TDS and requires the standard SQL
// audience. api.fabric.microsoft.com is REJECTED here (proven by spike) — that
// audience is only for the Fabric REST / data-agent MCP surface.
const TDS_SCOPE = "https://database.windows.net/.default";

function isColdStartError(err) {
    const code = err && err.code;
    if (code === "ETIMEOUT" || code === "ESOCKET" || code === "ECONNCLOSED") return true;
    return /is not currently available|resuming|timeout/i.test(String((err && err.message) || ""));
}

/** True when the endpoint says "authenticated, but not authorized in Fabric". */
function isAuthorizationError(err) {
    const num = err && (err.number ?? (err.originalError && err.originalError.info && err.originalError.info.number));
    return num === 18456 || /login failed for user|not authorized/i.test(String((err && err.message) || ""));
}

function buildConfig(token) {
    return {
        server: config.fabricEndpoint,
        database: config.fabricDatabase,
        // Token-based auth: no client id/secret ever enters the connection.
        authentication: {
            type: "azure-active-directory-access-token",
            options: { token },
        },
        options: {
            encrypt: true, // MANDATORY
            trustServerCertificate: false, // MANDATORY
        },
        connectionTimeout: QUERY_TIMEOUT_MS,
        requestTimeout: QUERY_TIMEOUT_MS,
        pool: { max: 5, min: 0, idleTimeoutMillis: 300000 },
    };
}

/**
 * A pool is per-token (i.e. per user), because the connection carries identity.
 * Keyed by a short hash of the token so we don't hold the token as a key.
 */
const pools = new Map();
function poolKey(token) {
    let h = 0;
    for (let i = 0; i < token.length; i += 97) {
        h = (h * 31 + token.charCodeAt(i)) | 0;
    }
    return String(h);
}

async function connect(token, { timeoutMs } = {}) {
    const cfg = buildConfig(token);
    if (timeoutMs) {
        cfg.connectionTimeout = timeoutMs;
        cfg.requestTimeout = timeoutMs;
    }
    return new sql.ConnectionPool(cfg).connect();
}

async function getPool(token) {
    const key = poolKey(token);
    const existing = pools.get(key);
    if (existing) {
        return existing;
    }
    const p = connect(token).catch((err) => {
        pools.delete(key);
        throw err;
    });
    pools.set(key, p);
    return p;
}

module.exports = {
    name: "healthcare_fabric",
    kind: "fabric_lakehouse",
    identity: "user", // delegated — Fabric enforces the signed-in user's permissions
    label: "Healthcare lakehouse (Microsoft Fabric)",
    description:
        "Healthcare lakehouse: patients, providers, encounters, appointments, lab orders, lab results and clinical notes.",
    catalog,

    /** Configured only when the endpoint and database are set. */
    isConfigured() {
        return !!(config.fabricEndpoint && config.fabricDatabase);
    },

    /**
     * Seam for the local developer credential. Overridden in tests so the
     * "on Azure this must be unreachable" guard can be asserted without
     * touching the real credential chain.
     */
    _createDevCredential() {
        const { DefaultAzureCredential } = require("@azure/identity");
        return new DefaultAzureCredential();
    },

    /**
     * THE identity seam. The token always represents a PERSON.
     *
     * 1. In Teams: the signed-in user's delegated token from the bot's
     *    `fabric_sql` OAuth connection (audience https://database.windows.net/).
     * 2. Locally only (playground / harness, where there is no Teams SSO):
     *    the developer's OWN az-login identity, so local runs still exercise a
     *    real user's permissions.
     *
     * The local fallback is HARD-DISABLED on Azure. That guard matters: on
     * Azure, DefaultAzureCredential would return the app's managed identity,
     * which would silently turn this into an app-identity source and make every
     * user see identical data. That must never happen by accident.
     */
    async getToken(context) {
        if (context && typeof context.getAudienceToken === "function") {
            const token = await context.getAudienceToken(config.fabricSqlConnectionName);
            if (token) {
                return token;
            }
        }

        const onAzure = !!(process.env.RUNNING_ON_AZURE || process.env.WEBSITE_INSTANCE_ID);
        if (onAzure || !config.fabricLocalDevIdentity) {
            return undefined;
        }

        // Local developer identity — a real person, never a service principal.
        if (!this._devCredential) {
            this._devCredential = this._createDevCredential();
            console.log(
                JSON.stringify({
                    event: "fabric_local_identity",
                    note: "Using the local developer's signed-in identity for Fabric (no Teams SSO in this run). Disabled on Azure.",
                })
            );
        }
        try {
            const token = await this._devCredential.getToken(TDS_SCOPE);
            return token && token.token;
        } catch {
            return undefined;
        }
    },

    /** Fast, single-attempt health check. Never retries; never blocks a turn. */
    async probe(context) {
        const startedAt = Date.now();
        let token;
        try {
            token = await this.getToken(context);
        } catch {
            token = undefined;
        }
        if (!token) {
            return {
                ok: false,
                reason: "not_signed_in",
                message: "Sign in to use the healthcare lakehouse — it runs as you.",
                latencyMs: Date.now() - startedAt,
            };
        }
        let pool;
        try {
            pool = await connect(token, { timeoutMs: PROBE_TIMEOUT_MS });
            await pool.request().query("SELECT 1 AS ok");
            return { ok: true, latencyMs: Date.now() - startedAt };
        } catch (error) {
            return {
                ok: false,
                reason: isAuthorizationError(error) ? "not_authorized" : "unreachable",
                message: isAuthorizationError(error)
                    ? "Your account doesn't have access to the healthcare lakehouse in Fabric."
                    : "The Fabric lakehouse isn't reachable right now.",
                latencyMs: Date.now() - startedAt,
            };
        } finally {
            if (pool) await pool.close().catch(() => {});
        }
    },

    describeSchema() {
        return catalog;
    },

    compile(query) {
        return compile(query, catalog);
    },

    /** Execute a compiled query as the signed-in user. */
    async execute(compiled, context) {
        const token = await this.getToken(context);
        if (!token) {
            return {
                error: "auth_required",
                connectionName: config.fabricSqlConnectionName,
                message: "Sign in to query the healthcare lakehouse — it runs with your own permissions.",
            };
        }

        const run = async () => {
            const pool = await getPool(token);
            const request = pool.request();
            request.input("rowLimit", sql.Int, compiled.limit + 1);
            for (const input of compiled.inputs) {
                request.input(input.name, input.sqlType, input.value);
            }
            const result = await request.query(compiled.statement);
            return result.recordset;
        };

        try {
            return { rows: await run() };
        } catch (error) {
            // A cold endpoint gets one transparent retry, like Azure SQL.
            if (isColdStartError(error)) {
                pools.delete(poolKey(token));
                try {
                    return { rows: await run() };
                } catch (retryError) {
                    return { error: classify(retryError) };
                }
            }
            return { error: classify(error) };
        }
    },

    /** Resume a cold endpoint at startup so the first user question is fast. */
    async warmUp(context) {
        const result = await this.probe(context);
        console.log(
            JSON.stringify({
                event: "source_warmup",
                source: this.name,
                ok: result.ok,
                reason: result.reason,
                latencyMs: result.latencyMs,
            })
        );
        return result;
    },
};

function classify(error) {
    if (isAuthorizationError(error)) {
        return {
            error: "access_denied",
            message:
                "Your account doesn't have access to the healthcare lakehouse in Fabric. " +
                "Relay this to the user; do not retry.",
        };
    }
    return {
        error: "source_unavailable",
        message: "The Fabric lakehouse isn't reachable right now — please try again in a moment.",
    };
}
