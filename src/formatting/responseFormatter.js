const { MessageActivity } = require("@microsoft/teams.api");

// Preferred column order when present (UC-01 Appendix A-02); any other columns
// the query returned follow in the order the compiler produced them.
const PREFERRED_ORDER = ["Item", "Brand", "UPC", "Supplier", "COO", "Mtl<>USA", "Ingredients Statement"];

/** Columns to render: whatever the query actually returned, UC-01 order first. */
function resolveColumns(data) {
    const present = data.columns && data.columns.length > 0
        ? data.columns
        : Object.keys(data.rows[0] || {});
    const preferred = PREFERRED_ORDER.filter((c) => present.includes(c));
    const rest = present.filter((c) => !preferred.includes(c));
    return [...preferred, ...rest];
}

/**
 * Build the outgoing MessageActivity from the orchestrator's turn result.
 * Tabular queryCompanyData results render as an Adaptive Card table;
 * searchDocuments results keep the citation pattern ([n] markers in the
 * model's text map to citation entries in document order).
 *
 * @param {{content: string, toolCalls: Array, toolResults: Object}} turnResult
 * @returns {MessageActivity}
 */
function formatResponse(turnResult) {
    const { content, toolResults } = turnResult;
    const toolCalls = turnResult.toolCalls || [];

    // UC-01 Appendix A-02: external web content renders in a clearly
    // separated, labeled section after internal results, with source URLs.
    let text = content;
    const web = toolResults.webSearch;
    if (web && Array.isArray(web.results) && web.results.length > 0) {
        const lines = web.results.map(
            (r) => `- [${r.title || r.url}](${r.url})${r.snippet ? ` — ${r.snippet}` : ""}`
        );
        text += `\n\n---\n**External information (public web — not company data):**\n${lines.join("\n")}`;
    }

    // External agent / MCP results: same pattern, labeled with the source name.
    for (const [toolName, result] of Object.entries(toolResults)) {
        if (toolName === "webSearch" || !result || !result.external || !result.source) {
            continue;
        }
        if (!result.raw) {
            continue;
        }
        // Disclosure (NOT a control): a connector explicitly classified
        // userScoped:false may return data beyond the caller's own access
        // (e.g. a knowledge base reached with a shared key). Say so, every time.
        const scopeWarning =
            result.userScoped === false
                ? "\n> ⚠️ **This may include information beyond your own access** — it was not filtered by your permissions. Verify before relying on or sharing it."
                : "";
        text += `\n\n---\n**External result — ${result.source} (not company data):**${scopeWarning}\n${truncate(result.raw, 1500)}`;
        if (Array.isArray(result.citations) && result.citations.length > 0) {
            const cites = result.citations
                .map((c) => (typeof c === "string" ? `- ${c}` : `- [${c.title || c.url}](${c.url})`))
                .join("\n");
            text += `\nSources:\n${cites}`;
        }
    }

    // Deterministic provenance footer: the exact set of sources that actually
    // produced this answer, built from the recorded tool calls — not from the
    // model, so it cannot be omitted, reworded, or invented. Complements the
    // model's inline "According to …" attribution with a guaranteed source list.
    const footer = attributionFooter(toolCalls);
    if (footer) {
        text += `\n\n${footer}`;
    }

    const activity = new MessageActivity(text).addAiGenerated();

    const data = toolResults.queryCompanyData;
    if (data && Array.isArray(data.rows) && data.rows.length > 0) {
        activity.addCard("adaptive", buildTableCard(data));
    }

    const docs = toolResults.searchDocuments;
    if (docs && Array.isArray(docs.documents)) {
        for (const doc of docs.documents) {
            activity.addCitation(doc.position, {
                name: doc.title,
                abstract: truncate(doc.content, 480),
            });
        }
    }

    return activity;
}

// Presentation only — how wide each known column should be relative to the
// others, and how much text a cell may show before it is visibly clipped.
// Anything not listed gets a sensible default.
const COLUMN_STYLE = {
    Item: { width: 3, maxChars: 60 },
    "Ingredients Statement": { width: 4, maxChars: 90 },
    Supplier: { width: 2, maxChars: 40 },
    Brand: { width: 1.5, maxChars: 30 },
    COO: { width: 1.5, maxChars: 30 },
    UPC: { width: 1.2, maxChars: 16 },
    "Mtl<>USA": { width: 0.8, maxChars: 6 },
    Count: { width: 1, maxChars: 12 },
};
const DEFAULT_STYLE = { width: 1.5, maxChars: 40 };

function styleFor(column) {
    return COLUMN_STYLE[column] || DEFAULT_STYLE;
}

/**
 * Clip long cell text at a word boundary with a visible ellipsis, so a 10-row
 * table stays readable instead of one ingredients statement dominating it.
 */
function clipCell(text, maxChars) {
    const s = String(text ?? "");
    if (s.length <= maxChars) {
        return s;
    }
    const cut = s.slice(0, maxChars);
    const lastSpace = cut.lastIndexOf(" ");
    const body = lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut;
    return `${body.replace(/[,;.\s]+$/, "")}…`;
}

/**
 * Adaptive Card (schema 1.5) with a Table element: header row + one row per result.
 * Columns are whatever the compiled query returned.
 * @param {{columns?: string[], rowCount: number, rows: Array<Object>}} data
 */
function buildTableCard(data) {
    const columns = resolveColumns(data);
    const styles = columns.map(styleFor);
    // True when at least one cell was clipped, so we can say so honestly.
    let clipped = false;

    const headerRow = {
        type: "TableRow",
        style: "emphasis",
        cells: columns.map((column) => ({
            type: "TableCell",
            items: [
                {
                    type: "TextBlock",
                    text: column,
                    weight: "Bolder",
                    size: "Small",
                    wrap: true,
                },
            ],
        })),
    };

    const dataRows = data.rows.map((row) => ({
        type: "TableRow",
        cells: columns.map((column, i) => {
            const raw = String(row[column] ?? "");
            const shown = clipCell(raw, styles[i].maxChars);
            if (shown !== raw) {
                clipped = true;
            }
            return {
                type: "TableCell",
                items: [
                    {
                        type: "TextBlock",
                        text: shown,
                        size: "Small",
                        wrap: true,
                    },
                ],
            };
        }),
    }));

    // The source line is produced HERE, by the formatter — not by the model —
    // so it cannot be omitted or reworded, whatever the model writes.
    const sourceLine = data.sourceLabel
        ? `${data.sourceLabel} — ${data.rowCount} row${data.rowCount === 1 ? "" : "s"}`
        : `Company data — ${data.rowCount} row${data.rowCount === 1 ? "" : "s"}`;

    const body = [
        {
            type: "TextBlock",
            text: sourceLine,
            weight: "Bolder",
            size: "Medium",
            wrap: true,
        },
        {
            type: "Table",
            firstRowAsHeaders: true,
            gridStyle: "default",
            showGridLines: true,
            columns: styles.map((s) => ({ width: s.width })),
            rows: [headerRow, ...dataRows],
        },
    ];

    // Identity disclosure, emitted by the formatter so the model cannot drop it.
    // (Today both sources are user-scoped. If a source is ever switched to an
    // app identity, this line is what tells the user their results are org-wide.)
    if (data.sourceIdentity === "app_shared") {
        body.push({
            type: "TextBlock",
            text: "Org-wide data — visible to all CompanyIQ users, not filtered by your permissions.",
            size: "Small",
            isSubtle: true,
            wrap: true,
            spacing: "Small",
        });
    }

    // Never clip silently — say it, and say where the full text lives.
    if (clipped) {
        body.push({
            type: "TextBlock",
            text: "_Some values are shortened to fit. Ask about a specific item to see its full details._",
            size: "Small",
            isSubtle: true,
            wrap: true,
            spacing: "Small",
        });
    }

    return {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.5",
        body,
    };
}

// Human-readable source label for a tool name (including dynamic connector
// tools, whose names encode the connector and instance).
function sourceLabelFor(toolName) {
    const STATIC = {
        queryCompanyData: "Company database",
        searchDocuments: "Document library",
        searchSharePoint: "SharePoint",
        searchOneDrive: "OneDrive",
        searchEmail: "Email",
        getCalendar: "Calendar",
        getPlannerTasks: "Planner",
        findPeople: "Directory",
        webSearch: "Public web",
    };
    if (STATIC[toolName]) return STATIC[toolName];
    let m;
    if ((m = toolName.match(/^ask_fabric_(.+)$/))) return `Fabric data agent: ${m[1]}`;
    if ((m = toolName.match(/^ask_agent_(.+)$/))) return `Agent: ${m[1]}`;
    if ((m = toolName.match(/^mcp_([^_]+)_/))) return `External service: ${m[1]}`;
    return toolName;
}

/**
 * Build the "_Sources this turn: …_" line from the calls that actually
 * succeeded, in first-seen order, de-duplicated. Returns "" when no tool
 * produced data (pure conversational replies get no footer).
 */
function attributionFooter(toolCalls) {
    const seen = new Set();
    const labels = [];
    for (const call of toolCalls) {
        if (!call || !call.ok) continue;
        const label = sourceLabelFor(call.tool);
        if (seen.has(label)) continue;
        seen.add(label);
        labels.push(label);
    }
    if (labels.length === 0) return "";
    return `_Sources this turn: ${labels.join(", ")}._`;
}

function truncate(text, max) {
    if (typeof text !== "string" || text.length <= max) {
        return text;
    }
    return `${text.slice(0, max - 1)}…`;
}

module.exports = { formatResponse, attributionFooter, sourceLabelFor };
