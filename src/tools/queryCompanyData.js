// Company data tool: the model selects a whitelisted intent and fills
// parameters; this handler validates everything, binds typed inputs, appends
// the row-level scope predicate, and executes the application-owned SQL.
// The model's output NEVER becomes SQL text.
// Accessed via the module object so tests can substitute getPool.
const db = require("../data/db");
const { sql } = db;
const { INTENTS, validateArgs, buildStatement } = require("../data/intents");
const config = require("../config");

// Cap what flows back to the model; the full result set is never needed there.
const MAX_ROWS = 50;

function resolveScope(context) {
    // TEMPORARY until Phase 3 SSO: scope comes from DEV_USER_SCOPE config.
    // Phase 3 replaces this with the authenticated user's mapped identity.
    const scope = (context && context.userScope) || config.devUserScope;
    if (!scope) {
        throw new Error("No user scope configured (DEV_USER_SCOPE). Refusing to run an unscoped data query.");
    }
    return scope;
}

function bindParams(request, intentName, params) {
    for (const [name, value] of Object.entries(params)) {
        request.input(name, INTENTS[intentName].params[name].sqlType(), value);
    }
}

async function execute(pool, statement, intentName, params, scope, extraInputs = {}) {
    const request = pool.request();
    request.input("rowLimit", sql.Int, MAX_ROWS + 1); // +1 to detect truncation
    request.input("userScope", sql.VarChar(50), scope);
    bindParams(request, intentName, params);
    for (const [name, value] of Object.entries(extraInputs)) {
        request.input(name, sql.NVarChar(100), value);
    }
    const result = await request.query(statement);
    return result.recordset;
}

module.exports = {
    name: "queryCompanyData",
    description:
        "Query the company's structured product and item data (items, brands, UPCs, suppliers, ingredients, " +
        "country of origin). This is the primary and preferred source for any question about company products " +
        "or items. Select a whitelisted intent and fill its parameters; never write queries yourself.",
    parameters: {
        type: "object",
        properties: {
            intent: {
                type: "string",
                description: "The whitelisted query intent to run.",
                enum: Object.keys(INTENTS),
            },
            parameters: {
                type: "object",
                description: "Parameters for the selected intent.",
                properties: {
                    ingredient: {
                        type: "string",
                        description: "Ingredient to match in the ingredients statement, e.g. 'soy protein'.",
                    },
                    country_of_origin: {
                        type: "string",
                        description: "Country of origin as a name or ISO code, e.g. 'China' or 'CN'.",
                    },
                    supplier: {
                        type: "string",
                        description: "Supplier name or numeric supplier ID.",
                    },
                    upc: {
                        type: "string",
                        description: "UPC or item ID for a single-item lookup.",
                    },
                },
            },
        },
        required: ["intent"],
    },
    /**
     * @param {{intent: string, parameters?: Object}} args Arguments filled by the model.
     * @param {Object} context Per-turn context ({ conversationId, userScope }).
     */
    async handler(args, context) {
        const startedAt = Date.now();
        const scope = resolveScope(context);

        const validation = validateArgs(args.intent, args.parameters);
        if (!validation.ok) {
            // Structured rejection; the orchestrator maps unrecoverable turns to AF-1.
            return {
                error: "validation_failed",
                reason: validation.reason,
                instruction:
                    "The request could not be mapped to a valid data query. Respond with the exact fallback message.",
            };
        }
        const params = validation.params;

        const pool = await db.getPool();
        let rows = await execute(pool, buildStatement(args.intent), args.intent, params, scope);

        // UC-01 BF-09 semantic assist: zero rows on an ingredient intent falls
        // back to a broadened word-by-word LIKE match, still parameterized.
        // A vector index over ingredient statements is a future enhancement.
        let broadened = false;
        const broadenOn = INTENTS[args.intent].broadenOn;
        if (rows.length === 0 && broadenOn && params[broadenOn]) {
            const words = params[broadenOn].split(/\s+/).filter(Boolean);
            if (words.length > 1) {
                const extraInputs = {};
                words.forEach((w, i) => (extraInputs[`word${i}`] = w));
                const broadParams = { ...params };
                delete broadParams[broadenOn];
                rows = await execute(
                    pool,
                    buildStatement(args.intent, { broadened: true, wordCount: words.length }),
                    args.intent,
                    broadParams,
                    scope,
                    extraInputs
                );
                broadened = true;
            }
        }

        const truncated = rows.length > MAX_ROWS;
        if (truncated) {
            rows = rows.slice(0, MAX_ROWS);
        }

        // Audit trail: every executed intent with parameters, scope, and outcome.
        console.log(
            JSON.stringify({
                event: "db_query",
                conversationId: context && context.conversationId,
                intent: args.intent,
                parameters: params,
                scope,
                rowCount: rows.length,
                broadened,
                truncated,
                durationMs: Date.now() - startedAt,
            })
        );

        return {
            intent: args.intent,
            parameters: params,
            scope,
            rowCount: rows.length,
            rows,
            broadened,
            ...(truncated && { note: `Results truncated to the first ${MAX_ROWS} rows.` }),
        };
    },
};
