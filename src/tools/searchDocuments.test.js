const { test, afterEach } = require("node:test");
const assert = require("node:assert");
const tool = require("./searchDocuments");

// searchDocuments has no raw-fetch boundary of its own (it goes through the
// AzureOpenAI and @azure/search-documents SDKs), so the injectable seam is
// tool._deps — the same call-time-property-lookup pattern db.getPool uses.
const originalGetEmbeddingVector = tool._deps.getEmbeddingVector;
const originalGetSearchClient = tool._deps.getSearchClient;
afterEach(() => {
    tool._deps.getEmbeddingVector = originalGetEmbeddingVector;
    tool._deps.getSearchClient = originalGetSearchClient;
});

function fakeAsyncIterable(items) {
    return {
        [Symbol.asyncIterator]() {
            let i = 0;
            return {
                async next() {
                    if (i < items.length) return { value: items[i++], done: false };
                    return { value: undefined, done: true };
                },
            };
        },
    };
}

test("an empty query short-circuits without calling the embedding or search clients", async () => {
    let embedCalled = false;
    let searchCalled = false;
    tool._deps.getEmbeddingVector = async () => {
        embedCalled = true;
        return [];
    };
    tool._deps.getSearchClient = () => {
        searchCalled = true;
        return { search: async () => fakeAsyncIterable([]) };
    };

    const result = await tool.handler({ query: "" }, {});
    assert.deepStrictEqual(result, { documents: [] });
    assert.strictEqual(embedCalled, false);
    assert.strictEqual(searchCalled, false);
});

test("embeds the query, searches hybrid, and maps results to numbered documents", async () => {
    const embedCalls = [];
    tool._deps.getEmbeddingVector = async (text) => {
        embedCalls.push(text);
        return [0.1, 0.2, 0.3];
    };

    const searchCalls = [];
    tool._deps.getSearchClient = () => ({
        search: async (query, options) => {
            searchCalls.push({ query, options });
            return {
                results: fakeAsyncIterable([
                    { document: { docTitle: "PTO Policy", description: "How PTO accrues." } },
                    { document: { docTitle: "Benefits Overview", description: "Medical, dental, vision." } },
                ]),
            };
        },
    });

    const result = await tool.handler({ query: "how does PTO accrue" }, {});

    assert.deepStrictEqual(embedCalls, ["how does PTO accrue"]);
    assert.strictEqual(searchCalls[0].query, "how does PTO accrue");
    assert.deepStrictEqual(searchCalls[0].options.vectorSearchOptions.queries[0].vector, [0.1, 0.2, 0.3]);

    assert.deepStrictEqual(result.documents, [
        { position: 1, title: "PTO Policy", content: "How PTO accrues." },
        { position: 2, title: "Benefits Overview", content: "Medical, dental, vision." },
    ]);
});

test("runs with no auth gate — unlike the Graph tools, it does not require context.graphToken", async () => {
    tool._deps.getEmbeddingVector = async () => [0.1];
    tool._deps.getSearchClient = () => ({ search: async () => ({ results: fakeAsyncIterable([]) }) });
    const result = await tool.handler({ query: "policy" }, {});
    assert.deepStrictEqual(result, { documents: [] });
});

test("an embedding failure propagates instead of returning an empty result silently", async () => {
    tool._deps.getEmbeddingVector = async () => {
        throw new Error("Failed to generate embeddings for query: policy");
    };
    await assert.rejects(() => tool.handler({ query: "policy" }, {}), /Failed to generate embeddings/);
});
