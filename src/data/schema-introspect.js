// CLI: npm run db:introspect
// Connects to the configured SQL database, writes src/data/schema-snapshot.json
// (tables, columns, types, approximate row counts), and prints a summary.
// The snapshot is gitignored: design intents against it, don't commit it.
const fs = require("fs");
const path = require("path");
const { getPool, closePool } = require("./db");

async function main() {
    const pool = await getPool();

    const result = await pool.request().query(`
        SELECT
            s.name AS schema_name,
            t.name AS table_name,
            c.name AS column_name,
            ty.name AS data_type,
            c.max_length,
            c.is_nullable,
            p.rows AS row_count
        FROM sys.tables t
        JOIN sys.schemas s ON t.schema_id = s.schema_id
        JOIN sys.columns c ON c.object_id = t.object_id
        JOIN sys.types ty ON ty.user_type_id = c.user_type_id
        JOIN (
            SELECT object_id, SUM(rows) AS rows
            FROM sys.partitions
            WHERE index_id IN (0, 1)
            GROUP BY object_id
        ) p ON p.object_id = t.object_id
        ORDER BY s.name, t.name, c.column_id
    `);

    const tables = {};
    for (const row of result.recordset) {
        const key = `${row.schema_name}.${row.table_name}`;
        if (!tables[key]) {
            tables[key] = { schema: row.schema_name, table: row.table_name, rowCount: row.row_count, columns: [] };
        }
        tables[key].columns.push({
            name: row.column_name,
            type: row.data_type,
            maxLength: row.max_length,
            nullable: !!row.is_nullable,
        });
    }

    const snapshot = {
        capturedAt: new Date().toISOString(),
        database: pool.config.database,
        tables: Object.values(tables),
    };

    const outPath = path.join(__dirname, "schema-snapshot.json");
    fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));

    console.log(`Snapshot written to ${outPath}`);
    console.log(`${snapshot.tables.length} table(s):`);
    for (const t of snapshot.tables) {
        console.log(
            `  ${t.schema}.${t.table} (${t.rowCount} rows): ${t.columns.map((c) => c.name).join(", ")}`
        );
    }

    await closePool();
}

main().catch((err) => {
    console.error("Introspection failed:", err.message);
    process.exit(1);
});
