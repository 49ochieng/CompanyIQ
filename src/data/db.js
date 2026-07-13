const sql = require("mssql");
const config = require("../config");

let poolPromise;
let keepAliveTimer;

// Serverless Azure SQL auto-pauses when idle; the first query after a pause
// waits tens of seconds for a resume. We warm the pool at startup and ping it
// on an interval so the database is never paused mid-session.
const KEEPALIVE_INTERVAL_MS = 4 * 60 * 1000;

// Admin mode is opt-in and used only by the seed/introspect CLI scripts.
// The bot process never sets it, so it can only ever connect as the
// least-privilege application login.
let useAdminCredential = false;
function useAdminCredentials() {
    if (!config.sqlAdminUser || !config.sqlAdminPassword) {
        throw new Error(
            "Admin SQL credentials are not configured. Set AZURE_SQL_ADMIN_USERNAME / AZURE_SQL_ADMIN_PASSWORD " +
            "(these are for db:seed and db:introspect only — the bot must not use them)."
        );
    }
    useAdminCredential = true;
}

function buildPoolConfig() {
    if (config.sqlServer && config.sqlDatabase) {
        return {
            server: config.sqlServer,
            database: config.sqlDatabase,
            user: useAdminCredential ? config.sqlAdminUser : config.sqlUser,
            password: useAdminCredential ? config.sqlAdminPassword : config.sqlPassword,
            options: {
                encrypt: true, // required by Azure SQL
                trustServerCertificate: false,
            },
            // A cold serverless database can take tens of seconds to resume.
            connectionTimeout: 45000,
            requestTimeout: 45000,
            // Keep one connection alive so the pool itself doesn't go idle.
            pool: { max: 10, min: 1, idleTimeoutMillis: 300000 },
        };
    }
    if (config.sqlConnectionString) {
        return config.sqlConnectionString;
    }
    throw new Error(
        "SQL is not configured. Set AZURE_SQL_SERVER/AZURE_SQL_DATABASE/AZURE_SQL_USERNAME/AZURE_SQL_PASSWORD (or SQL_CONNECTION_STRING)."
    );
}

/** True when the failure looks like a paused/cold serverless database. */
function isColdStartError(err) {
    const code = err && err.code;
    if (code === "ETIMEOUT" || code === "ESOCKET" || code === "ECONNCLOSED") {
        return true;
    }
    // Azure SQL returns 40613 while a database is resuming.
    return /is not currently available|40613|resuming/i.test(String((err && err.message) || ""));
}

async function connectWithRetry() {
    // One retry after a pause covers the serverless auto-resume window.
    try {
        return await new sql.ConnectionPool(buildPoolConfig()).connect();
    } catch (err) {
        if (!isColdStartError(err)) {
            throw err;
        }
        console.log(JSON.stringify({ event: "db_connect_retry", reason: err.code || "resuming" }));
        await new Promise((r) => setTimeout(r, 8000));
        return await new sql.ConnectionPool(buildPoolConfig()).connect();
    }
}

/**
 * Returns the shared connection pool, creating it on first use.
 * @returns {Promise<sql.ConnectionPool>}
 */
function getPool() {
    if (!poolPromise) {
        poolPromise = connectWithRetry().catch((err) => {
            poolPromise = undefined; // allow retry on next call
            throw err;
        });
    }
    return poolPromise;
}

/** True when a pool is already connected (so a query will be instant). */
function isWarm() {
    return !!poolPromise;
}

/**
 * Connect and run a trivial query so the database is resumed and the pool is
 * hot before the first user question arrives.
 * @param {string} reason For the audit log ('startup' | 'keepalive').
 */
async function warmUp(reason = "startup") {
    const startedAt = Date.now();
    try {
        const pool = await getPool();
        await pool.request().query("SELECT 1 AS warm");
        console.log(
            JSON.stringify({ event: "db_warmup", reason, ok: true, durationMs: Date.now() - startedAt })
        );
        return true;
    } catch (error) {
        console.log(
            JSON.stringify({
                event: "db_warmup",
                reason,
                ok: false,
                durationMs: Date.now() - startedAt,
                error: String(error.message || error).slice(0, 200),
            })
        );
        return false;
    }
}

/** Start the keep-alive ping (SELECT 1 every 4 minutes). */
function startKeepAlive() {
    if (keepAliveTimer || !config.dbKeepAlive) {
        return;
    }
    keepAliveTimer = setInterval(() => {
        warmUp("keepalive").catch(() => {});
    }, KEEPALIVE_INTERVAL_MS);
    // Don't hold the process open on shutdown.
    if (typeof keepAliveTimer.unref === "function") {
        keepAliveTimer.unref();
    }
}

function stopKeepAlive() {
    if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = undefined;
    }
}

async function closePool() {
    stopKeepAlive();
    if (poolPromise) {
        const pool = await poolPromise.catch(() => undefined);
        poolPromise = undefined;
        if (pool) {
            await pool.close();
        }
    }
}

module.exports = {
    sql,
    getPool,
    closePool,
    warmUp,
    startKeepAlive,
    stopKeepAlive,
    isWarm,
    isColdStartError,
    useAdminCredentials,
    KEEPALIVE_INTERVAL_MS,
};
