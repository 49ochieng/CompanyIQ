const { test } = require("node:test");
const assert = require("node:assert");
const { crawl } = require("./crawler");
const { parseWatchlist, findEntity, slugify } = require("./watchlist");

// A tiny fake site: a seed page linking to an internal page, an external link
// (must be ignored), and a robots-disallowed path.
const SITE = {
    "https://dallascounty.org": `<title>Home</title><a href="/news">News</a><a href="https://evil.com/x">bad</a><a href="/private/secret">secret</a>`,
    "https://dallascounty.org/news": `<title>News</title><p>New IT contract awarded.</p><a href="/">home</a>`,
    "https://dallascounty.org/private/secret": `<title>Secret</title><p>should not be fetched</p>`,
};
const ROBOTS = "User-agent: *\nDisallow: /private\n";

function fakeDeps(fetched) {
    return {
        delayMs: 0,
        robotsText: async () => ROBOTS,
        fetchText: async (url) => {
            fetched.push(url);
            if (url.endsWith("/robots.txt")) return ROBOTS;
            if (SITE[url] !== undefined) return SITE[url];
            throw new Error("HTTP 404");
        },
        cache: new Map(),
    };
}

test("crawler stays in the allowlist, obeys robots, and follows internal links", async () => {
    const fetched = [];
    const entity = { name: "Dallas County", slug: "dallas-county", domains: ["dallascounty.org"] };
    const res = await crawl(entity, fakeDeps(fetched));
    const urls = res.pages.map((p) => p.url).sort();
    assert.deepStrictEqual(urls, ["https://dallascounty.org", "https://dallascounty.org/news"]);
    // Never fetched the external domain or the robots-disallowed path.
    assert.ok(!fetched.some((u) => u.includes("evil.com")));
    assert.ok(!fetched.some((u) => u.includes("/private/secret")));
    // The news page's content is captured for indexing.
    const news = res.pages.find((p) => p.url.endsWith("/news"));
    assert.match(news.text, /New IT contract awarded/);
});

test("a seed that fails once is retried (a cold-start timeout doesn't abandon the crawl)", async () => {
    let seedCalls = 0;
    const entity = { name: "Dallas County", slug: "dallas-county", domains: ["dallascounty.org"] };
    const deps = {
        delayMs: 0,
        robotsText: async () => "",
        cache: new Map(),
        fetchText: async (url) => {
            if (url === "https://dallascounty.org") {
                seedCalls++;
                if (seedCalls === 1) throw new Error("timeout"); // first attempt fails
                return `<title>Home</title><p>ok</p>`;
            }
            throw new Error("HTTP 404");
        },
    };
    const res = await crawl(entity, deps);
    assert.strictEqual(seedCalls, 2, "seed should be retried once");
    assert.strictEqual(res.pages.length, 1);
});

test("depth bound stops the crawl", async () => {
    const fetched = [];
    const entity = { name: "Dallas County", slug: "dallas-county", domains: ["dallascounty.org"] };
    const res = await crawl(entity, { ...fakeDeps(fetched), maxDepth: 0 });
    assert.deepStrictEqual(res.pages.map((p) => p.url), ["https://dallascounty.org"]);
});

test("the TTL cache prevents a re-fetch within the window", async () => {
    const cache = new Map();
    const entity = { name: "Dallas County", slug: "dallas-county", domains: ["dallascounty.org"] };
    const f1 = [];
    await crawl(entity, { ...fakeDeps(f1), cache, ttlMs: 60000 });
    const f2 = [];
    await crawl(entity, { ...fakeDeps(f2), cache, ttlMs: 60000 });
    // Second run hits only robots.txt (per host), no page re-fetch.
    assert.ok(!f2.some((u) => u === "https://dallascounty.org" || u.endsWith("/news")), `unexpected refetch: ${f2}`);
});

// ---------- watchlist config ----------
test("WATCHLIST parses entities and normalizes domains/cadence", () => {
    const list = parseWatchlist(JSON.stringify([
        { name: "Dallas County", domains: ["https://dallascounty.org/"], description: "Client", topics: ["IT", "grants"], cadence: "daily" },
        { name: "No Domains" }, // skipped
    ]));
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].slug, "dallas-county");
    assert.deepStrictEqual(list[0].domains, ["dallascounty.org"]);
    assert.strictEqual(list[0].cadence, "daily");
});

test("findEntity resolves by name, slug, and fuzzy substring", () => {
    process.env.WATCHLIST = JSON.stringify([{ name: "Dallas County", domains: ["dallascounty.org"] }]);
    // config caches process.env at require; re-require fresh copy for the read.
    delete require.cache[require.resolve("../config")];
    delete require.cache[require.resolve("./watchlist")];
    const { findEntity: find } = require("./watchlist");
    assert.strictEqual(find("Dallas County").slug, "dallas-county");
    assert.strictEqual(find("dallas").slug, "dallas-county");
    assert.strictEqual(find("nope"), undefined);
    delete process.env.WATCHLIST;
    delete require.cache[require.resolve("../config")];
    delete require.cache[require.resolve("./watchlist")];
});

test("slugify is stable and url-safe", () => {
    assert.strictEqual(slugify("Dallas County!"), "dallas-county");
    assert.strictEqual(slugify("A & B, Inc."), "a-b-inc");
});
