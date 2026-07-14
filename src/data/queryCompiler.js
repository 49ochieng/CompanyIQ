// Compiles a validated, structured query object into parameterized T-SQL,
// against ONE catalog (one data source).
//
// SECURITY INVARIANTS (asserted in tests):
//  1. The model never supplies SQL text — only catalog names and values.
//  2. Every identifier is resolved through the catalog; unknown table/column/
//     operator/join/aggregation is a hard rejection.
//  3. Each catalog MUST declare a scope policy. A catalog with no policy is a
//     configuration error and throws — never a silent unscoped query.
//       - "row_predicate":       the scope table is joined and
//                                `<scopeTable>.<scopeColumn> = @userScope` is
//                                appended to EVERY statement. Mandatory.
//       - "enforced_by_source":  the connection itself carries the signed-in
//                                user's identity and the engine enforces their
//                                permissions (Fabric over TDS with a delegated
//                                token), so there is no predicate to add.
//  4. Table-level `rowFilter`s (e.g. soft-delete flags) are applied
//     unconditionally and cannot be disabled by the model.
//  5. Every value is bound as a typed parameter; LIKE values are escaped so
//     wildcards cannot be smuggled in.
const azureSqlCatalog = require("./catalogs/azureSql");

const MAX_VALUE_LENGTH = 200;
const MAX_IN_VALUES = 20;
const DEFAULT_MAX_ROWS = 50;

// Operators/aggregations are shared across sources.
const { OPERATORS, AGGREGATIONS } = azureSqlCatalog;

const SCOPE_POLICIES = new Set(["row_predicate", "enforced_by_source"]);

function reject(reason) {
    return { ok: false, reason };
}

/** Escape LIKE metacharacters so a value cannot broaden its own match. */
function escapeLike(value) {
    return String(value).replace(/([\\%_[\]])/g, "\\$1");
}

/**
 * Fail loudly if a catalog does not state how row-level access is enforced.
 * Called at startup by the source registry, and again defensively here.
 */
function assertScopePolicy(catalog) {
    const scope = catalog && catalog.scope;
    if (!scope || !SCOPE_POLICIES.has(scope.policy)) {
        throw new Error(
            `Catalog '${(catalog && catalog.name) || "<unnamed>"}' does not declare a scope policy. ` +
            `Every data source must state one of: ${[...SCOPE_POLICIES].join(", ")}. ` +
            "Refusing to load a source whose row-level access rules are undefined."
        );
    }
    if (scope.policy === "row_predicate" && (!scope.table || !scope.column || !scope.tableSql)) {
        throw new Error(
            `Catalog '${catalog.name}' declares scope policy 'row_predicate' but is missing the scope table/column.`
        );
    }
    return scope;
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
    if (typeof raw === "object" || raw === undefined || raw === null) {
        return { ok: false, reason: "value must be text" };
    }
    const s = String(raw).trim();
    if (s.length === 0) return { ok: false, reason: "value is empty" };
    if (s.length > MAX_VALUE_LENGTH) return { ok: false, reason: `value exceeds ${MAX_VALUE_LENGTH} characters` };
    return { ok: true, value: s };
}

/**
 * Compile a structured query against one catalog.
 * @param {Object} q { table, select, filters, joins, groupBy, aggregations, orderBy, limit }
 * @param {Object} catalog Defaults to the Azure SQL (company data) catalog.
 */
function compile(q, catalog = azureSqlCatalog) {
    if (!q || typeof q !== "object") return reject("no query supplied");

    const scope = assertScopePolicy(catalog);
    const TABLES = catalog.TABLES;
    const JOINS = catalog.JOINS;
    const MAX_ROWS = catalog.MAX_ROWS || DEFAULT_MAX_ROWS;

    const getTable = (n) => (Object.prototype.hasOwnProperty.call(TABLES, n) ? TABLES[n] : undefined);
    const getColumn = (t, c) => {
        const table = getTable(t);
        return table && Object.prototype.hasOwnProperty.call(table.columns, c) ? table.columns[c] : undefined;
    };

    const baseName = q.table;
    const base = getTable(baseName);
    if (!base) {
        return reject(`unknown table '${String(baseName)}' — available: ${Object.keys(TABLES).join(", ")}`);
    }

    // ---- joins (catalog-declared paths only) ----------------------------
    const joinedTables = new Set([baseName]);
    const joinClauses = [];

    function addJoin(fromName, toName) {
        if (joinedTables.has(toName)) return { ok: true };
        // The scope table is joined by the compiler itself, never by the model.
        if (scope.policy === "row_predicate" && toName === scope.table) {
            const key = `${fromName}->${scope.table}`;
            const join = JOINS[key];
            if (!join) return { ok: false, reason: `no scope join path '${key}'` };
            joinClauses.push(`JOIN ${scope.tableSql.sqlName} AS ${scope.tableSql.alias} ON ${join.on}`);
            joinedTables.add(toName);
            return { ok: true };
        }
        const key = `${fromName}->${toName}`;
        const join = JOINS[key];
        if (!join) return { ok: false, reason: `no join path '${key}'` };
        const target = getTable(toName);
        if (!target) return { ok: false, reason: `unknown join target '${toName}'` };
        joinClauses.push(`JOIN ${target.sqlName} AS ${target.alias} ON ${join.on}`);
        joinedTables.add(toName);
        return { ok: true };
    }

    for (const toName of q.joins || []) {
        if (!getTable(toName)) return reject(`unknown join target '${String(toName)}'`);
        const r = addJoin(baseName, toName);
        if (!r.ok) return reject(r.reason);
    }

    // ---- SCOPE ----------------------------------------------------------
    if (scope.policy === "row_predicate") {
        let from = baseName;
        for (const hop of base.scopeVia || []) {
            const r = addJoin(from, hop);
            if (!r.ok) return reject(`cannot enforce row-level scope from '${baseName}': ${r.reason}`);
            from = hop;
        }
        if (!joinedTables.has(scope.table)) {
            // Unreachable by construction — but never emit an unscoped statement.
            return reject(`row-level scope cannot be enforced for table '${baseName}'`);
        }
    }

    const inputs = [];
    let paramSeq = 0;
    const nextParam = () => `p${paramSeq++}`;

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

    // ---- SELECT / aggregations / groupBy --------------------------------
    const selectParts = [];
    const outputColumns = [];
    const aggregations = q.aggregations || [];
    const groupBy = q.groupBy || [];
    const isAggregate = aggregations.length > 0;

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

    // ---- WHERE ----------------------------------------------------------
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

    // Table-level row filters (soft deletes) — unconditional, model cannot disable.
    const rowFilters = [];
    for (const tableName of joinedTables) {
        const t = getTable(tableName);
        if (t && t.rowFilter) {
            rowFilters.push(t.rowFilter);
        }
    }

    // ---- ORDER BY --------------------------------------------------------
    let orderClause = "";
    if (q.orderBy) {
        const name = typeof q.orderBy === "string" ? q.orderBy : q.orderBy.column;
        const dirRaw = typeof q.orderBy === "object" && q.orderBy.direction ? String(q.orderBy.direction) : "asc";
        const dir = dirRaw.toLowerCase() === "desc" ? "DESC" : "ASC";
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

    // The scope predicate leads the WHERE clause, always (row_predicate sources).
    const conditions = [];
    if (scope.policy === "row_predicate") {
        conditions.push(`${scope.tableSql.alias}.${scope.column} = @userScope`);
    }
    conditions.push(...rowFilters);
    const userConditions = whereParts.length > 0 ? `(${whereParts.join(" AND ")})` : "";
    if (userConditions) conditions.push(userConditions);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

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

    return {
        ok: true,
        statement,
        inputs,
        outputColumns,
        limit,
        isAggregate,
        scopePolicy: scope.policy,
    };
}

module.exports = {
    compile,
    escapeLike,
    assertScopePolicy,
    SCOPE_POLICIES,
    MAX_VALUE_LENGTH,
    MAX_IN_VALUES,
};
