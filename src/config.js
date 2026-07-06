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
};

module.exports = config;
