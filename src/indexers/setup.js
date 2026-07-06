const { AzureKeyCredential, SearchClient, SearchIndexClient } = require("@azure/search-documents");
const { createIndexIfNotExists, delay, upsertDocuments, getEmbeddingVector } = require("./utils");
const config = require("../config");
const path = require("path");
const fs = require("fs");

// Keys come from the environment (AZURE_SEARCH_ADMIN_KEY / AZURE_OPENAI_API_KEY);
// argv overrides are kept for backwards compatibility with the template docs.
const searchApiKey = process.argv[2] || config.azureSearchAdminKey;
if (!searchApiKey) {
  throw new Error("Missing Azure AI Search admin key (AZURE_SEARCH_ADMIN_KEY or argv)");
}
if (process.argv[3]) {
  process.env.AZURE_OPENAI_API_KEY = process.argv[3];
  config.azureOpenAIKey = process.argv[3];
}
if (!config.azureOpenAIKey) {
  throw new Error("Missing Azure OpenAI key (AZURE_OPENAI_API_KEY or argv)");
}

/**
 *  Main function that creates the index and upserts the documents.
 */
async function main() {
    const index = config.azureSearchIndexName;

    if (
        !config.azureSearchEndpoint ||
        !config.azureOpenAIEndpoint ||
        !config.azureOpenAIEmbeddingDeploymentName
    ) {
        throw new Error(
            "Missing environment variables - please check that AZURE_SEARCH_ENDPOINT, AZURE_OPENAI_ENDPOINT and the embedding deployment name are set."
        );
    }

    const searchApiEndpoint = config.azureSearchEndpoint;
    const credentials = new AzureKeyCredential(searchApiKey);

    // Embed the documents first so the index dimensions always match the
    // embedding model actually configured (1536 for ada-002, 3072 for 3-large).
    const filePath = path.join(__dirname, "./data");
    const files = fs.readdirSync(filePath);
    const data = [];
    for (let i=1;i<=files.length;i++) {
        const content = fs.readFileSync(path.join(filePath, files[i-1]), "utf-8");
        data.push({
            docId: i+"",
            docTitle: files[i-1],
            description: content,
            descriptionVector: await getEmbeddingVector(content),
        });
    }

    const searchIndexClient = new SearchIndexClient(searchApiEndpoint, credentials);
    await createIndexIfNotExists(searchIndexClient, index, data[0].descriptionVector.length);
    // Wait 5 seconds for the index to be created
    await delay(5000);

    const searchClient = new SearchClient(searchApiEndpoint, index, credentials);
    await upsertDocuments(searchClient, data);
    console.log(`Indexed ${data.length} documents into '${index}'.`);
}

main();

module.exports = main;
