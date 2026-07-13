// Slash commands, parsed before the orchestrator sees the message.
// A command either replies directly (`reply`) or routes a restricted turn
// (`turn: { text, allowedTools }`) so the model only sees the named tools.
const config = require("../config");
const { scopeMapStats } = require("../auth/userContext");

const HELP_TEXT = [
    "**CompanyIQ commands**",
    "- `/help` — this list",
    "- `/whoami` — your signed-in identity, data scope, and available tools",
    "- `/data <question>` — query company product data only",
    "- `/docs <query>` — search internal documents only",
    "- `/mail <query>` — search your email only",
    "- `/calendar [today|week]` — your upcoming meetings",
    "- `/agents` — configured external agents/MCP servers and their status",
    "- `/web <query>` — search the public web (when enabled)",
    "- `/subscribe daily <question>` — get the answer delivered on a schedule (`daily`, `hourly`, `test`)",
    "- `/unsubscribe` — stop all your scheduled digests",
    "- `/signin` — sign in (you can also just type `sign in`)",
    "- `/signout` — sign out, so you can test the sign-in flow again",
    "",
    "Anything without a leading `/` is answered with all available tools.",
].join("\n");

// Plain-text synonyms that should start the sign-in flow, never AF-1.
function isSignInMessage(text) {
    return /^\s*(sign\s*-?\s*in|log\s*-?\s*in|signin|login)\s*[.!]*\s*$/i.test(text || "");
}

/**
 * @param {string} text Incoming message text.
 * @returns {{command: string, args: string} | null} null when not a command.
 */
function parseCommand(text) {
    const match = (text || "").trim().match(/^\/([A-Za-z]+)(?:\s+([\s\S]*))?$/);
    if (!match) {
        return null;
    }
    return { command: match[1].toLowerCase(), args: (match[2] || "").trim() };
}

function usage(command, example) {
    return `Usage: \`/${command} <${example}>\` — add what you want to ask.`;
}

/**
 * Decide what a parsed command does.
 * @param {{command: string, args: string}} parsed
 * @param {{userContext: Object, isSignedIn?: boolean, connectorStatus: () => Array, toolNames: string[]}} deps
 * @returns {{reply?: string, turn?: {text: string, allowedTools: string[]}}}
 */
function buildCommandOutcome(parsed, deps) {
    const { command, args } = parsed;

    switch (command) {
        case "help":
            return { reply: HELP_TEXT };

        case "whoami": {
            const user = deps.userContext && deps.userContext.user;
            const lines = [];
            const mapStats = scopeMapStats();
            if (user) {
                lines.push(`**Signed in as:** ${user.upn || user.aadObjectId}${user.name ? ` (${user.name})` : ""}`);
                lines.push(`**Data scope:** ${deps.userContext.userScope || "none assigned — company data queries are unavailable"}`);
                lines.push(
                    `**Scope map:** ${mapStats.entries} entr${mapStats.entries === 1 ? "y" : "ies"} loaded` +
                    (deps.userContext.userScope
                        ? " (you matched)"
                        : mapStats.entries === 0
                            ? " — USER_SCOPE_MAP is empty; add your UPN to it and restart"
                            : " — none matched your UPN or object ID")
                );
            } else {
                lines.push("**Not signed in.**");
                lines.push(`**Data scope:** ${config.devUserScope ? `${config.devUserScope} (development fallback)` : "none"}`);
                lines.push(`**Scope map:** ${mapStats.entries} entr${mapStats.entries === 1 ? "y" : "ies"} loaded (applies after sign-in)`);
            }
            const graphReady = !!(deps.userContext && deps.userContext.graphToken);
            const available = deps.toolNames.filter((name) => {
                if (["searchSharePoint", "searchOneDrive", "searchEmail", "getCalendar", "getPlannerTasks", "findPeople"].includes(name)) {
                    return graphReady;
                }
                return true;
            });
            lines.push(`**Tools available to you right now:** ${available.join(", ")}`);
            if (!graphReady) {
                lines.push("_SharePoint, OneDrive, email, calendar, tasks, and people search require sign-in._");
            }
            return { reply: lines.join("\n") };
        }

        case "data":
            if (!args) return { reply: usage("data", "question about products/items") };
            return { turn: { text: args, allowedTools: ["queryCompanyData"] } };

        case "docs":
            if (!args) return { reply: usage("docs", "document search query") };
            return { turn: { text: args, allowedTools: ["searchDocuments"] } };

        case "mail":
            if (!args) return { reply: usage("mail", "email search query") };
            return { turn: { text: args, allowedTools: ["searchEmail", "findPeople"] } };

        case "calendar": {
            const span = args.toLowerCase() === "today" ? "today" : "for the next 7 days";
            return {
                turn: {
                    text: `What is on my calendar ${span}? List the meetings with times.`,
                    allowedTools: ["getCalendar"],
                },
            };
        }

        case "agents": {
            const connectors = deps.connectorStatus();
            if (connectors.length === 0) {
                return { reply: "No external agents or MCP servers are configured." };
            }
            const lines = connectors.map(
                (c) =>
                    `- **${c.name}** (${c.kind}): ${c.state === "open" ? "⛔ unavailable (circuit open)" : "✅ available"}` +
                    (c.consecutiveFailures > 0 ? ` — ${c.consecutiveFailures} recent failure(s)` : "")
            );
            return { reply: `**Configured external connectors:**\n${lines.join("\n")}` };
        }

        case "subscribe": {
            const user = deps.userContext && deps.userContext.user;
            if (!user) {
                return { reply: 'Please type "sign in" first — a digest runs as you, so I need to know who you are.' };
            }
            const m = args.match(/^(\w+)\s+([\s\S]+)$/);
            if (!m) {
                return { reply: "Usage: `/subscribe daily <question>` — e.g. `/subscribe daily how many items do I carry?`" };
            }
            const [, schedule, question] = m;
            return { action: "subscribe", schedule: schedule.toLowerCase(), question: question.trim() };
        }

        case "unsubscribe":
            if (!deps.userContext || !deps.userContext.user) {
                return { reply: "You have no scheduled digests." };
            }
            return { action: "unsubscribe" };

        case "signin":
            return { action: "signin" };

        case "signout":
            return { action: "signout" };

        case "web":
            if (!config.publicWebEnabled) {
                return {
                    reply:
                        "Public web search is disabled (`CONNECTOR_PUBLIC_WEB_ENABLED=false`). " +
                        "Ask an administrator to enable it if you need external web content.",
                };
            }
            if (!args) return { reply: usage("web", "web search query") };
            return { turn: { text: args, allowedTools: ["webSearch"] } };

        default:
            return { reply: `Unknown command \`/${command}\`.\n\n${HELP_TEXT}` };
    }
}

module.exports = { parseCommand, buildCommandOutcome, isSignInMessage, HELP_TEXT };
