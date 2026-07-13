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
        text += `\n\n---\n**External result — ${result.source} (not company data):**\n${truncate(result.raw, 1500)}`;
        if (Array.isArray(result.citations) && result.citations.length > 0) {
            const cites = result.citations
                .map((c) => (typeof c === "string" ? `- ${c}` : `- [${c.title || c.url}](${c.url})`))
                .join("\n");
            text += `\nSources:\n${cites}`;
        }
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

/**
 * Adaptive Card (schema 1.5) with a Table element: header row + one row per result.
 * Columns are whatever the compiled query returned.
 * @param {{columns?: string[], rowCount: number, rows: Array<Object>}} data
 */
function buildTableCard(data) {
    const columns = resolveColumns(data);

    const headerRow = {
        type: "TableRow",
        cells: columns.map((column) => ({
            type: "TableCell",
            items: [{ type: "TextBlock", text: column, weight: "Bolder", wrap: true }],
        })),
    };

    const dataRows = data.rows.map((row) => ({
        type: "TableRow",
        cells: columns.map((column) => ({
            type: "TableCell",
            items: [{ type: "TextBlock", text: String(row[column] ?? ""), wrap: true }],
        })),
    }));

    return {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard",
        version: "1.5",
        body: [
            {
                type: "TextBlock",
                text: `Company data results (${data.rowCount} row${data.rowCount === 1 ? "" : "s"})`,
                weight: "Bolder",
                size: "Medium",
                wrap: true,
            },
            {
                type: "Table",
                firstRowAsHeaders: true,
                columns: columns.map(() => ({ width: 1 })),
                rows: [headerRow, ...dataRows],
            },
        ],
    };
}

function truncate(text, max) {
    if (typeof text !== "string" || text.length <= max) {
        return text;
    }
    return `${text.slice(0, max - 1)}…`;
}

module.exports = { formatResponse };
