// URL allowlist + normalization for the crawler. Shared by armely.com (B) and
// every watchlist entity (C): a crawl NEVER leaves the configured domains.
"use strict";

/**
 * Normalize a URL for storage/dedup: force https compare on host, lowercase the
 * host, drop the fragment and default ports, and strip a trailing slash on the
 * path. Returns null for anything unparseable or non-http(s).
 */
function normalizeUrl(raw, base) {
    let u;
    try {
        u = base ? new URL(raw, base) : new URL(raw);
    } catch {
        return null;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
        return null;
    }
    // Build the canonical form by hand: URL.toString() re-adds a trailing "/"
    // on the root, which would make the root and its links normalize
    // inconsistently. Drop the fragment, lowercase the host, and strip a
    // trailing slash even on the root ("" path), keeping any query string.
    const host = u.hostname.toLowerCase() + (u.port ? `:${u.port}` : "");
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${host}${path}${u.search}`;
}

/** True when `host` is within one of the allowed registrable domains. */
function hostAllowed(host, domains) {
    const h = String(host || "").toLowerCase();
    return domains.some((d) => {
        const dd = d.toLowerCase().replace(/^www\./, "");
        return h === dd || h === `www.${dd}` || h.endsWith(`.${dd}`);
    });
}

/** True when a URL is on an allowed domain (used before every fetch). */
function isAllowed(url, domains) {
    let host;
    try {
        host = new URL(url).hostname;
    } catch {
        return false;
    }
    return hostAllowed(host, domains);
}

/** Parse a comma/space-separated domain list (env form) into a clean array. */
function parseDomains(value) {
    return String(value || "")
        .split(/[\s,]+/)
        .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
        .filter(Boolean);
}

module.exports = { normalizeUrl, hostAllowed, isAllowed, parseDomains };
