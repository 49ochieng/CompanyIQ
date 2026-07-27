const { AzureKeyCredential, SearchClient } = require("@azure/search-documents");
const { AzureOpenAI } = require("openai");
const config = require("../config");
const { getAzureCredential, getOpenAITokenProvider } = require("../auth/azureCredential");

/**
 * Generate the embedding vector for the search query.
 * @param {string} text The text to embed.
 * @returns {Promise<number[]>} The embedding vector.
 */
async function getEmbeddingVector(text) {
    // Entra (managed identity) auth when no key is configured.
    const auth = config.azureOpenAIKey
        ? { apiKey: config.azureOpenAIKey }
        : { azureADTokenProvider: getOpenAITokenProvider() };
    const client = new AzureOpenAI({
        ...auth,
        endpoint: config.azureOpenAIEndpoint,
        apiVersion: config.azureOpenAIApiVersion,
    });
    const result = await client.embeddings.create({
        input: text,
        model: config.azureOpenAIEmbeddingDeploymentName,
    });

    if (!result.data || result.data.length === 0) {
        throw new Error(`Failed to generate embeddings for query: ${text}`);
    }

    return result.data[0].embedding;
}

let searchClient;
function getSearchClient() {
    if (!searchClient) {
        // Entra (managed identity) auth when no key is configured.
        const credential = config.azureSearchKey
            ? new AzureKeyCredential(config.azureSearchKey)
            : getAzureCredential();
        searchClient = new SearchClient(
            config.azureSearchEndpoint,
            config.azureSearchIndexName,
            credential,
            {}
        );
    }
    return searchClient;
}

module.exports = {
    name: "searchDocuments",
    description:
        "Search the company's internal document library (policies, benefit plans, programs, company overviews). " +
        "Use for prose/policy questions answered by internal documents. NOT for product/item/supplier facts " +
        "(use queryCompanyData) and NOT for the user's own files or email (use searchOneDrive / searchEmail).",
    parameters: {
        type: "object",
        properties: {
            query: {
                type: "string",
                description: "The search query, phrased with the key terms of the user's question.",
            },
        },
        required: ["query"],
    },
    /**
     * Hybrid (keyword + vector) search over the document index.
     * @param {{query: string}} args Arguments filled by the model.
     * @param {Object} context Per-turn context (conversation ID, user scope).
     * @returns {Promise<{documents: Array<{position: number, title: string, content: string}>}>}
     */
    async handler(args, context) {
        const query = args.query;
        if (!query) {
            return { documents: [] };
        }

        const queryVector = await getEmbeddingVector(query);
        const searchResults = await getSearchClient().search(query, {
            searchFields: ["docTitle", "description"],
            select: ["docId", "docTitle", "description"],
            vectorSearchOptions: {
                queries: [
                    {
                        kind: "vector",
                        fields: ["descriptionVector"],
                        kNearestNeighborsCount: 2,
                        vector: queryVector,
                    },
                ],
            },
        });

        const documents = [];
        for await (const result of searchResults.results) {
            documents.push({
                position: documents.length + 1,
                title: result.document.docTitle,
                content: result.document.description,
            });
        }

        return { documents };
    },
};
