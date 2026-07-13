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
  // Phase 7: actions & automation.
  actionRateLimitPerHour: parseInt(process.env.ACTION_RATE_LIMIT_PER_HOUR || "10", 10),
  // Power Automate: flow whitelist, flag-gated. The trigger URLs are secrets.
  actionsFlowsEnabled: (process.env.ACTIONS_FLOWS_ENABLED || "").toLowerCase() === "true",
  flows: process.env.FLOWS,
  flowConnectionName: process.env.FLOW_CONNECTION_NAME || "flow",
  // Phase 8: keep the serverless database resumed (default on).
  dbKeepAlive: (process.env.DB_KEEPALIVE || "true").toLowerCase() !== "false",
};

module.exports = config;
