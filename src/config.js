const config = {
  MicrosoftAppId: process.env.CLIENT_ID,
  MicrosoftAppType: process.env.BOT_TYPE,
  MicrosoftAppTenantId: process.env.TENANT_ID,
  MicrosoftAppPassword: process.env.CLIENT_SECRET,
  azureOpenAIKey: process.env.AZURE_OPENAI_API_KEY,
  azureOpenAIEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
  azureOpenAIApiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-10-21",
  // New canonical names first, template-era names as fallback.
  azureOpenAIDeploymentName:
    process.env.AZURE_OPENAI_CHAT_DEPLOYMENT || process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
  azureOpenAIEmbeddingDeploymentName:
    process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT_NAME,
  // Runtime search uses the query key (least privilege); the admin key is for the indexer scripts.
  azureSearchKey: process.env.AZURE_SEARCH_QUERY_KEY || process.env.AZURE_SEARCH_KEY,
  azureSearchAdminKey: process.env.AZURE_SEARCH_ADMIN_KEY,
  azureSearchEndpoint: process.env.AZURE_SEARCH_ENDPOINT,
  azureSearchIndexName: process.env.AZURE_SEARCH_INDEX_NAME || "my-documents",
  // SQL: AZURE_SQL_* names first, then the generic SQL_* names, then a raw
  // connection string. See src/data/db.js.
  sqlServer: process.env.AZURE_SQL_SERVER || process.env.SQL_SERVER,
  sqlDatabase: process.env.AZURE_SQL_DATABASE || process.env.SQL_DATABASE,
  sqlUser: process.env.AZURE_SQL_USERNAME || process.env.SQL_USER,
  sqlPassword: process.env.AZURE_SQL_PASSWORD || process.env.SQL_PASSWORD,
  sqlConnectionString: process.env.SQL_CONNECTION_STRING,
  // Elevated credential used ONLY by the db:seed / db:introspect scripts
  // (they need DDL). The running bot never uses these — it connects with the
  // least-privilege login above, which holds SELECT on sbs_test and nothing else.
  sqlAdminUser: process.env.AZURE_SQL_ADMIN_USERNAME,
  sqlAdminPassword: process.env.AZURE_SQL_ADMIN_PASSWORD,
  // TEMPORARY (until SSO lands in Phase 3): row-level scope value applied to
  // every data query in place of the authenticated user's mapped identity.
  devUserScope: process.env.DEV_USER_SCOPE,
  // Phase 3: SSO + Graph.
  oauthConnectionName: process.env.OAUTH_CONNECTION_NAME || "graph",
  userScopeMap: process.env.USER_SCOPE_MAP,
  sharePointSites: process.env.SHAREPOINT_SITES,
  // Phase 4: public web tool (never registered when the flag is off).
  publicWebEnabled: (process.env.CONNECTOR_PUBLIC_WEB_ENABLED || "").toLowerCase() === "true",
  // Phase 12 kill switch: A2 parallel tool-call fan-out subclasses SDK internals
  // and has never run against a real connector. Default ON (current behavior);
  // set to "false" to fall back to the stock SDK's sequential tool-call model
  // without a deploy.
  parallelToolCallsEnabled: (process.env.PARALLEL_TOOL_CALLS_ENABLED || "true").toLowerCase() !== "false",
  orgWebsiteAllowlist: process.env.ORG_WEBSITE_ALLOWLIST,
  // Phase 5: external agent / MCP connectors (JSON arrays; see src/connectors).
  mcpServers: process.env.MCP_SERVERS,
  foundryAgents: process.env.FOUNDRY_AGENTS,
  httpAgents: process.env.HTTP_AGENTS,
  // Phase 6: identity-propagating delegation. One OAuth connection per
  // downstream audience; user tokens resolved per call.
  fabricDataAgents: process.env.FABRIC_DATA_AGENTS,
  fabricConnectionName: process.env.FABRIC_CONNECTION_NAME || "fabric",
  foundryConnectionName: process.env.FOUNDRY_CONNECTION_NAME || "foundry",
  // Phase 12: Copilot Studio agents via the M365 Agents SDK Copilot Studio
  // client. Always user-identity — there is no app-only mode (Direct Line is
  // the app-only alternative and was deliberately rejected: it doesn't
  // propagate the caller's identity).
  copilotStudioAgents: process.env.COPILOT_STUDIO_AGENTS,
  copilotStudioConnectionName: process.env.COPILOT_STUDIO_CONNECTION_NAME || "copilotstudio",
  // Phase 7: actions & automation.
  actionRateLimitPerHour: parseInt(process.env.ACTION_RATE_LIMIT_PER_HOUR || "10", 10),
  // Power Automate: flow whitelist, flag-gated. The trigger URLs are secrets.
  actionsFlowsEnabled: (process.env.ACTIONS_FLOWS_ENABLED || "").toLowerCase() === "true",
  flows: process.env.FLOWS,
  flowConnectionName: process.env.FLOW_CONNECTION_NAME || "flow",
  // Phase 8: keep the serverless database resumed (default on).
  dbKeepAlive: (process.env.DB_KEEPALIVE || "true").toLowerCase() !== "false",
  // Phase 10: Fabric lakehouse source (SQL analytics endpoint over TDS).
  // Identity is the SIGNED-IN USER (delegated token, audience
  // https://database.windows.net/) — no service principal at runtime.
  fabricEndpoint: process.env.FABRIC_SQL_ENDPOINT,
  fabricDatabase: process.env.FABRIC_DATABASE,
  fabricSqlConnectionName: process.env.FABRIC_SQL_CONNECTION_NAME || "fabric_sql",
  // LOCAL ONLY: use the developer's own az-login identity for Fabric when there
  // is no Teams SSO (playground/harness). Hard-disabled when running on Azure.
  fabricLocalDevIdentity: (process.env.FABRIC_LOCAL_DEV_IDENTITY || "").toLowerCase() === "true",

  // Part C: public web intelligence.
  // WEB_GROUNDING: JSON {name, description, projectEndpoint, connectionId, model,
  //   freshness?, count?, market?, userScoped}. The lean Grounding-with-Bing
  //   path — inline responses call, no persistent agent. userScoped MUST be set.
  webGrounding: process.env.WEB_GROUNDING,
  // WATCHLIST: JSON [{name, domains[], description, topics[], cadence}].
  watchlist: process.env.WATCHLIST,
  // Dedicated AI Search indexes for crawled web content and dated snapshots
  // (kept separate from the document RAG index).
  webIndexName: process.env.AZURE_SEARCH_WEB_INDEX_NAME || "companyiq-web",
  webSnapshotIndexName: process.env.AZURE_SEARCH_WEB_SNAPSHOT_INDEX_NAME || "companyiq-web-snapshots",
  // Crawler politeness / bounds.
  crawlMaxPages: parseInt(process.env.CRAWL_MAX_PAGES || "40", 10),
  crawlMaxDepth: parseInt(process.env.CRAWL_MAX_DEPTH || "2", 10),
  crawlDelayMs: parseInt(process.env.CRAWL_DELAY_MS || "1000", 10),
  crawlCacheTtlMs: parseInt(process.env.CRAWL_CACHE_TTL_MS || String(6 * 60 * 60 * 1000), 10),
};

module.exports = config;
