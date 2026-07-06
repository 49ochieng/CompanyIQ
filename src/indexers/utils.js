/**
 * Defines the utility methods.
 */
const { KnownAnalyzerNames } = require("@azure/search-documents");
const { AzureOpenAI } = require("openai");
const config = require("../config");

/**
 * A wrapper for setTimeout that resolves a promise after timeInMs milliseconds.
 */
function delay(timeInMs) {
    return new Promise((resolve) => setTimeout(resolve, timeInMs));
}

/**
 * Deletes the index with the given name
 */
function deleteIndex(client, name) {
    return client.deleteIndex(name);
}

/**
 * Adds or updates the given documents in the index
 */
async function upsertDocuments(client, documents) {
    return await client.mergeOrUploadDocuments(documents);
}

/**
 * Creates the index with the given name.
 * @param {number} vectorDimensions Dimensions of the embedding model in use
 * (e.g. 1536 for text-embedding-ada-002, 3072 for text-embedding-3-large).
 */
async function createIndexIfNotExists(client, name, vectorDimensions) {
    const MyDocumentIndex = {
        name,
        fields: [
            {
                type: "Edm.String",
                name: "docId",
                key: true,
                filterable: true,
                sortable: true
            },
            {
                type: "Edm.String",
                name: "docTitle",
                searchable: true,
                filterable: true,
                sortable: true
            },
            {
                type: "Edm.String",
                name: "description",
                searchable: true,
                analyzerName: KnownAnalyzerNames.EnLucene
            },
            {
                type: "Collection(Edm.Single)",
                name: "descriptionVector",
                searchable: true,
                vectorSearchDimensions: vectorDimensions,
                vectorSearchProfileName: "my-vector-config"
            },
        ],
        corsOptions: {
            // for browser tests
            allowedOrigins: ["*"]
        },
        vectorSearch: {
            algorithms: [{ name: "vector-search-algorithm", kind: "hnsw" }],
            profiles: [
                {
                    name: "my-vector-config",
                    algorithmConfigurationName: "vector-search-algorithm"
                }
            ]
        }
    };

    await client.createOrUpdateIndex(MyDocumentIndex);
}

/**
 * Generate the embedding vector
 */
async function getEmbeddingVector(text) {
    const client = new AzureOpenAI({
        apiKey: config.azureOpenAIKey,
        endpoint: config.azureOpenAIEndpoint,
        apiVersion: config.azureOpenAIApiVersion,
    });
    const result = await client.embeddings.create({
        input: text,
        model: config.azureOpenAIEmbeddingDeploymentName,
    });


    if (!result.data || result.data.length === 0) {
        throw new Error(`Failed to generate embeddings for description: ${text}`);
    }

    return result.data[0].embedding;
}

module.exports = {
    delay,
    deleteIndex,
    upsertDocuments,
    createIndexIfNotExists,
    getEmbeddingVector
};
