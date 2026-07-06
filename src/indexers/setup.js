const { AzureKeyCredential, SearchClient, SearchIndexClient } = require("@azure/search-documents");
const { createIndexIfNotExists, delay, upsertDocuments, getEmbeddingVector } = require("./utils");
const path = require("path");
const fs = require("fs");

const searchApiKey = process.argv[2];
if (!searchApiKey) {
  throw new Error("Missing input Azure AI Search Key");
}
const azureOpenAIKey = process.argv[3];
if (!azureOpenAIKey) {
  throw new Error("Missing input Azure OpenAI Key");
}
process.env.SECRET_AZURE_OPENAI_API_KEY = azureOpenAIKey;

/**
 *  Main function that creates the index and upserts the documents.
 */
async function main() {
    const index = "my-documents";

    if (
        !process.env.AZURE_SEARCH_ENDPOINT ||
        !process.env.AZURE_OPENAI_ENDPOINT ||
        !process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT_NAME
    ) {
        throw new Error(
            "Missing environment variables - please check that AZURE_SEARCH_ENDPOINT, AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_EMBEDDING_DEPLOYMENT_NAME are set."
        );
    }

    const searchApiEndpoint = process.env.AZURE_SEARCH_ENDPOINT;
    const credentials = new AzureKeyCredential(searchApiKey);

    const searchIndexClient = new SearchIndexClient(searchApiEndpoint, credentials);
    createIndexIfNotExists(searchIndexClient, index);
    // Wait 5 seconds for the index to be created
    await delay(5000);

    const searchClient = new SearchClient(searchApiEndpoint, index, credentials);

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
    await upsertDocuments(searchClient, data);
}

main();

module.exports = main;
