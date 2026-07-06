// The intent whitelist: the ONLY SQL this application runs against company
// data. The model never contributes SQL text — it selects an intent name and
// fills parameters, which are validated here and bound as typed inputs.
// Every generated statement carries the row-level scope predicate
// (ri.retailer_id = @userScope); buildStatement() injects it unconditionally.
const { sql } = require("./db");

// UC-01 Appendix A-02 columns.
const BASE_SELECT = `
    SELECT TOP (@rowLimit)
        i.item_name AS [Item],
        i.brand AS [Brand],
        i.upc AS [UPC],
        s.supplier_name AS [Supplier],
        i.country_of_origin AS [COO],
        CASE WHEN i.mtl_neq_usa = 1 THEN 'Y' ELSE 'N' END AS [Mtl<>USA],
        i.ingredients_statement AS [Ingredients Statement]
    FROM sbs_test.items i
    JOIN sbs_test.suppliers s ON s.supplier_id = i.supplier_id
    JOIN sbs_test.retailer_items ri ON ri.item_id = i.item_id`;

// Conservative allowlists; parameters are bound, so this is defense in depth
// plus a guarantee that LIKE wildcards can't be smuggled in.
const TEXT_PATTERN = /^[A-Za-z0-9 \-.,()&]+$/;
const CODE_PATTERN = /^[A-Za-z0-9-]+$/;

const COUNTRY_ALIASES = {
    cn: "China",
    china: "China",
    us: "United States of America",
    usa: "United States of America",
    "united states": "United States of America",
    "united states of america": "United States of America",
    mx: "Mexico",
    mexico: "Mexico",
    th: "Thailand",
    thailand: "Thailand",
    lt: "Lithuania",
    lithuania: "Lithuania",
};

function normalizeCountry(value) {
    return COUNTRY_ALIASES[value.toLowerCase().trim()] || value.trim();
}

const INTENTS = {
    // UC-01 verbatim intent.
    items_by_ingredient_and_coo: {
        params: {
            ingredient: { required: true, maxLength: 100, pattern: TEXT_PATTERN, sqlType: () => sql.NVarChar(100) },
            country_of_origin: {
                required: true,
                maxLength: 60,
                pattern: TEXT_PATTERN,
                normalize: normalizeCountry,
                sqlType: () => sql.NVarChar(100),
            },
        },
        where: "i.ingredients_statement LIKE '%' + @ingredient + '%' AND i.country_of_origin = @country_of_origin",
        broadenOn: "ingredient",
    },
    items_by_ingredient: {
        params: {
            ingredient: { required: true, maxLength: 100, pattern: TEXT_PATTERN, sqlType: () => sql.NVarChar(100) },
        },
        where: "i.ingredients_statement LIKE '%' + @ingredient + '%'",
        broadenOn: "ingredient",
    },
    items_by_supplier: {
        params: {
            supplier: { required: true, maxLength: 200, pattern: TEXT_PATTERN, sqlType: () => sql.NVarChar(200) },
        },
        where:
            "(s.supplier_name LIKE '%' + @supplier + '%' OR CAST(s.supplier_id AS NVARCHAR(20)) = @supplier)",
    },
    item_detail: {
        params: {
            upc: { required: true, maxLength: 14, pattern: CODE_PATTERN, sqlType: () => sql.VarChar(14) },
        },
        where: "(i.upc = @upc OR CAST(i.item_id AS VARCHAR(14)) = @upc)",
    },
};

/**
 * Validates and normalizes model-supplied arguments for an intent.
 * @returns {{ok: true, params: Object} | {ok: false, reason: string}}
 */
function validateArgs(intentName, rawParams) {
    const intent = INTENTS[intentName];
    if (!intent) {
        return { ok: false, reason: `unknown intent '${String(intentName)}'` };
    }

    const params = {};
    const supplied = rawParams && typeof rawParams === "object" ? rawParams : {};

    for (const key of Object.keys(supplied)) {
        if (!intent.params[key]) {
            // Tolerate irrelevant-but-empty extras; reject unknown values.
            if (supplied[key] === undefined || supplied[key] === null || supplied[key] === "") {
                continue;
            }
            return { ok: false, reason: `parameter '${key}' is not valid for intent '${intentName}'` };
        }
    }

    for (const [name, rule] of Object.entries(intent.params)) {
        let value = supplied[name];
        if (value === undefined || value === null || value === "") {
            if (rule.required) {
                return { ok: false, reason: `missing required parameter '${name}'` };
            }
            continue;
        }
        if (typeof value !== "string") {
            return { ok: false, reason: `parameter '${name}' must be a string` };
        }
        value = value.trim();
        if (value.length === 0) {
            return { ok: false, reason: `parameter '${name}' is empty` };
        }
        if (value.length > rule.maxLength) {
            return { ok: false, reason: `parameter '${name}' exceeds ${rule.maxLength} characters` };
        }
        if (!rule.pattern.test(value)) {
            return { ok: false, reason: `parameter '${name}' contains unsupported characters` };
        }
        if (rule.normalize) {
            value = rule.normalize(value);
        }
        params[name] = value;
    }

    return { ok: true, params };
}

/**
 * Builds the full parameterized statement for an intent. The row-level scope
 * predicate is injected here for EVERY intent — no query path can skip it.
 * @param {string} intentName A whitelisted intent (must exist).
 * @param {{broadened?: boolean, wordCount?: number}} [options] Broadened match
 * for the zero-row fallback (UC-01 BF-09): each word of the ingredient term is
 * bound separately (@word0..@wordN) and matched with AND.
 */
function buildStatement(intentName, options = {}) {
    const intent = INTENTS[intentName];
    if (!intent) {
        throw new Error(`unknown intent '${intentName}'`);
    }

    let where = intent.where;
    if (options.broadened) {
        const clauses = [];
        for (let i = 0; i < options.wordCount; i++) {
            clauses.push(`i.ingredients_statement LIKE '%' + @word${i} + '%'`);
        }
        where = clauses.join(" AND ");
        if (intent.params.country_of_origin) {
            where += " AND i.country_of_origin = @country_of_origin";
        }
    }

    return `${BASE_SELECT}
    WHERE ri.retailer_id = @userScope AND (${where})
    ORDER BY i.item_name`;
}

module.exports = { INTENTS, validateArgs, buildStatement, normalizeCountry };
