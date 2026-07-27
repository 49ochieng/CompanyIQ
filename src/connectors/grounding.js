// Grounding with Bing Search — the lean public-web intelligence path.
//
// Unlike a full agent backed by a private knowledge base, this is a bare
// Grounding-with-Bing call: an inline Responses request with only the
// `bing_grounding` tool, no persistent agent, no private data source. It is
// invoked with the BOT's own credential (identity: app) because it reads
// nothing user-specific — only the public web.
//
// userScoped classification — the basis, stated (a "true" needs a reason, not
// just a flag): this connector's ONLY data source is Bing public web search.
// There is no per-user or org-private corpus behind it, so there is nothing to
// trim per caller and nothing it could return that
// exceeds a caller's own access — every result is public to everyone. Hence
// `userScoped: true` is correct and honest here (config must still declare it).
"use strict";
const config = require("../config");
const { getBearerTokenProvider } = require("@azure/identity");
const { getAzureCredential } = require("../auth/azureCredential");
const { getCircuit, unavailableResult } = require("./circuit");
const { wrapUntrusted } = require("./payload");
const { assertUserScoped } = require("./validate");
const { extractOutputText, extractCitations } = require("./foundryAgent");

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VALID_FRESHNESS = new Set(["day", "week", "month"]);

let tokenProvider;
function getGroundingToken() {
    if (!tokenProvider) {
        tokenProvider = getBearerTokenProvider(getAzureCredential(), "https://ai.azure.com/.default");
    }
    return tokenProvider();
}

function parseConfig(raw) {
    if (!raw) return null;
    let cfg;
    try {
        cfg = JSON.parse(raw);
    } catch (error) {
        console.error("WEB_GROUNDING is not valid JSON; grounding disabled.", error.message);
        return null;
    }
    if (Array.isArray(cfg)) cfg = cfg[0];
    if (!cfg || !NAME_RE.test(cfg.name || "") || !cfg.projectEndpoint || !cfg.connectionId || !cfg.model) {
        console.error("WEB_GROUNDING entry invalid (need name/projectEndpoint/connectionId/model); grounding disabled.");
        return null;
    }
    return cfg;
}

/**
 * Run one Grounding-with-Bing query. Returns { text, citations:[{title,url}] }.
 * `freshness` limits recency (day|week|month); invalid values are dropped
 * rather than sent (the API rejects anything else).
 */
async function groundedSearch(cfg, query, opts = {}) {
    const bearer = await getGroundingToken();
    const searchConfig = {
        project_connection_id: cfg.connectionId,
        count: opts.count || cfg.count || 5,
        market: opts.market || cfg.market || "en-US",
        set_lang: "en",
    };
    const freshness = opts.freshness || cfg.freshness;
    if (freshness && VALID_FRESHNESS.has(freshness)) {
        searchConfig.freshness = freshness;
    }
    const endpoint = cfg.projectEndpoint.replace(/\/+$/, "");
    const res = await fetch(`${endpoint}/openai/v1/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            model: cfg.model,
            input: query,
            tools: [{ type: "bing_grounding", bing_grounding: { search_configurations: [searchConfig] } }],
        }),
        signal: opts.signal,
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Grounding call failed: ${res.status} ${detail.slice(0, 200)}`);
    }
    const data = await res.json();
    return { text: extractOutputText(data), citations: extractCitations(data) };
}

// Public-organizational-scope discipline is baked into the tool description so
// the model won't wander into surveilling individuals on its own.
const SCOPE_NOTE =
    "Public organizational information only — news, contracts, grants, press releases, public meeting " +
    "agendas. Never use it to surveil, profile, or infer about specific individuals.";

function buildGroundingTool(cfg) {
    return {
        name: `ask_agent_${cfg.name}`,
        description: `[External agent — live public web search via Bing] ${(cfg.description || "Search the public web for current information.").trim()} ${SCOPE_NOTE}`.slice(0, 500),
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "The public-web question to research, self-contained." },
                freshness: { type: "string", enum: ["day", "week", "month"], description: "Optional recency limit." },
            },
            required: ["query"],
        },
        async handler(args, context) {
            const circuit = getCircuit(`grounding:${cfg.name}`);
            if (circuit.isOpen()) {
                return unavailableResult(`grounding:${cfg.name}`, circuit.status().retryInMs);
            }
            const outcome = await circuit.exec(cfg.name, (signal) =>
                groundedSearch(cfg, args.query, { freshness: args.freshness, signal })
            );
            return wrapUntrusted(`agent:${cfg.name}`, outcome.text, {
                userScoped: cfg.userScoped,
                citations: outcome.citations && outcome.citations.length ? outcome.citations : undefined,
            });
        },
    };
}

function loadGroundingAgents(registerTool) {
    const cfg = parseConfig(config.webGrounding);
    if (!cfg) return [];
    // Same discipline as every connector: an explicit userScoped is required.
    // For this one the correct value is `true` (see the module header for the
    // stated basis: Bing public web only, no private corpus to trim or leak).
    assertUserScoped(cfg, "Web grounding");
    registerTool(buildGroundingTool(cfg));
    return [cfg.name];
}

/** The grounding config, for direct reuse by watchlist_search. */
function getGroundingConfig() {
    return parseConfig(config.webGrounding);
}

module.exports = { loadGroundingAgents, buildGroundingTool, parseConfig, groundedSearch, getGroundingConfig, SCOPE_NOTE };
