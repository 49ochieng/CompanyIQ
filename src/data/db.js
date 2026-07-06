const sql = require("mssql");
const config = require("../config");

let poolPromise;

function buildPoolConfig() {
    if (config.sqlServer && config.sqlDatabase) {
        return {
            server: config.sqlServer,
            database: config.sqlDatabase,
            user: config.sqlUser,
            password: config.sqlPassword,
            options: {
                encrypt: true, // required by Azure SQL
                trustServerCertificate: false,
            },
            pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
        };
    }
    if (config.sqlConnectionString) {
        return config.sqlConnectionString;
    }
    throw new Error(
        "SQL is not configured. Set AZURE_SQL_SERVER/AZURE_SQL_DATABASE/AZURE_SQL_USERNAME/AZURE_SQL_PASSWORD (or SQL_CONNECTION_STRING)."
    );
}

/**
 * Returns the shared connection pool, creating it on first use.
 * @returns {Promise<sql.ConnectionPool>}
 */
function getPool() {
    if (!poolPromise) {
        poolPromise = new sql.ConnectionPool(buildPoolConfig())
            .connect()
            .catch((err) => {
                poolPromise = undefined; // allow retry on next call
                throw err;
            });
    }
    return poolPromise;
}

async function closePool() {
    if (poolPromise) {
        const pool = await poolPromise.catch(() => undefined);
        poolPromise = undefined;
        if (pool) {
            await pool.close();
        }
    }
}

module.exports = { sql, getPool, closePool };
