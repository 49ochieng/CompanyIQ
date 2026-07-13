const { test, afterEach } = require("node:test");
const assert = require("node:assert");
const config = require("../config");
const { buildRunFlowAction, parseFlows, validateParameters } = require("./runFlow");
const { buildConfirmationCard, truncate } = require("../formatting/actionCard");

const SAS_URL =
    "https://prod-12.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=SUPERSECRETSIGNATURE123";

const FLOW = {
    name: "notify_ops",
    description: "Post a supply-chain alert to the Ops channel.",
    url: SAS_URL,
    parametersSchema: {
        message: { type: "string", required: true, maxLength: 200, description: "Alert text." },
        severity: { type: "string", enum: ["low", "high"], description: "Severity." },
    },
};

const originalFlows = config.flows;
const originalEnabled = config.actionsFlowsEnabled;
afterEach(() => {
    config.flows = originalFlows;
    config.actionsFlowsEnabled = originalEnabled;
});

function withFlows(flows) {
    config.actionsFlowsEnabled = true;
    config.flows = JSON.stringify(flows);
    return buildRunFlowAction();
}

test("runFlow is NOT registered when the flag is off", () => {
    config.actionsFlowsEnabled = false;
    config.flows = JSON.stringify([FLOW]);
    assert.strictEqual(buildRunFlowAction(), null);

    // …and the live registry omits it (the test env has the flag off).
    const { getActions } = require("./index");
    assert.strictEqual(getActions().find((a) => a.name === "runFlow"), undefined);
});

test("runFlow is not registered when the whitelist is empty", () => {
    config.actionsFlowsEnabled = true;
    config.flows = "[]";
    assert.strictEqual(buildRunFlowAction(), null);
});

test("only whitelisted flows can be named", () => {
    const action = withFlows([FLOW]);
    assert.deepStrictEqual(action.parameters.properties.flow.enum, ["notify_ops"]);
    const bad = action.validate({ flow: "delete_everything", parameters: {} });
    assert.strictEqual(bad.ok, false);
    assert.match(bad.reason, /unknown flow/);
});

test("a flow URL on a non-Microsoft host is refused at load time", () => {
    const evil = parseFlows(JSON.stringify([{ ...FLOW, url: "https://evil.example.com/hook" }]));
    assert.strictEqual(evil.length, 0);
    const insecure = parseFlows(JSON.stringify([{ ...FLOW, url: "http://prod-12.westus.logic.azure.com/x" }]));
    assert.strictEqual(insecure.length, 0);
    const ok = parseFlows(JSON.stringify([FLOW]));
    assert.strictEqual(ok.length, 1);
});

test("parameters are schema-validated: unknown, missing, over-length, bad enum", () => {
    assert.match(validateParameters(FLOW, { nope: "x" }).reason, /not a parameter/);
    assert.match(validateParameters(FLOW, {}).reason, /missing required parameter 'message'/);
    assert.match(validateParameters(FLOW, { message: "x".repeat(201) }).reason, /exceeds 200/);
    assert.match(validateParameters(FLOW, { message: "hi", severity: "nuclear" }).reason, /must be one of/);
    const good = validateParameters(FLOW, { message: "line down", severity: "high" });
    assert.strictEqual(good.ok, true);
    assert.deepStrictEqual(good.params, { message: "line down", severity: "high" });
});

test("the SAS trigger URL never reaches the card or the model", () => {
    const action = withFlows([FLOW]);
    const v = action.validate({ flow: "notify_ops", parameters: { message: "line down" } });
    assert.strictEqual(v.ok, true);

    const cardJson = JSON.stringify(buildConfirmationCard("pid", v.preview));
    assert.ok(!cardJson.includes("SUPERSECRETSIGNATURE123"), "SAS signature leaked into the card");
    assert.ok(!cardJson.includes("logic.azure.com"), "trigger URL leaked into the card");

    // The model only ever sees the action schema + description.
    const exposed = JSON.stringify(action.parameters) + action.description;
    assert.ok(!exposed.includes("SUPERSECRETSIGNATURE123"));
    assert.ok(!exposed.includes("logic.azure.com"));
});

test("the payload renders in a monospace block; header is plain (no warning icon)", () => {
    const action = withFlows([FLOW]);
    const v = action.validate({ flow: "notify_ops", parameters: { message: "line down", severity: "high" } });
    const card = buildConfirmationCard("pid", v.preview);

    assert.match(card.body[0].text, /^Confirm: Run the 'notify_ops' flow$/);
    assert.ok(!card.body[0].text.includes("⚠"), "routine action must not use a warning icon");

    const mono = card.body.find((b) => b.type === "Container");
    assert.ok(mono, "payload should render in its own container");
    assert.strictEqual(mono.items[0].fontType, "Monospace");
    assert.match(mono.items[0].text, /"message": "line down"/);
});

test("a flow marked sensitive gets an explicit caution line", () => {
    const action = withFlows([{ ...FLOW, sensitive: true }]);
    const v = action.validate({ flow: "notify_ops", parameters: { message: "x" } });
    const card = buildConfirmationCard("pid", v.preview);
    assert.match(card.body[1].text, /sensitive/i);
});

test("truncation is always disclosed, never silent", () => {
    const long = "x".repeat(2000);
    const out = truncate(long);
    assert.match(out, /truncated — \d+ more characters will still be included/);
});

test("a flow needs the user's delegated token; no token -> auth_required, no call", async () => {
    const action = withFlows([FLOW]);
    let fetched = false;
    const originalFetch = global.fetch;
    global.fetch = async () => { fetched = true; throw new Error("must not be called"); };
    try {
        const r = await action.handler({ flow: "notify_ops", parameters: { message: "x" } }, {
            getAudienceToken: async () => undefined,
        });
        assert.strictEqual(r.error, "auth_required");
        assert.strictEqual(r.connectionName, "flow");
        assert.strictEqual(fetched, false);
    } finally {
        global.fetch = originalFetch;
    }
});

test("the request carries the user's bearer token and the validated payload", async () => {
    const action = withFlows([FLOW]);
    let captured;
    const originalFetch = global.fetch;
    global.fetch = async (url, init) => {
        captured = { url, init };
        return { ok: true, status: 202 };
    };
    try {
        const r = await action.handler(
            { flow: "notify_ops", parameters: { message: "line down", severity: "high" } },
            { getAudienceToken: async (c) => (c === "flow" ? "USER-FLOW-TOKEN" : undefined) }
        );
        assert.strictEqual(r.started, true);
        assert.strictEqual(captured.url, SAS_URL);
        assert.strictEqual(captured.init.headers.Authorization, "Bearer USER-FLOW-TOKEN");
        assert.deepStrictEqual(JSON.parse(captured.init.body), { message: "line down", severity: "high" });
    } finally {
        global.fetch = originalFetch;
    }
});

test("a 403 from the flow is a clean access-denied, never retried", async () => {
    const action = withFlows([FLOW]);
    let calls = 0;
    const originalFetch = global.fetch;
    global.fetch = async () => { calls++; return { ok: false, status: 403 }; };
    try {
        const r = await action.handler({ flow: "notify_ops", parameters: { message: "x" } }, {
            getAudienceToken: async () => "T",
        });
        assert.strictEqual(r.error, "access_denied");
        assert.strictEqual(calls, 1, "must not retry with another identity");
    } finally {
        global.fetch = originalFetch;
    }
});

test("the SAS URL is never written to the audit log", async () => {
    const action = withFlows([FLOW]);
    const logs = [];
    const originalLog = console.log;
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: true, status: 202 });
    console.log = (l) => logs.push(l);
    try {
        await action.handler({ flow: "notify_ops", parameters: { message: "x" } }, {
            getAudienceToken: async () => "T",
            user: { aadObjectId: "oid-1" },
        });
    } finally {
        console.log = originalLog;
        global.fetch = originalFetch;
    }
    const all = logs.join("\n");
    assert.match(all, /"event":"flow_run"/);
    assert.ok(!all.includes("SUPERSECRETSIGNATURE123"), "SAS signature written to the log");
    assert.ok(!all.includes("logic.azure.com"), "trigger URL written to the log");
});
