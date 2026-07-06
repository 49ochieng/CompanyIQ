// CompanyIQ tool registry. Every tool exports:
//   { name, description, parameters (JSON schema), handler(args, context) }
// The orchestrator registers each tool with the ChatPrompt at startup.
// Phase 3 adds searchSharePoint, searchOneDrive, searchEmail; Phase 4 adds webSearch.

const searchDocuments = require("./searchDocuments");
const queryCompanyData = require("./queryCompanyData");

const tools = [queryCompanyData, searchDocuments];

for (const tool of tools) {
    if (!tool.name || !tool.description || !tool.parameters || typeof tool.handler !== "function") {
        throw new Error(`Tool is missing required fields: ${tool.name || "<unnamed>"}`);
    }
}

module.exports = { tools };
