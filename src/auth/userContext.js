// Resolves the signed-in user's identity from the OAuth-connection Graph
// token and maps it to a row-level data scope.
//
// Mapping source: USER_SCOPE_MAP env JSON, e.g.
//   {"jane@contoso.com": "RETAILER_100", "9f3b...-oid": "RETAILER_200"}
// Keys may be UPNs (case-insensitive) or AAD object IDs. Production will
// replace this with a mapping table looked up by object ID.
const config = require("../config");

/**
 * Decode a JWT payload without signature verification. The token arrives from
 * the Bot Framework Token Service over the authenticated bot channel, so it is
 * trusted transport-wise; we only read identity claims from it and never use
 * these claims for authorization decisions beyond scope lookup.
 */
function decodeJwtPayload(token) {
    const parts = token.split(".");
    if (parts.length < 2) {
        return undefined;
    }
    try {
        return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
    } catch {
        return undefined;
    }
}

function loadScopeMap() {
    if (!config.userScopeMap) {
        return {};
    }
    try {
        const map = JSON.parse(config.userScopeMap);
        const normalized = {};
        for (const [key, value] of Object.entries(map)) {
            normalized[key.toLowerCase()] = value;
        }
        return normalized;
    } catch (error) {
        console.error("USER_SCOPE_MAP is not valid JSON; treating as empty.", error.message);
        return {};
    }
}

/**
 * Build the per-turn user context from the activity context.
 * @param {{isSignedIn?: boolean, userToken?: string, activity: Object}} ctx
 * @returns {{
 *   user?: {aadObjectId?: string, upn?: string, name?: string},
 *   userScope?: string,
 *   graphToken?: string
 * }}
 */
function resolveUserContext(ctx) {
    if (!ctx.isSignedIn || !ctx.userToken) {
        // Not signed in (playground / pre-SSO): no user identity, no Graph.
        // queryCompanyData falls back to DEV_USER_SCOPE in this case only.
        return {};
    }

    const claims = decodeJwtPayload(ctx.userToken) || {};
    const user = {
        aadObjectId: claims.oid,
        upn: (claims.upn || claims.preferred_username || "").toLowerCase() || undefined,
        name: claims.name,
    };

    const scopeMap = loadScopeMap();
    const userScope =
        (user.upn && scopeMap[user.upn]) ||
        (user.aadObjectId && scopeMap[user.aadObjectId.toLowerCase()]) ||
        undefined;

    return { user, userScope, graphToken: ctx.userToken };
}

/** Diagnostics for /whoami: how many mappings the runtime actually loaded. */
function scopeMapStats() {
    return { entries: Object.keys(loadScopeMap()).length };
}

module.exports = { resolveUserContext, decodeJwtPayload, scopeMapStats };
