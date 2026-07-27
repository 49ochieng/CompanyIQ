const { test } = require("node:test");
const assert = require("node:assert");
const { normalizeUrl, hostAllowed, isAllowed, parseDomains } = require("./allowlist");
const { parseRobots, rulesFor, isPathAllowed } = require("./robots");
const { htmlToText, extractTitle, extractPublishedDate, extractLinks, parsePage } = require("./extract");
const { buildSnapshot, diffSnapshots, summarizeDiff } = require("./snapshot");

// ---------- allowlist ----------
test("normalizeUrl drops fragments, lowercases host, trims trailing slash", () => {
    assert.strictEqual(normalizeUrl("https://Www.DallasCounty.ORG/news/#top"), "https://www.dallascounty.org/news");
    assert.strictEqual(normalizeUrl("/page", "https://dallascounty.org/a/b"), "https://dallascounty.org/page");
    assert.strictEqual(normalizeUrl("mailto:x@y.com"), null);
    assert.strictEqual(normalizeUrl("not a url"), null);
});

test("hostAllowed matches domain, www, and subdomains only", () => {
    const d = ["dallascounty.org"];
    assert.ok(hostAllowed("dallascounty.org", d));
    assert.ok(hostAllowed("www.dallascounty.org", d));
    assert.ok(hostAllowed("news.dallascounty.org", d));
    assert.ok(!hostAllowed("dallascounty.org.evil.com", d));
    assert.ok(!hostAllowed("notdallascounty.org", d));
});

test("isAllowed keeps a crawl inside the allowlist", () => {
    const d = ["dallascounty.org"];
    assert.ok(isAllowed("https://www.dallascounty.org/x", d));
    assert.ok(!isAllowed("https://evil.com/x", d));
});

test("parseDomains cleans env forms", () => {
    assert.deepStrictEqual(parseDomains("dallascounty.org, https://armely.com/, foo.com"), ["dallascounty.org", "armely.com", "foo.com"]);
});

// ---------- robots ----------
test("robots Disallow is obeyed; Allow overrides a broader Disallow", () => {
    const groups = parseRobots(`
User-agent: *
Disallow: /private
Allow: /private/public
`);
    const rules = rulesFor(groups, "CompanyIQ-bot");
    assert.strictEqual(isPathAllowed(rules, "/private/secret"), false);
    assert.strictEqual(isPathAllowed(rules, "/private/public/page"), true);
    assert.strictEqual(isPathAllowed(rules, "/news"), true);
});

test("a UA-specific group is preferred over the wildcard", () => {
    const groups = parseRobots(`
User-agent: *
Disallow: /

User-agent: CompanyIQ-bot
Disallow: /admin
`);
    const rules = rulesFor(groups, "CompanyIQ-bot");
    assert.strictEqual(isPathAllowed(rules, "/news"), true); // our UA may crawl everything except /admin
    assert.strictEqual(isPathAllowed(rules, "/admin/x"), false);
});

test("empty/absent robots means allowed", () => {
    assert.strictEqual(isPathAllowed(rulesFor(parseRobots(""), "CompanyIQ-bot"), "/anything"), true);
});

// ---------- extract ----------
test("htmlToText strips scripts/styles/markup", () => {
    const t = htmlToText("<style>x{}</style><p>Hello <b>world</b></p><script>evil()</script>");
    assert.strictEqual(t, "Hello world");
});

test("title and published date are extracted; date is null when absent", () => {
    const html = `<title>Press Release</title><meta property="article:published_time" content="2026-07-06T10:00:00Z">`;
    assert.strictEqual(extractTitle(html), "Press Release");
    assert.strictEqual(extractPublishedDate(html), "2026-07-06T10:00:00.000Z");
    assert.strictEqual(extractPublishedDate("<title>x</title>"), null);
});

test("links are discovered only within the allowlist, normalized", () => {
    const html = `<a href="/news/a">A</a><a href="https://evil.com/x">bad</a><a href="https://www.dallascounty.org/b/">B</a>`;
    const links = extractLinks(html, "https://dallascounty.org/", ["dallascounty.org"]);
    assert.ok(links.includes("https://dallascounty.org/news/a"));
    assert.ok(links.includes("https://www.dallascounty.org/b"));
    assert.ok(!links.some((l) => l.includes("evil.com")));
});

test("parsePage yields a stable hash that changes only with content", () => {
    const a = parsePage("<title>T</title><p>same</p>", "https://d.org/x", ["d.org"], "2026-07-24T00:00:00Z");
    const b = parsePage("<title>T</title><p>same</p>", "https://d.org/x", ["d.org"], "2026-07-25T00:00:00Z");
    const c = parsePage("<title>T</title><p>different</p>", "https://d.org/x", ["d.org"], "2026-07-24T00:00:00Z");
    assert.strictEqual(a.hash, b.hash, "hash must ignore fetch time");
    assert.notStrictEqual(a.hash, c.hash, "hash must change with content");
});

// ---------- snapshot / diff ----------
const pagesV1 = [
    { url: "https://d.org/a", title: "A", hash: "h1", publishedDate: "2026-07-01T00:00:00Z" },
    { url: "https://d.org/b", title: "B", hash: "h2", publishedDate: null, fetchedAt: "2026-07-24T00:00:00Z" },
];

test("first diff is a baseline, not a pile of 'new' items", () => {
    const curr = buildSnapshot("dallas", pagesV1);
    const diff = diffSnapshots(null, curr);
    assert.strictEqual(diff.isBaseline, true);
    assert.strictEqual(diff.hasChanges, false);
    assert.match(summarizeDiff(diff, "Dallas County"), /Baseline snapshot/);
});

test("second run surfaces ONLY genuine changes", () => {
    const prev = buildSnapshot("dallas", pagesV1);
    const pagesV2 = [
        { url: "https://d.org/a", title: "A", hash: "h1", publishedDate: "2026-07-01T00:00:00Z" }, // unchanged
        { url: "https://d.org/b", title: "B2", hash: "h2-CHANGED", publishedDate: "2026-07-24T00:00:00Z" }, // changed
        { url: "https://d.org/c", title: "C", hash: "h3", publishedDate: "2026-07-24T00:00:00Z" }, // new
    ];
    const curr = buildSnapshot("dallas", pagesV2);
    const diff = diffSnapshots(prev, curr);
    assert.strictEqual(diff.hasChanges, true);
    assert.deepStrictEqual(diff.added.map((p) => p.url), ["https://d.org/c"]);
    assert.deepStrictEqual(diff.changed.map((p) => p.url), ["https://d.org/b"]);
    assert.strictEqual(diff.unchanged, 1);
    const summary = summarizeDiff(diff, "Dallas County");
    assert.match(summary, /New pages \(1\)/);
    assert.match(summary, /Updated pages \(1\)/);
    assert.match(summary, /d\.org\/c/);
    assert.ok(!summary.includes("d.org/a"), "unchanged page must not appear in the brief");
});

test("a truncated (incomplete) crawl does not fabricate new/removed pages", () => {
    // prev reached {a,b}; curr (truncated) reached {a,c}. Without coverage
    // awareness this looks like "added c, removed b" — but both are just
    // coverage churn, not real changes. c has no fresh date, so it is suppressed.
    const prev = buildSnapshot("e", [
        { url: "https://d/a", hash: "h1", title: "A" },
        { url: "https://d/b", hash: "h2", title: "B" },
    ], "2026-07-20T00:00:00Z", false); // incomplete
    const curr = buildSnapshot("e", [
        { url: "https://d/a", hash: "h1", title: "A" },
        { url: "https://d/c", hash: "h3", title: "C" }, // no publishedDate
    ], "2026-07-24T00:00:00Z", false); // incomplete
    const diff = diffSnapshots(prev, curr);
    assert.strictEqual(diff.added.length, 0, "unreached page must not be reported as new");
    assert.strictEqual(diff.removed.length, 0, "unreached page must not be reported as removed");
    assert.ok(diff.suppressed >= 2);
    assert.strictEqual(diff.partialCoverage, true);
});

test("a genuinely dated-new page IS surfaced even on a partial crawl", () => {
    const prev = buildSnapshot("e", [{ url: "https://d/a", hash: "h1", title: "A" }], "2026-07-20T00:00:00Z", false);
    const curr = buildSnapshot("e", [
        { url: "https://d/a", hash: "h1", title: "A" },
        { url: "https://d/new", hash: "h9", title: "Grant awarded", publishedDate: "2026-07-23T00:00:00Z" },
    ], "2026-07-24T00:00:00Z", false);
    const diff = diffSnapshots(prev, curr);
    assert.deepStrictEqual(diff.added.map((p) => p.url), ["https://d/new"]);
});

test("a content change is reported even under partial coverage (both crawls saw it)", () => {
    const prev = buildSnapshot("e", [{ url: "https://d/a", hash: "h1", title: "A" }], "2026-07-20T00:00:00Z", false);
    const curr = buildSnapshot("e", [{ url: "https://d/a", hash: "h1-NEW", title: "A" }], "2026-07-24T00:00:00Z", false);
    const diff = diffSnapshots(prev, curr);
    assert.deepStrictEqual(diff.changed.map((p) => p.url), ["https://d/a"]);
});

test("no changes → empty summary (caller says 'nothing new')", () => {
    const prev = buildSnapshot("dallas", pagesV1);
    const curr = buildSnapshot("dallas", pagesV1);
    const diff = diffSnapshots(prev, curr);
    assert.strictEqual(diff.hasChanges, false);
    assert.strictEqual(summarizeDiff(diff, "Dallas County"), "");
});
