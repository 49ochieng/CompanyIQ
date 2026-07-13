// Power Automate flow runner — same philosophy as the SQL layer: the model may
// only invoke a WHITELISTED flow with SCHEMA-VALIDATED parameters. It cannot
// name an arbitrary URL, and it never sees the trigger URL at all.
//
// Auth (preferred → fallback):
//   1. Delegated OAuth — the flow's "When an HTTP request is received" trigger
//      set to "Any user in my tenant" / "Specific users in my tenant". We attach
//      the SIGNED-IN USER's bearer token (audience https://service.flow.microsoft.com/),
//      so the flow runs bound to the person who asked and the maker can restrict
//      who may trigger it. See:
//      https://learn.microsoft.com/en-us/power-automate/oauth-authentication
//   2. SAS only — the legacy "Anyone" trigger mode, where possession of the URL
//      is the only credential. Supported, but the URL is a secret: it is never
//      logged, never shown on the card, and never given to the model.
//
// Config: FLOWS env JSON —
//   [{ name, description, url, requiresConfirmation?, auth?: "user"|"sas",
//      sensitive?, parametersSchema: { field: {type, required?, enum?, maxLength?, description?} } }]
const config = require("../config");
const { AUTH_REQUIRED } = require("../auth/graph");

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TIMEOUT_MS = 30000;
const ALLOWED_TYPES = new Set(["string", "number", "boolean"]);

// The trigger URL must belong to Microsoft's flow infrastructure — a whitelist
// entry cannot be pointed at an attacker-controlled host.
const ALLOWED_HOST_RE =
    /(^|\.)(logic\.azure\.com|azure-apihub\.net|powerautomate\.com|flow\.microsoft\.com|powerplatform\.com|azurewebsites\.net)$/i;

function parseFlows(raw) {
    if (!raw) return [];
    let flows;
    try {
        flows = JSON.parse(raw);
    } catch (error) {
        console.error("FLOWS is not valid JSON; no flows loaded.", error.message);
        return [];
    }
    if (!Array.isArray(flows)) return [];
    return flows.filter((f) => {
        if (!f || !NAME_RE.test(f.name || "") || !f.url) {
            console.error(`Flow entry skipped (invalid name/url): ${JSON.stringify(f && f.name)}`);
            return false;
        }
        let host;
        try {
            const u = new URL(f.url);
            if (u.protocol !== "https:") throw new Error("not https");
            host = u.hostname;
        } catch {
            console.error(`Flow '${f.name}' skipped: trigger URL is not a valid https URL.`);
            return false;
        }
        if (!ALLOWED_HOST_RE.test(host)) {
            console.error(`Flow '${f.name}' skipped: host '${host}' is not a recognized Power Automate endpoint.`);
            return false;
        }
        return true;
    });
}

/** Validate model-supplied parameters against the flow's declared schema. */
function validateParameters(flow, raw) {
    const schema = flow.parametersSchema || {};
    const supplied = raw && typeof raw === "object" ? raw : {};
    const out = {};

    for (const key of Object.keys(supplied)) {
        if (!Object.prototype.hasOwnProperty.call(schema, key)) {
            return { ok: false, reason: `'${key}' is not a parameter of flow '${flow.name}'` };
        }
    }

    for (const [key, rule] of Object.entries(schema)) {
        const value = supplied[key];
        if (value === undefined || value === null || value === "") {
            if (rule.required) return { ok: false, reason: `missing required parameter '${key}'` };
            continue;
        }
        const type = ALLOWED_TYPES.has(rule.type) ? rule.type : "string";
        if (type === "number") {
            const n = Number(value);
            if (!Number.isFinite(n)) return { ok: false, reason: `'${key}' must be a number` };
            out[key] = n;
            continue;
        }
        if (type === "boolean") {
            if (typeof value === "boolean") { out[key] = value; continue; }
            const s = String(value).toLowerCase();
            if (["true", "yes", "1"].includes(s)) { out[key] = true; continue; }
            if (["false", "no", "0"].includes(s)) { out[key] = false; continue; }
            return { ok: false, reason: `'${key}' must be true or false` };
        }
        // string
        if (typeof value === "object") return { ok: false, reason: `'${key}' must be text` };
        const s = String(value);
        if (rule.maxLength && s.length > rule.maxLength) {
            return { ok: false, reason: `'${key}' exceeds ${rule.maxLength} characters` };
        }
        if (Array.isArray(rule.enum) && !rule.enum.includes(s)) {
            return { ok: false, reason: `'${key}' must be one of: ${rule.enum.join(", ")}` };
        }
        out[key] = s;
    }
    return { ok: true, params: out };
}

/** JSON-schema fragment describing the parameters of every whitelisted flow. */
function parametersProperty(flows) {
    const properties = {};
    for (const flow of flows) {
        for (const [key, rule] of Object.entries(flow.parametersSchema || {})) {
            if (!properties[key]) {
                properties[key] = {
                    type: ALLOWED_TYPES.has(rule.type) ? rule.type : "string",
                    description: `${rule.description || key} (used by flow '${flow.name}')`,
                    ...(Array.isArray(rule.enum) ? { enum: rule.enum } : {}),
                };
            }
        }
    }
    return properties;
}

function describeFlows(flows) {
    return flows
        .map((f) => {
            const params = Object.entries(f.parametersSchema || {})
                .map(([k, r]) => `${k}${r.required ? "*" : ""}`)
                .join(", ");
            return `'${f.name}': ${f.description || "(no description)"}${params ? ` [parameters: ${params}]` : ""}`;
        })
        .join(" | ");
}

/** Build the runFlow action from the configured whitelist (or null if none). */
function buildRunFlowAction() {
    if (!config.actionsFlowsEnabled) {
        return null;
    }
    const flows = parseFlows(config.flows);
    if (flows.length === 0) {
        return null;
    }

    return {
        name: "runFlow",
        description:
            "Run one of the organization's approved automation flows. Only these flows exist: " +
            describeFlows(flows) +
            ". Use ONLY when the user explicitly asks for it in their own message.",
        // Per-flow: a whitelist entry may set requiresConfirmation:false for a
        // routine, low-risk flow. Anything unspecified or ambiguous confirms.
        requiresConfirmation(args) {
            const flow = flows.find((f) => f.name === (args && args.flow));
            return flow ? flow.requiresConfirmation !== false : true;
        },
        parameters: {
            type: "object",
            properties: {
                flow: {
                    type: "string",
                    enum: flows.map((f) => f.name),
                    description: "Which approved flow to run.",
                },
                parameters: {
                    type: "object",
                    description: "Parameters for the selected flow.",
                    properties: parametersProperty(flows),
                },
            },
            required: ["flow"],
        },

        validate(args) {
            const flow = flows.find((f) => f.name === args.flow);
            if (!flow) {
                return { ok: false, reason: `unknown flow '${String(args.flow)}'` };
            }
            const validated = validateParameters(flow, args.parameters);
            if (!validated.ok) {
                return validated;
            }
            const fields = [{ label: "Flow", value: `${flow.name} — ${flow.description || ""}`.trim() }];
            if (Object.keys(validated.params).length > 0) {
                fields.push({
                    label: "Payload",
                    value: JSON.stringify(validated.params, null, 2),
                    monospace: true,
                });
            } else {
                fields.push({ label: "Payload", value: "(no parameters)" });
            }
            // The trigger URL is a secret — it is deliberately NOT shown here.
            return {
                ok: true,
                args: { flow: flow.name, parameters: validated.params },
                preview: {
                    title: `Run the '${flow.name}' flow`,
                    sensitive: !!flow.sensitive,
                    fields,
                },
            };
        },

        async handler(args, context) {
            const flow = flows.find((f) => f.name === args.flow);
            if (!flow) {
                return { error: "unknown_flow", message: "That automation flow is not available." };
            }

            const headers = { "Content-Type": "application/json" };

            // Preferred: run the flow AS THE USER (Entra OAuth on the trigger).
            if ((flow.auth || "user") === "user") {
                const token = context && context.getAudienceToken
                    ? await context.getAudienceToken(config.flowConnectionName)
                    : undefined;
                if (!token) {
                    return { ...AUTH_REQUIRED, connectionName: config.flowConnectionName };
                }
                headers.Authorization = `Bearer ${token}`;
            }

            const startedAt = Date.now();
            let status;
            try {
                const res = await fetch(flow.url, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(args.parameters || {}),
                    signal: AbortSignal.timeout(TIMEOUT_MS),
                });
                status = res.status;
                if (res.status === 401 || res.status === 403) {
                    // The flow's own access control said no — that is the security
                    // model working; never retry with a different identity.
                    logRun(flow.name, context, status, Date.now() - startedAt, false);
                    return {
                        error: "access_denied",
                        message:
                            `You don't have permission to run the '${flow.name}' flow. ` +
                            "Relay this to the user; do not retry.",
                    };
                }
                if (!res.ok) {
                    logRun(flow.name, context, status, Date.now() - startedAt, false);
                    return {
                        error: "flow_failed",
                        message: `The '${flow.name}' flow could not be started. Please try again later.`,
                    };
                }
            } catch (error) {
                logRun(flow.name, context, status, Date.now() - startedAt, false, error);
                return {
                    error: "flow_failed",
                    message: `The '${flow.name}' flow could not be reached. Please try again later.`,
                };
            }

            logRun(flow.name, context, status, Date.now() - startedAt, true);
            return { started: true, flow: flow.name };
        },
    };
}

/**
 * Audit a flow run. The trigger URL (which carries the SAS signature) is a
 * credential and is NEVER logged — only the flow's friendly name.
 */
function logRun(flowName, context, status, durationMs, ok, error) {
    console.log(
        JSON.stringify({
            event: "flow_run",
            flow: flowName,
            userObjectId: context && context.user ? context.user.aadObjectId : undefined,
            status,
            ok,
            durationMs,
            error: error ? String(error.message || error).slice(0, 120) : undefined,
        })
    );
}

module.exports = { buildRunFlowAction, parseFlows, validateParameters, ALLOWED_HOST_RE };
