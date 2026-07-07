// CompanyIQ tool registry. Every tool exports:
//   { name, description, parameters (JSON schema), handler(args, context) }
// The orchestrator registers each tool with the ChatPrompt at startup.
// Phase 4 adds webSearch.

const config = require("../config");
const searchDocuments = require("./searchDocuments");
const queryCompanyData = require("./queryCompanyData");
const searchSharePoint = require("./searchSharePoint");
const searchOneDrive = require("./searchOneDrive");
const searchEmail = require("./searchEmail");
const webSearch = require("./webSearch");

const tools = [queryCompanyData, searchDocuments, searchSharePoint, searchOneDrive, searchEmail];

// Flag-gated: when CONNECTOR_PUBLIC_WEB_ENABLED is not "true", the tool is
// never registered and the model never sees it.
if (config.publicWebEnabled) {
    tools.push(webSearch);
}

for (const tool of tools) {
    if (!tool.name || !tool.description || !tool.parameters || typeof tool.handler !== "function") {
        throw new Error(`Tool is missing required fields: ${tool.name || "<unnamed>"}`);
    }
}

module.exports = { tools };
