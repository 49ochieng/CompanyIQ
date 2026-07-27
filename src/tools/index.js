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
const getCalendar = require("./getCalendar");
const getPlannerTasks = require("./getPlannerTasks");
const findPeople = require("./findPeople");
const webSearch = require("./webSearch");
const watchlistSearch = require("./watchlistSearch");
const watchlistBrief = require("./watchlistBrief");

const tools = [
    queryCompanyData,
    searchDocuments,
    searchSharePoint,
    searchOneDrive,
    searchEmail,
    getCalendar,
    getPlannerTasks,
    findPeople,
];

// Flag-gated: when CONNECTOR_PUBLIC_WEB_ENABLED is not "true", the tool is
// never registered and the model never sees it.
if (config.publicWebEnabled) {
    tools.push(webSearch);
}

// Watchlist tools register only when at least one entity is configured, so a
// deployment without WATCHLIST never exposes them.
if (config.watchlist && config.watchlist.trim() && config.watchlist.trim() !== "[]") {
    tools.push(watchlistSearch, watchlistBrief);
}

function validateTool(tool) {
    if (!tool.name || !tool.description || !tool.parameters || typeof tool.handler !== "function") {
        throw new Error(`Tool is missing required fields: ${tool.name || "<unnamed>"}`);
    }
}

for (const tool of tools) {
    validateTool(tool);
}

/** Register a connector-provided tool. Rejects name collisions. */
function registerTool(tool) {
    validateTool(tool);
    if (tools.some((t) => t.name === tool.name)) {
        throw new Error(`Tool name collision: '${tool.name}' is already registered`);
    }
    tools.push(tool);
}

function getTools() {
    return tools;
}

module.exports = { tools, getTools, registerTool };
