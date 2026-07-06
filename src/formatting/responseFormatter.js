const { MessageActivity } = require("@microsoft/teams.api");

// Columns rendered in the data table, in UC-01 Appendix A-02 order.
const TABLE_COLUMNS = ["Item", "Brand", "UPC", "Supplier", "COO", "Mtl<>USA", "Ingredients Statement"];

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
    const activity = new MessageActivity(content).addAiGenerated();

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
 * @param {{intent: string, rowCount: number, rows: Array<Object>}} data
 */
function buildTableCard(data) {
    const headerRow = {
        type: "TableRow",
        cells: TABLE_COLUMNS.map((column) => ({
            type: "TableCell",
            items: [{ type: "TextBlock", text: column, weight: "Bolder", wrap: true }],
        })),
    };

    const dataRows = data.rows.map((row) => ({
        type: "TableRow",
        cells: TABLE_COLUMNS.map((column) => ({
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
                columns: TABLE_COLUMNS.map(() => ({ width: 1 })),
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
