const { test, afterEach } = require("node:test");
const assert = require("node:assert");
const config = require("../config");
const { resolveUserContext, decodeJwtPayload } = require("./userContext");

function fakeJwt(claims) {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}

const originalMap = config.userScopeMap;
afterEach(() => {
    config.userScopeMap = originalMap;
});

test("not signed in yields empty context (DEV_USER_SCOPE fallback path)", () => {
    const ctx = resolveUserContext({ isSignedIn: false, activity: {} });
    assert.deepStrictEqual(ctx, {});
});

test("signed-in user maps to scope by UPN case-insensitively", () => {
    config.userScopeMap = JSON.stringify({ "Jane@Contoso.com": "RETAILER_200" });
    const token = fakeJwt({ oid: "oid-1", upn: "jane@CONTOSO.com", name: "Jane" });
    const ctx = resolveUserContext({ isSignedIn: true, userToken: token, activity: {} });
    assert.strictEqual(ctx.userScope, "RETAILER_200");
    assert.strictEqual(ctx.user.aadObjectId, "oid-1");
    assert.strictEqual(ctx.graphToken, token);
});

test("signed-in user maps to scope by object ID", () => {
    config.userScopeMap = JSON.stringify({ "OID-42": "RETAILER_100" });
    const token = fakeJwt({ oid: "oid-42", preferred_username: "someone@contoso.com" });
    const ctx = resolveUserContext({ isSignedIn: true, userToken: token, activity: {} });
    assert.strictEqual(ctx.userScope, "RETAILER_100");
});

test("unmapped signed-in user gets identity but no scope", () => {
    config.userScopeMap = JSON.stringify({ "other@contoso.com": "RETAILER_100" });
    const token = fakeJwt({ oid: "oid-9", upn: "stranger@contoso.com" });
    const ctx = resolveUserContext({ isSignedIn: true, userToken: token, activity: {} });
    assert.strictEqual(ctx.userScope, undefined);
    assert.ok(ctx.user);
    assert.ok(ctx.graphToken);
});

test("invalid USER_SCOPE_MAP JSON degrades to empty map", () => {
    config.userScopeMap = "{not json";
    const token = fakeJwt({ oid: "oid-1", upn: "jane@contoso.com" });
    const ctx = resolveUserContext({ isSignedIn: true, userToken: token, activity: {} });
    assert.strictEqual(ctx.userScope, undefined);
});

test("decodeJwtPayload handles malformed tokens", () => {
    assert.strictEqual(decodeJwtPayload("garbage"), undefined);
    assert.strictEqual(decodeJwtPayload("a.%%%.c"), undefined);
});
