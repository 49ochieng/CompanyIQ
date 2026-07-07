const { resolveSecrets } = require("./secrets");

(async () => {
  // Fill missing secret env vars from Key Vault (no-op locally) BEFORE the
  // app/config modules are loaded — config captures process.env at require.
  await resolveSecrets();
  const app = require("./app/app");

  // Discover and register external agents / MCP tools before serving traffic.
  await require("./connectors").initConnectors();

  await app.start(process.env.PORT || process.env.port || 3978);
  console.log(`\nAgent started, app listening to`, process.env.PORT || process.env.port || 3978);
})();
