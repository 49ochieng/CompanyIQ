// HTML → clean text + title + same-scope links + a stable content hash.
// Deliberately dependency-free (regex, not a DOM): the crawler only needs
// readable text for indexing and links for discovery, not a faithful DOM.
"use strict";

const crypto = require("crypto");
const { normalizeUrl, isAllowed } = require("./allowlist");

/** Strip scripts/styles/markup and collapse whitespace to readable text. */
function htmlToText(html) {
    return String(html || "")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&quot;/gi, '"')
        .replace(/&[a-z]+;/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function extractTitle(html) {
    const m = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return m ? htmlToText(m[1]).slice(0, 300) : "";
}

/**
 * Best-effort published/modified date from common meta tags. Returns an ISO
 * date string or null. We NEVER invent a date — if a page carries none, the
 * caller falls back to the fetch date and labels it as such.
 */
function extractPublishedDate(html) {
    const patterns = [
        /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+property=["']article:modified_time["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+name=["']date["'][^>]+content=["']([^"']+)["']/i,
        /<meta[^>]+itemprop=["']datePublished["'][^>]+content=["']([^"']+)["']/i,
        /<time[^>]+datetime=["']([^"']+)["']/i,
    ];
    for (const re of patterns) {
        const m = String(html || "").match(re);
        if (m) {
            const d = new Date(m[1]);
            if (!isNaN(d.getTime())) return d.toISOString();
        }
    }
    return null;
}

/** Discover same-allowlist links (absolute, normalized, de-duplicated). */
function extractLinks(html, baseUrl, domains) {
    const links = new Set();
    const re = /<a\b[^>]*\bhref=["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(String(html || ""))) !== null) {
        const norm = normalizeUrl(m[1], baseUrl);
        if (norm && isAllowed(norm, domains)) {
            links.add(norm);
        }
    }
    return [...links];
}

function contentHash(text) {
    return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

/**
 * Parse a fetched page into the record the crawler indexes and snapshots.
 * @returns {{url,title,text,publishedDate,fetchedAt,hash,links}}
 */
function parsePage(html, url, domains, fetchedAt = new Date().toISOString()) {
    const text = htmlToText(html);
    return {
        url,
        title: extractTitle(html) || url,
        text,
        publishedDate: extractPublishedDate(html),
        fetchedAt,
        hash: contentHash(text),
        links: extractLinks(html, url, domains),
    };
}

module.exports = { htmlToText, extractTitle, extractPublishedDate, extractLinks, contentHash, parsePage };
