const { AzureKeyCredential, SearchIndexClient } = require("@azure/search-documents");
const { deleteIndex } = require("./utils");
const config = require("../config");

const index = config.azureSearchIndexName;
const searchApiKey = process.argv[2] || config.azureSearchAdminKey;
if (!searchApiKey) {
  throw new Error("Missing Azure AI Search admin key (AZURE_SEARCH_ADMIN_KEY or argv)");
}
const searchApiEndpoint = config.azureSearchEndpoint;
const credentials = new AzureKeyCredential(searchApiKey);

const searchIndexClient = new SearchIndexClient(searchApiEndpoint, credentials);
deleteIndex(searchIndexClient, index);
