// REGRESSION LOCK for the load-bearing line of the Fabric security model.
//
// The Fabric source is user-scoped ONLY because its TDS connection carries a
// real person's delegated token. Locally (no Teams SSO) it falls back to the
// developer's own az-login identity — still a person.
//
// On Azure, `DefaultAzureCredential` would resolve to the app's MANAGED
// IDENTITY. If that fallback ever fired in Azure, the source would silently
// become app-identity: every CompanyIQ user would see identical lakehouse data,
// with no error, no label, and no sign that anything had changed.
//
// These tests assert that is impossible.
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");

const config = require("../../config");
const fabric = require("./fabricLakehouse");
const catalog = require("../catalogs/fabricLakehouse");

const MANAGED_IDENTITY_TOKEN = "MANAGED-IDENTITY-TOKEN-MUST-NEVER-BE-USED";

const realCreateDevCredential = fabric._createDevCredential;
let credentialConstructed;

const originalEnv = {
    RUNNING_ON_AZURE: process.env.RUNNING_ON_AZURE,
    WEBSITE_INSTANCE_ID: process.env.WEBSITE_INSTANCE_ID,
};
const originalDevFlag = config.fabricLocalDevIdentity;
const originalEndpoint = config.fabricEndpoint;
const originalDatabase = config.fabricDatabase;

beforeEach(() => {
    credentialConstructed = false;
    // Stand in for the real credential. On Azure, DefaultAzureCredential is
    // exactly what would hand back a managed-identity (app) token.
    fabric._createDevCredential = () => {
        credentialConstructed = true;
        return { async getToken() { return { token: MANAGED_IDENTITY_TOKEN }; } };
    };
    delete process.env.RUNNING_ON_AZURE;
    delete process.env.WEBSITE_INSTANCE_ID;
    config.fabricEndpoint = "test.datawarehouse.fabric.microsoft.com";
    config.fabricDatabase = "TestLake";
    fabric._devCredential = undefined; // clear the memoised credential
});

afterEach(() => {
    fabric._createDevCredential = realCreateDevCredential;
    for (const [k, v] of Object.entries(originalEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    config.fabricLocalDevIdentity = originalDevFlag;
    config.fabricEndpoint = originalEndpoint;
    config.fabricDatabase = originalDatabase;
    fabric._devCredential = undefined;
});

// ---------------------------------------------------------------------------
// THE GUARD
// ---------------------------------------------------------------------------
test("ON AZURE: the developer-identity fallback is impossible (RUNNING_ON_AZURE)", async () => {
    process.env.RUNNING_ON_AZURE = "1";
    config.fabricLocalDevIdentity = true; // even if someone sets the flag in Azure

    const token = await fabric.getToken({}); // no user token available

    assert.strictEqual(token, undefined, "must not produce a token without a user");
    assert.strictEqual(credentialConstructed, false, "DefaultAzureCredential must never be constructed on Azure");
    assert.notStrictEqual(token, MANAGED_IDENTITY_TOKEN);
});

test("ON AZURE: the guard also trips on WEBSITE_INSTANCE_ID alone", async () => {
    delete process.env.RUNNING_ON_AZURE;
    process.env.WEBSITE_INSTANCE_ID = "abc123"; // App Service always sets this
    config.fabricLocalDevIdentity = true;

    const token = await fabric.getToken({});
    assert.strictEqual(token, undefined);
    assert.strictEqual(credentialConstructed, false, "the managed identity must be unreachable");
});

test("ON AZURE: a query without a user token is refused, never run as the app", async () => {
    process.env.RUNNING_ON_AZURE = "1";
    config.fabricLocalDevIdentity = true;

    const compiled = fabric.compile({ table: "patients" });
    assert.strictEqual(compiled.ok, true);

    const result = await fabric.execute(compiled, {}); // no getAudienceToken
    assert.strictEqual(result.error, "auth_required");
    assert.strictEqual(result.connectionName, "fabric_sql");
    assert.strictEqual(credentialConstructed, false, "must not fall back to app identity to satisfy the query");
});

test("ON AZURE: probe reports not-signed-in rather than probing as the app", async () => {
    process.env.RUNNING_ON_AZURE = "1";
    config.fabricLocalDevIdentity = true;

    const probe = await fabric.probe({});
    assert.strictEqual(probe.ok, false);
    assert.strictEqual(probe.reason, "not_signed_in");
    assert.strictEqual(credentialConstructed, false);
});

// ---------------------------------------------------------------------------
// The guard is only meaningful if the fallback DOES work off Azure — otherwise
// these tests would pass for the wrong reason.
// ---------------------------------------------------------------------------
test("OFF AZURE: the developer-identity fallback works (so the guard above is real)", async () => {
    config.fabricLocalDevIdentity = true;

    const token = await fabric.getToken({});
    assert.strictEqual(token, MANAGED_IDENTITY_TOKEN, "locally, the az-login identity is used");
    assert.strictEqual(credentialConstructed, true);
});

test("OFF AZURE: the fallback still requires the explicit local flag", async () => {
    config.fabricLocalDevIdentity = false;

    const token = await fabric.getToken({});
    assert.strictEqual(token, undefined, "no implicit credential fallback");
    assert.strictEqual(credentialConstructed, false);
});

// ---------------------------------------------------------------------------
// A real user's token always wins, on or off Azure.
// ---------------------------------------------------------------------------
test("a signed-in user's token is always preferred, and no credential is constructed", async () => {
    process.env.RUNNING_ON_AZURE = "1";
    config.fabricLocalDevIdentity = true;

    const token = await fabric.getToken({
        getAudienceToken: async (name) => (name === "fabric_sql" ? "USER-DELEGATED-TOKEN" : undefined),
    });

    assert.strictEqual(token, "USER-DELEGATED-TOKEN");
    assert.strictEqual(credentialConstructed, false);
});

test("the token is requested from the fabric_sql connection, not the fabric (REST) one", async () => {
    const asked = [];
    await fabric.getToken({
        getAudienceToken: async (name) => {
            asked.push(name);
            return "T";
        },
    });
    // The REST/MCP audience (api.fabric.microsoft.com) is rejected by TDS.
    assert.deepStrictEqual(asked, ["fabric_sql"]);
});

// ---------------------------------------------------------------------------
// Identity and scope policy must not drift apart.
// ---------------------------------------------------------------------------
test("the source declares user identity and its catalog declares enforced_by_source", () => {
    assert.strictEqual(
        fabric.identity,
        "user",
        "if this ever becomes 'app', the scope policy and the response labelling MUST be revisited"
    );
    assert.strictEqual(catalog.scope.policy, "enforced_by_source");
    assert.strictEqual(
        catalog.scope.column,
        null,
        "enforced_by_source means the engine filters by identity — there is no predicate column"
    );
});
