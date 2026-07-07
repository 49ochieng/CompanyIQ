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

async function withClient(server, fn) {
    const transport = new StreamableHTTPClientTransport(
        new URL(server.url),
        server.authHeader
            ? { requestInit: { headers: { Authorization: server.authHeader } } }
            : undefined
    );
    const client = new Client({ name: "companyiq", version: "1.0.0" });
    await client.connect(transport);
    try {
        return await fn(client);
    } finally {
        await client.close().catch(() => {});
    }
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
                // The model's own arguments only; optional whitelisted context
                // fields ride along under _context. Tokens/scope are
                // structurally excluded by buildPayload.
                const extra = buildPayload("", context, server.allowedContext);
                const outgoing = { ...args, ...(extra.context ? { _context: extra.context } : {}) };

                const text = await circuit.exec(mcpTool.name, (signal) =>
                    withClient(server, async (client) => {
                        const result = await client.callTool(
                            { name: mcpTool.name, arguments: outgoing },
                            undefined,
                            { signal }
                        );
                        if (result.isError) {
                            throw new Error(textFromContent(result.content) || "MCP tool returned an error");
                        }
                        return textFromContent(result.content);
                    })
                );
                return wrapUntrusted(`mcp:${server.name}/${mcpTool.name}`, text);
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

module.exports = { loadMcpTools, buildToolDefinition, filterTools, parseServers, MAX_DESCRIPTION };
