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

  // Resume the serverless database and keep it warm, so the first (and every)
  // data question answers instantly. Non-blocking: the bot serves immediately.
  const db = require("./data/db");
  db.warmUp("startup")
    .then((ok) => {
      if (ok) {
        db.startKeepAlive();
      }
    })
    .catch(() => {});
})();
