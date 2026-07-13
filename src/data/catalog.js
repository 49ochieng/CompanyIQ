// The schema catalog: the COMPLETE allowlist of what is addressable by the
// query layer. Anything not described here cannot be selected, filtered,
// joined, grouped, or aggregated — the database also holds unrelated
// application tables (dbo.*), and they are unreachable by construction.
//
// Generated from `npm run db:introspect` but deliberately checked in and
// reviewed by hand: it is a security boundary, not a runtime reflection.
//
// Every table declares how the row-level scope is reached (`scopeVia`): the
// compiler walks that path and appends the scope predicate to EVERY statement.
const sql = require("mssql");

// Scope is enforced on this column of this table, always.
const SCOPE_TABLE = "retailer_items";
const SCOPE_COLUMN = "retailer_id";

const TABLES = {
    items: {
        sqlName: "sbs_test.items",
        alias: "i",
        description: "Products/items in the company's assortment.",
        // Reaching the scope column requires joining retailer_items.
        scopeVia: ["retailer_items"],
        columns: {
            item_name: {
                sqlName: "i.item_name",
                label: "Item",
                type: "string",
                maxLength: 200,
                description: "Product name.",
                selectable: true,
                filterable: true,
                groupable: true,
                aggregatable: false,
                sqlType: () => sql.NVarChar(200),
            },
            brand: {
                sqlName: "i.brand",
                label: "Brand",
                type: "string",
                maxLength: 100,
                description: "Brand name.",
                selectable: true,
                filterable: true,
                groupable: true,
                aggregatable: false,
                sqlType: () => sql.NVarChar(100),
            },
            upc: {
                sqlName: "i.upc",
                label: "UPC",
                type: "string",
                maxLength: 14,
                description: "Universal Product Code.",
                selectable: true,
                filterable: true,
                groupable: false,
                aggregatable: false,
                sqlType: () => sql.VarChar(14),
            },
            country_of_origin: {
                sqlName: "i.country_of_origin",
                label: "COO",
                type: "string",
                maxLength: 100,
                description: "Country of origin, e.g. 'China', 'United States of America'.",
                selectable: true,
                filterable: true,
                groupable: true,
                aggregatable: false,
                sqlType: () => sql.NVarChar(100),
            },
            mtl_neq_usa: {
                sqlName: "i.mtl_neq_usa",
                label: "Mtl<>USA",
                type: "boolean",
                description: "True when material origin differs from the USA.",
                selectable: true,
                filterable: true,
                groupable: true,
                aggregatable: false,
                sqlType: () => sql.Bit,
                // Rendered as Y/N for humans.
                selectExpression: "CASE WHEN i.mtl_neq_usa = 1 THEN 'Y' ELSE 'N' END",
            },
            ingredients_statement: {
                sqlName: "i.ingredients_statement",
                label: "Ingredients Statement",
                type: "string",
                maxLength: 4000,
                description: "Full ingredients declaration. Use 'contains' to search for an ingredient.",
                selectable: true,
                filterable: true,
                groupable: false,
                aggregatable: false,
                sqlType: () => sql.NVarChar(4000),
            },
            item_id: {
                sqlName: "i.item_id",
                label: "Item ID",
                type: "number",
                description: "Internal item identifier.",
                selectable: true,
                filterable: true,
                groupable: false,
                aggregatable: true,
                sqlType: () => sql.Int,
            },
        },
    },

    suppliers: {
        sqlName: "sbs_test.suppliers",
        alias: "s",
        description: "Suppliers that provide the company's items.",
        // Suppliers are scoped through the items the retailer actually carries.
        scopeVia: ["items", "retailer_items"],
        columns: {
            supplier_name: {
                sqlName: "s.supplier_name",
                label: "Supplier",
                type: "string",
                maxLength: 200,
                description: "Supplier company name.",
                selectable: true,
                filterable: true,
                groupable: true,
                aggregatable: false,
                sqlType: () => sql.NVarChar(200),
            },
            supplier_id: {
                sqlName: "s.supplier_id",
                label: "Supplier ID",
                type: "number",
                description: "Internal supplier identifier.",
                selectable: true,
                filterable: true,
                groupable: true,
                aggregatable: true,
                sqlType: () => sql.Int,
            },
        },
    },
};

// Join paths the compiler may use. Nothing else can be joined. Keyed
// `from->to`; `on` is fixed SQL over the declared aliases.
const JOINS = {
    "items->suppliers": { table: "suppliers", on: "s.supplier_id = i.supplier_id" },
    "suppliers->items": { table: "items", on: "i.supplier_id = s.supplier_id" },
    "items->retailer_items": { table: "retailer_items", on: "ri.item_id = i.item_id" },
    "suppliers->retailer_items": { table: "retailer_items", on: "ri.item_id = i.item_id" },
};

// The scope table is joined by the compiler, never selected or filtered by
// the model — it exists only to enforce row-level security.
const SCOPE_TABLE_SQL = { sqlName: "sbs_test.retailer_items", alias: "ri" };

const OPERATORS = {
    eq: { sql: (col, p) => `${col} = @${p}`, arity: 1 },
    neq: { sql: (col, p) => `${col} <> @${p}`, arity: 1 },
    gt: { sql: (col, p) => `${col} > @${p}`, arity: 1 },
    gte: { sql: (col, p) => `${col} >= @${p}`, arity: 1 },
    lt: { sql: (col, p) => `${col} < @${p}`, arity: 1 },
    lte: { sql: (col, p) => `${col} <= @${p}`, arity: 1 },
    // LIKE values are escaped by the compiler so wildcards can't be smuggled in.
    contains: { sql: (col, p) => `${col} LIKE '%' + @${p} + '%' ESCAPE '\\'`, arity: 1, like: true },
    starts_with: { sql: (col, p) => `${col} LIKE @${p} + '%' ESCAPE '\\'`, arity: 1, like: true },
    in: { sql: (col, ps) => `${col} IN (${ps.map((p) => `@${p}`).join(", ")})`, arity: "many" },
    between: { sql: (col, ps) => `${col} BETWEEN @${ps[0]} AND @${ps[1]}`, arity: 2 },
};

const AGGREGATIONS = {
    count: { sql: (col) => (col === "*" ? "COUNT(*)" : `COUNT(${col})`), allowStar: true, label: "Count" },
    sum: { sql: (col) => `SUM(${col})`, allowStar: false, label: "Sum" },
    avg: { sql: (col) => `AVG(${col})`, allowStar: false, label: "Average" },
    min: { sql: (col) => `MIN(${col})`, allowStar: false, label: "Min" },
    max: { sql: (col) => `MAX(${col})`, allowStar: false, label: "Max" },
};

const MAX_ROWS = 50;

/** Compact schema rendering for the system prompt. */
function describeForPrompt() {
    const lines = [];
    for (const [tableName, table] of Object.entries(TABLES)) {
        lines.push(`- ${tableName}: ${table.description}`);
        for (const [colName, col] of Object.entries(table.columns)) {
            const caps = [];
            if (col.filterable) caps.push("filterable");
            if (col.groupable) caps.push("groupable");
            if (col.aggregatable) caps.push("aggregatable");
            lines.push(`    - ${colName} (${col.type}${caps.length ? ", " + caps.join("/") : ""}): ${col.description}`);
        }
    }
    lines.push(`Joins available: items↔suppliers (an item has one supplier).`);
    return lines.join("\n");
}

function getTable(name) {
    return Object.prototype.hasOwnProperty.call(TABLES, name) ? TABLES[name] : undefined;
}

function getColumn(tableName, columnName) {
    const table = getTable(tableName);
    if (!table) return undefined;
    return Object.prototype.hasOwnProperty.call(table.columns, columnName) ? table.columns[columnName] : undefined;
}

/** Find which allowlisted table owns a column name (for join-aware queries). */
function findColumn(tableNames, columnName) {
    for (const tableName of tableNames) {
        const col = getColumn(tableName, columnName);
        if (col) return { tableName, column: col };
    }
    return undefined;
}

module.exports = {
    TABLES,
    JOINS,
    OPERATORS,
    AGGREGATIONS,
    SCOPE_TABLE,
    SCOPE_COLUMN,
    SCOPE_TABLE_SQL,
    MAX_ROWS,
    describeForPrompt,
    getTable,
    getColumn,
    findColumn,
};
