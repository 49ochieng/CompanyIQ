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

  // Re-arm any digest subscriptions that survived the restart.
  app.startDigests();

  // Warm every configured data source and log what loaded, its identity mode,
  // and its probe result. Non-blocking: the bot serves immediately.
  // (The Fabric source runs as the signed-in user, so at startup — with nobody
  // signed in — it honestly reports "not_signed_in" rather than pre-warming.)
  require("./data/sources")
    .initSources()
    .catch(() => {});
})();
