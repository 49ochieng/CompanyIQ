// Every external connector (Foundry / HTTP / MCP / Fabric) must be EXPLICITLY
// classified as identity-propagating or not. `userScoped: true` asserts the
// connector's results are limited to the signed-in user's own access (the
// caller's identity flows all the way through to the underlying data, so a
// 401/403 is the permission model working). `userScoped: false` declares the
// opposite — results MAY include data beyond the caller's own permissions
// (e.g. a knowledge base reached with a shared key), which the formatter then
// labels for the user.
//
// There is NO default. An agent registered without an explicit boolean fails
// at startup — silently guessing here is exactly the mistake that surfaces
// other people's documents. Registering a `userScoped: false` connector is a
// deliberate exception to CompanyIQ's core "no path returns data the user
// can't see" guarantee and must be a conscious, documented choice.
function assertUserScoped(entry, kind) {
    if (typeof entry.userScoped !== "boolean") {
        throw new Error(
            `${kind} '${entry.name}' must declare "userScoped": true or false — whether its results ` +
            `are limited to the signed-in user's own access (identity-propagating). There is no default; ` +
            `refusing to start until it is set explicitly.`
        );
    }
    return entry.userScoped;
}

module.exports = { assertUserScoped };
