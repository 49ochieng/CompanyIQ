// Minimal, correct-enough robots.txt handling. The crawler is polite by
// default: it fetches /robots.txt for each host and obeys Disallow/Allow for
// our user-agent (falling back to *). Longest-match wins, Allow beats Disallow
// at equal specificity — the standard precedence. A missing/unfetchable
// robots.txt means "allowed" (the conventional default), but the crawler still
// applies the allowlist and rate limits regardless.
"use strict";

const UA = "CompanyIQ-bot";

/**
 * Parse robots.txt into rule groups keyed by user-agent. Each group is an
 * ordered list of { type: "allow"|"disallow", path }.
 */
function parseRobots(text) {
    const groups = {};
    let current = [];
    let sawUA = false;
    for (const rawLine of String(text || "").split(/\r?\n/)) {
        const line = rawLine.replace(/#.*$/, "").trim();
        if (!line) continue;
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        const field = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();
        if (field === "user-agent") {
            if (!sawUA) {
                current = [];
            }
            const agent = value.toLowerCase();
            groups[agent] = groups[agent] || [];
            current = groups[agent];
            sawUA = true;
        } else if (field === "allow" || field === "disallow") {
            sawUA = false;
            if (value) current.push({ type: field, path: value });
            else if (field === "disallow") {
                /* empty Disallow = allow all; represent as nothing */
            }
        }
    }
    return groups;
}

/** Pick the rule group for our UA, else the wildcard group, else []. */
function rulesFor(groups, userAgent = UA) {
    const ua = userAgent.toLowerCase();
    const key = Object.keys(groups).find((g) => g !== "*" && ua.includes(g));
    return groups[key] || groups["*"] || [];
}

/**
 * Is `path` crawlable under `rules`? Longest matching rule wins; on an exact
 * length tie, Allow wins. No matching rule → allowed.
 */
function isPathAllowed(rules, path) {
    const p = path || "/";
    let best = null;
    for (const rule of rules) {
        if (rule.path === "" ) continue;
        if (matches(p, rule.path)) {
            if (
                !best ||
                rule.path.length > best.path.length ||
                (rule.path.length === best.path.length && rule.type === "allow")
            ) {
                best = rule;
            }
        }
    }
    return best ? best.type === "allow" : true;
}

// robots path match: prefix match with `*` wildcard and `$` end-anchor support.
function matches(path, pattern) {
    const rx =
        "^" +
        pattern
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, ".*")
            .replace(/\\\$$/, "$");
    try {
        return new RegExp(rx).test(path);
    } catch {
        return path.startsWith(pattern.replace(/[*$].*$/, ""));
    }
}

module.exports = { parseRobots, rulesFor, isPathAllowed, UA };
