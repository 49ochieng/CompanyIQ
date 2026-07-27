// Pure renderer for the /trace command — turns the orchestrator's per-turn
// trace object into the Markdown the user sees. Kept side-effect free so it is
// unit-testable without booting the app.

function truncateText(s, max) {
    const t = String(s || "");
    return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** @param {object|undefined} trace The orchestrator's turn trace. */
function renderTrace(trace) {
    if (!trace) {
        return "No trace yet — ask me something first, then run `/trace` to see exactly what I did.";
    }
    const lines = [
        "**Trace of the last turn**",
        `_"${truncateText(trace.input, 100)}"_ · ${trace.latencyMs} ms total`,
        "",
    ];
    if (!trace.calls || trace.calls.length === 0) {
        lines.push(
            trace.af1
                ? "_No tools were called — I could not interpret that request (fallback)._"
                : "_No tools were called — I answered directly (e.g. your identity, or a greeting)._"
        );
    } else {
        for (const c of trace.calls) {
            const status = c.ok ? "✅" : "⛔";
            lines.push(`${c.step}. ${status} **${c.tool}** — ${c.summary} · ${c.durationMs} ms`);
        }
        if (trace.calls.length > 1) {
            const wall = trace.calls.reduce((a, c) => a + (c.durationMs || 0), 0);
            lines.push("", `_${trace.calls.length} tool calls, ${wall} ms of tool time in ${trace.latencyMs} ms total._`);
        }
    }
    if (trace.authRequired) {
        lines.push("", "_This turn needed sign-in for one of the tools above._");
    }
    return lines.join("\n");
}

module.exports = { renderTrace, truncateText };
