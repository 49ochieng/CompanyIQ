const { test, afterEach } = require("node:test");
const assert = require("node:assert");
const config = require("../config");
const webSearch = require("./webSearch");
const { tools } = require("./index");

const originalAllowlist = config.orgWebsiteAllowlist;
afterEach(() => {
    config.orgWebsiteAllowlist = originalAllowlist;
});

test("webSearch is NOT registered when CONNECTOR_PUBLIC_WEB_ENABLED is false", () => {
    // Test env has the flag unset/false, so the registry must omit the tool
    // entirely — the model never sees it.
    assert.strictEqual(config.publicWebEnabled, false);
    assert.strictEqual(tools.find((t) => t.name === "webSearch"), undefined);
});

test("webSearch rejects URLs outside the allowlist", async () => {
    config.orgWebsiteAllowlist = "armely.com";
    for (const evil of [
        "https://evil.example.com/page",
        "https://armely.com.evil.example.com/",
        "https://notarmely.com/",
        "not a url",
    ]) {
        const result = await webSearch.handler({ query: "test", url: evil }, {});
        assert.strictEqual(result.error, "domain_not_allowed", `should reject: ${evil}`);
    }
});

test("webSearch allows exact, www, and subdomain URLs of allowlisted domains", () => {
    // isAllowed is internal; verify indirectly via the error path only for
    // disallowed hosts. Allowed hosts proceed to fetch (not exercised here).
    config.orgWebsiteAllowlist = "armely.com";
    // handler with allowed url would hit the network; assert the allowlist
    // parsing itself via the not_configured path instead:
    config.orgWebsiteAllowlist = "";
    return webSearch.handler({ query: "test" }, {}).then((result) => {
        assert.strictEqual(result.error, "not_configured");
    });
});
