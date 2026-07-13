// Compiles a validated, structured query object into parameterized T-SQL.
//
// SECURITY INVARIANTS (asserted in tests):
//  1. The model never supplies SQL text — only catalog names and values.
//  2. Every identifier is resolved through the catalog; unknown table/column/
//     operator/join/aggregation is a hard rejection.
//  3. EVERY compiled statement joins the scope table and carries
//     `ri.retailer_id = @userScope`. There is no code path that omits it.
//  4. Every value is bound as a typed parameter; LIKE values are escaped so
//     wildcards cannot be smuggled in.
const {
    TABLES,
    JOINS,
    OPERATORS,
    AGGREGATIONS,
    SCOPE_TABLE,
    SCOPE_COLUMN,
    SCOPE_TABLE_SQL,
    MAX_ROWS,
    getTable,
    getColumn,
} = require("./catalog");

const MAX_VALUE_LENGTH = 200;
const MAX_IN_VALUES = 20;

function reject(reason) {
    return { ok: false, reason };
}

/** Escape LIKE metacharacters so a value cannot broaden its own match. */
function escapeLike(value) {
    return String(value).replace(/([\\%_[\]])/g, "\\$1");
}

function coerceValue(column, raw) {
    if (column.type === "number") {
        const n = typeof raw === "number" ? raw : Number(raw);
        if (!Number.isFinite(n)) return { ok: false, reason: `'${raw}' is not a number` };
        return { ok: true, value: n };
    }
    if (column.type === "boolean") {
        if (typeof raw === "boolean") return { ok: true, value: raw ? 1 : 0 };
        const s = String(raw).toLowerCase();
        if (["true", "y", "yes", "1"].includes(s)) return { ok: true, value: 1 };
        if (["false", "n", "no", "0"].includes(s)) return { ok: true, value: 0 };
        return { ok: false, reason: `'${raw}' is not a yes/no value` };
    }
    // string
    if (typeof raw === "object" || raw === undefined || raw === null) {
        return { ok: false, reason: "value must be text" };
    }
    const s = String(raw).trim();
    if (s.length === 0) return { ok: false, reason: "value is empty" };
    if (s.length > MAX_VALUE_LENGTH) return { ok: false, reason: `value exceeds ${MAX_VALUE_LENGTH} characters` };
    return { ok: true, value: s };
}

/**
 * Compile a structured query. Returns { ok, statement, inputs, columns } or
 * { ok:false, reason }.
 *
 * @param {Object} q { table, select, filters, joins, groupBy, aggregations, orderBy, limit }
 */
function compile(q) {
    if (!q || typeof q !== "object") return reject("no query supplied");

    const baseName = q.table;
    const base = getTable(baseName);
    if (!base) {
        return reject(`unknown table '${String(baseName)}' — available: ${Object.keys(TABLES).join(", ")}`);
    }

    // ---- resolve joins (catalog-declared paths only) --------------------
    const joinedTables = new Set([baseName]);
    const joinClauses = [];

    function addJoin(fromName, toName) {
        if (joinedTables.has(toName)) return { ok: true };
        // The scope table is joined by the compiler itself.
        if (toName === SCOPE_TABLE) {
            joinClauses.push(
                `JOIN ${SCOPE_TABLE_SQL.sqlName} AS ${SCOPE_TABLE_SQL.alias} ON ${JOINS[`${fromName}->${SCOPE_TABLE}`].on}`
            );
            joinedTables.add(toName);
            return { ok: true };
        }
        const key = `${fromName}->${toName}`;
        const join = JOINS[key];
        if (!join) return { ok: false, reason: `no join path '${key}'` };
        const target = getTable(toName);
        joinClauses.push(`JOIN ${target.sqlName} AS ${target.alias} ON ${join.on}`);
        joinedTables.add(toName);
        return { ok: true };
    }

    for (const toName of q.joins || []) {
        if (!getTable(toName)) return reject(`unknown join target '${String(toName)}'`);
        const r = addJoin(baseName, toName);
        if (!r.ok) return reject(r.reason);
    }

    // ---- SCOPE: always join the scope table and predicate on it ---------
    // Walk the catalog-declared path from the base table to the scope table.
    let scopeFrom = baseName;
    for (const hop of base.scopeVia) {
        const r = addJoin(scopeFrom, hop);
        if (!r.ok) {
            return reject(`cannot enforce row-level scope from '${baseName}': ${r.reason}`);
        }
        scopeFrom = hop;
    }
    if (!joinedTables.has(SCOPE_TABLE)) {
        // Unreachable by construction, but never emit an unscoped statement.
        return reject(`row-level scope cannot be enforced for table '${baseName}'`);
    }

    const inputs = [];
    let paramSeq = 0;
    const nextParam = () => `p${paramSeq++}`;

    // ---- SELECT / aggregations / groupBy --------------------------------
    const selectParts = [];
    const outputColumns = [];

    const aggregations = q.aggregations || [];
    const groupBy = q.groupBy || [];
    const isAggregate = aggregations.length > 0;

    function resolveColumn(name, capability) {
        for (const tableName of joinedTables) {
            const col = getColumn(tableName, name);
            if (col) {
                if (capability && !col[capability]) {
                    return { ok: false, reason: `column '${name}' is not ${capability}` };
                }
                return { ok: true, tableName, column: col };
            }
        }
        return { ok: false, reason: `unknown column '${String(name)}'` };
    }

    for (const g of groupBy) {
        const r = resolveColumn(g, "groupable");
        if (!r.ok) return reject(r.reason);
        selectParts.push(`${r.column.selectExpression || r.column.sqlName} AS [${r.column.label}]`);
        outputColumns.push(r.column.label);
    }

    for (const agg of aggregations) {
        if (!agg || typeof agg !== "object") return reject("invalid aggregation");
        const fn = AGGREGATIONS[agg.fn];
        if (!fn) {
            return reject(`unknown aggregation '${String(agg.fn)}' — available: ${Object.keys(AGGREGATIONS).join(", ")}`);
        }
        if (agg.column === "*" || agg.column === undefined) {
            if (!fn.allowStar) return reject(`aggregation '${agg.fn}' needs a column`);
            selectParts.push(`COUNT(*) AS [Count]`);
            outputColumns.push("Count");
            continue;
        }
        const r = resolveColumn(agg.column, "aggregatable");
        if (!r.ok) return reject(r.reason);
        const label = `${fn.label} of ${r.column.label}`;
        selectParts.push(`${fn.sql(r.column.sqlName)} AS [${label}]`);
        outputColumns.push(label);
    }

    if (!isAggregate) {
        const select = (q.select && q.select.length > 0)
            ? q.select
            : Object.keys(base.columns).filter((c) => base.columns[c].selectable);
        for (const name of select) {
            const r = resolveColumn(name, "selectable");
            if (!r.ok) return reject(r.reason);
            selectParts.push(`${r.column.selectExpression || r.column.sqlName} AS [${r.column.label}]`);
            outputColumns.push(r.column.label);
        }
    } else if (groupBy.length === 0 && selectParts.length === 0) {
        return reject("aggregate query produced no output columns");
    }

    if (selectParts.length === 0) return reject("nothing to select");

    // ---- WHERE (scope predicate is not optional) ------------------------
    const whereParts = [];
    for (const f of q.filters || []) {
        if (!f || typeof f !== "object") return reject("invalid filter");
        const op = OPERATORS[f.operator];
        if (!op) {
            return reject(`unknown operator '${String(f.operator)}' — available: ${Object.keys(OPERATORS).join(", ")}`);
        }
        const r = resolveColumn(f.column, "filterable");
        if (!r.ok) return reject(r.reason);
        const col = r.column;

        if (op.arity === "many") {
            const values = Array.isArray(f.value) ? f.value : [f.value];
            if (values.length === 0) return reject(`operator 'in' needs at least one value`);
            if (values.length > MAX_IN_VALUES) return reject(`operator 'in' accepts at most ${MAX_IN_VALUES} values`);
            const names = [];
            for (const v of values) {
                const c = coerceValue(col, v);
                if (!c.ok) return reject(`filter on '${f.column}': ${c.reason}`);
                const p = nextParam();
                inputs.push({ name: p, sqlType: col.sqlType(), value: c.value });
                names.push(p);
            }
            whereParts.push(op.sql(col.sqlName, names));
            continue;
        }

        if (op.arity === 2) {
            const values = Array.isArray(f.value) ? f.value : [];
            if (values.length !== 2) return reject(`operator 'between' needs exactly two values`);
            const names = [];
            for (const v of values) {
                const c = coerceValue(col, v);
                if (!c.ok) return reject(`filter on '${f.column}': ${c.reason}`);
                const p = nextParam();
                inputs.push({ name: p, sqlType: col.sqlType(), value: c.value });
                names.push(p);
            }
            whereParts.push(op.sql(col.sqlName, names));
            continue;
        }

        const c = coerceValue(col, Array.isArray(f.value) ? f.value[0] : f.value);
        if (!c.ok) return reject(`filter on '${f.column}': ${c.reason}`);
        const p = nextParam();
        inputs.push({
            name: p,
            sqlType: col.sqlType(),
            value: op.like ? escapeLike(c.value) : c.value,
        });
        whereParts.push(op.sql(col.sqlName, p));
    }

    // ---- ORDER BY --------------------------------------------------------
    let orderClause = "";
    if (q.orderBy) {
        const name = typeof q.orderBy === "string" ? q.orderBy : q.orderBy.column;
        const dirRaw = typeof q.orderBy === "object" && q.orderBy.direction ? String(q.orderBy.direction) : "asc";
        const dir = dirRaw.toLowerCase() === "desc" ? "DESC" : "ASC";
        // Ordering by an aggregate output is expressed by its label.
        const aggLabel = outputColumns.find((l) => l.toLowerCase() === String(name).toLowerCase());
        if (isAggregate && aggLabel) {
            orderClause = `ORDER BY [${aggLabel}] ${dir}`;
        } else {
            const r = resolveColumn(name, "selectable");
            if (!r.ok) return reject(r.reason);
            if (isAggregate && !groupBy.includes(name)) {
                return reject(`cannot order by '${name}' in an aggregate query unless it is grouped`);
            }
            orderClause = `ORDER BY ${r.column.sqlName} ${dir}`;
        }
    }

    // ---- LIMIT -----------------------------------------------------------
    let limit = MAX_ROWS;
    if (q.limit !== undefined && q.limit !== null) {
        const n = Number(q.limit);
        if (!Number.isInteger(n) || n < 1) return reject("limit must be a positive whole number");
        limit = Math.min(n, MAX_ROWS);
    }

    // ---- assemble --------------------------------------------------------
    const groupClause = groupBy.length > 0
        ? `GROUP BY ${groupBy.map((g) => {
            const r = resolveColumn(g, "groupable");
            return r.column.selectExpression || r.column.sqlName;
        }).join(", ")}`
        : "";

    // The scope predicate leads the WHERE clause, always.
    const scopePredicate = `${SCOPE_TABLE_SQL.alias}.${SCOPE_COLUMN} = @userScope`;
    const whereClause = whereParts.length > 0
        ? `WHERE ${scopePredicate} AND (${whereParts.join(" AND ")})`
        : `WHERE ${scopePredicate}`;

    const distinct = !isAggregate && joinedTables.size > 1 ? "DISTINCT " : "";

    const statement = [
        `SELECT ${distinct}TOP (@rowLimit) ${selectParts.join(", ")}`,
        `FROM ${base.sqlName} AS ${base.alias}`,
        ...joinClauses,
        whereClause,
        groupClause,
        orderClause,
    ]
        .filter(Boolean)
        .join("\n");

    return { ok: true, statement, inputs, outputColumns, limit, isAggregate };
}

module.exports = { compile, escapeLike, MAX_VALUE_LENGTH, MAX_IN_VALUES };
