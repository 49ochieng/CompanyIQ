// Thin fetch wrapper for Microsoft Graph v1.0 using the user's delegated
// token (from the bot's OAuth connection / Teams SSO exchange). Never called
// with app-only tokens: results must inherit the signed-in user's permissions.
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

async function graphFetch(graphToken, method, path, body) {
    const res = await fetch(`${GRAPH_BASE}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${graphToken}`,
            "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = new Error(`Graph ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
        err.status = res.status;
        throw err;
    }
    return res.json();
}

// Standard result a Graph tool returns when there is no user token yet; the
// orchestrator turns this into the sign-in flow instead of an answer.
const AUTH_REQUIRED = {
    error: "auth_required",
    message: "The user must sign in before this tool can be used.",
};

function logGraphCall(context, tool, resultCount, durationMs) {
    // Audit: tool, user object ID, result count. Never log queries or bodies.
    console.log(
        JSON.stringify({
            event: "graph_call",
            conversationId: context && context.conversationId,
            tool,
            userObjectId: context && context.user ? context.user.aadObjectId : undefined,
            resultCount,
            durationMs,
        })
    );
}

module.exports = { graphFetch, AUTH_REQUIRED, logGraphCall };
