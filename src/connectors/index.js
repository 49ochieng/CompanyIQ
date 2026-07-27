// Connector bootstrap: registers external agents and MCP tools into the
// existing tool registry at startup. CompanyIQ remains the orchestrator —
// connectors are just tools; nothing external can reach the database except
// through queryCompanyData's intent whitelist.
const { registerTool, getTools } = require("../tools");
const { loadFoundryAgents } = require("./foundryAgent");
const { loadHttpAgents } = require("./httpAgent");
const { loadFabricAgents } = require("./fabricAgent");
const { loadCopilotStudioAgents } = require("./copilotStudioAgent");
const { loadMcpTools } = require("./mcpClient");
const { loadGroundingAgents } = require("./grounding");
const { allCircuitStatuses } = require("./circuit");
const config = require("../config");

let summary = {
    foundryAgents: [],
    httpAgents: [],
    fabricAgents: [],
    copilotStudioAgents: [],
    mcpServers: [],
    groundingAgents: [],
};

async function initConnectors() {
    summary.foundryAgents = loadFoundryAgents(registerTool);
    summary.httpAgents = loadHttpAgents(registerTool);
    summary.fabricAgents = loadFabricAgents(registerTool);
    summary.copilotStudioAgents = loadCopilotStudioAgents(registerTool);
    summary.groundingAgents = loadGroundingAgents(registerTool);
    summary.mcpServers = await loadMcpTools(
        registerTool,
        () => getTools().map((t) => t.name)
    );
    console.log(JSON.stringify({ event: "connectors_init", ...summary }));
    return summary;
}

/** For the /agents command: configured connectors + circuit state. */
function connectorStatus() {
    const circuits = new Map(allCircuitStatuses().map((s) => [s.name, s]));
    const entry = (kind, name) => {
        const c = circuits.get(`${kind}:${name}`);
        return {
            name,
            kind,
            state: c ? c.state : "closed",
            consecutiveFailures: c ? c.consecutiveFailures : 0,
        };
    };
    return [
        ...summary.foundryAgents.map((n) => entry("foundry", n)),
        ...summary.httpAgents.map((n) => entry("http", n)),
        ...summary.fabricAgents.map((n) => entry("fabric", n)),
        ...summary.copilotStudioAgents.map((n) => entry("copilotstudio", n)),
        ...summary.groundingAgents.map((n) => entry("grounding", n)),
        ...summary.mcpServers.map((n) => entry("mcp", n)),
    ];
}

module.exports = { initConnectors, connectorStatus };
