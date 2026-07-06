// CompanyIQ tool registry. Every tool exports:
//   { name, description, parameters (JSON schema), handler(args, context) }
// The orchestrator registers each tool with the ChatPrompt at startup.
// Phase 4 adds webSearch.

const searchDocuments = require("./searchDocuments");
const queryCompanyData = require("./queryCompanyData");
const searchSharePoint = require("./searchSharePoint");
const searchOneDrive = require("./searchOneDrive");
const searchEmail = require("./searchEmail");

const tools = [queryCompanyData, searchDocuments, searchSharePoint, searchOneDrive, searchEmail];

for (const tool of tools) {
    if (!tool.name || !tool.description || !tool.parameters || typeof tool.handler !== "function") {
        throw new Error(`Tool is missing required fields: ${tool.name || "<unnamed>"}`);
    }
}

module.exports = { tools };
