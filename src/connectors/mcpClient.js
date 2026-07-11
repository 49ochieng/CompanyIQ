// MCP connector over Streamable HTTP using the official SDK.
// Config: MCP_SERVERS env JSON — [{name, url, authHeader?, allowedTools?, allowedContext?}]
// Each discovered tool registers as mcp_<server>_<tool>. Collisions are
// rejected, descriptions are capped so a malicious/verbose server cannot
// flood the system prompt, and results are wrapped as untrusted data.
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const config = require("../config");
const { getCircuit, unavailableResult } = require("./circuit");
const { buildPayload, wrapUntrusted } = require("./payload");
const { AUTH_REQUIRED } = require("../auth/graph");

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_DESCRIPTION = 500;

function parseServers(raw) {
    if (!raw) return [];
    let servers;
    try {
        servers = JSON.parse(raw);
    } catch (error) {
        console.error("MCP_SERVERS is not valid JSON; no MCP servers loaded.", error.message);
        return [];
    }
    if (!Array.isArray(servers)) return [];
    return servers.filter((s) => {
        if (!s || !NAME_RE.test(s.name || "") || !s.url) {
            console.error(`MCP server entry skipped (invalid name/url): ${JSON.stringify(s?.name)}`);
            return false;
        }
        return true;
    });
}

async function withClient(server, fn, authHeaderOverride) {
    const authHeader = authHeaderOverride ?? server.authHeader;
    const transport = new StreamableHTTPClientTransport(
        new URL(server.url),
        authHeader ? { requestInit: { headers: { Authorization: authHeader } } } : undefined
    );
    const client = new Client({ name: "companyiq", version: "1.0.0" });
    await client.connect(transport);
    try {
        return await fn(client);
    } finally {
        await client.close().catch(() => {});
    }
}

/** True when an error is the remote service refusing THIS user (401/403). */
function isAccessDenied(error) {
    const text = String((error && error.message) || error || "");
    return /\b40[13]\b/.test(text) || /unauthorized|forbidden/i.test(text);
}

/** Filter a server's tool list by its allowedTools config (if present). */
function filterTools(tools, allowedTools) {
    if (!Array.isArray(allowedTools) || allowedTools.length === 0) {
        return tools;
    }
    return tools.filter((t) => allowedTools.includes(t.name));
}

/**
 * Validate + convert one MCP tool into a registry tool definition.
 * Returns { ok: true, tool } or { ok: false, reason }.
 * Pure (no I/O) so it is unit-testable.
 */
function buildToolDefinition(server, mcpTool, existingNames) {
    if (!NAME_RE.test(mcpTool.name || "")) {
        return { ok: false, reason: `invalid tool name '${String(mcpTool.name)}'` };
    }
    const namespaced = `mcp_${server.name}_${mcpTool.name}`;
    if (existingNames.includes(namespaced)) {
        return { ok: false, reason: `name collision: '${namespaced}' already registered` };
    }
    const schema = mcpTool.inputSchema;
    const parameters =
        schema && typeof schema === "object" && schema.type === "object"
            ? schema
            : { type: "object", properties: {} };

    return {
        ok: true,
        tool: {
            name: namespaced,
            description: `[External MCP tool from '${server.name}'] ${(mcpTool.description || "").trim()}`.slice(
                0,
                MAX_DESCRIPTION
            ),
            parameters,
            async handler(args, context) {
                const circuit = getCircuit(`mcp:${server.name}`);
                if (circuit.isOpen()) {
                    return unavailableResult(`mcp:${server.name}`, circuit.status().retryInMs);
                }

                // authMode "user": the request carries the signed-in user's
                // token for the configured audience — results are permission-
                // trimmed by the remote service per user.
                let authHeaderOverride;
                if (server.authMode === "user") {
                    const connectionName = server.connection || "fabric";
                    const token = context && context.getAudienceToken
                        ? await context.getAudienceToken(connectionName)
                        : undefined;
                    if (!token) {
                        return { ...AUTH_REQUIRED, connectionName };
                    }
                    authHeaderOverride = `Bearer ${token}`;
                }

                // The model's own arguments only; optional whitelisted context
                // fields ride along under _context. Tokens/scope are
                // structurally excluded by buildPayload.
                const extra = buildPayload("", context, server.allowedContext);
                const outgoing = { ...args, ...(extra.context ? { _context: extra.context } : {}) };

                const outcome = await circuit.exec(mcpTool.name, (signal) =>
                    withClient(server, async (client) => {
                        const result = await client.callTool(
                            { name: mcpTool.name, arguments: outgoing },
                            undefined,
                            { signal }
                        );
                        if (result.isError) {
                            throw new Error(textFromContent(result.content) || "MCP tool returned an error");
                        }
                        return { text: textFromContent(result.content) };
                    }, authHeaderOverride).catch((error) => {
                        // A 401/403 under user identity is the permission model
                        // working — surface it cleanly, don't trip the breaker.
                        if (server.authMode === "user" && isAccessDenied(error)) {
                            return { accessDenied: true };
                        }
                        throw error;
                    })
                );
                if (outcome.accessDenied) {
                    return {
                        error: "access_denied",
                        message:
                            "You don't have access to this service with your account. " +
                            "Relay this to the user; do not retry or use another tool for it.",
                    };
                }
                return wrapUntrusted(`mcp:${server.name}/${mcpTool.name}`, outcome.text);
            },
        },
    };
}

function textFromContent(content) {
    if (!Array.isArray(content)) return "";
    return content
        .filter((c) => c && c.type === "text")
        .map((c) => c.text)
        .join("\n");
}

/** Discover and register all configured MCP tools. */
async function loadMcpTools(registerTool, existingNames) {
    const servers = parseServers(config.mcpServers);
    for (const server of servers) {
        try {
            const listed = await withClient(server, (client) => client.listTools());
            const candidates = filterTools(listed.tools || [], server.allowedTools);
            let registered = 0;
            for (const mcpTool of candidates) {
                const built = buildToolDefinition(server, mcpTool, existingNames());
                if (!built.ok) {
                    console.error(`MCP tool from '${server.name}' rejected: ${built.reason}`);
                    continue;
                }
                registerTool(built.tool);
                registered++;
            }
            console.log(
                JSON.stringify({ event: "mcp_init", server: server.name, toolsRegistered: registered })
            );
        } catch (error) {
            console.error(`MCP server '${server.name}' unavailable at startup: ${error.message}`);
        }
    }
    return servers.map((s) => s.name);
}

module.exports = {
    loadMcpTools,
    buildToolDefinition,
    filterTools,
    parseServers,
    withClient,
    textFromContent,
    isAccessDenied,
    MAX_DESCRIPTION,
};
