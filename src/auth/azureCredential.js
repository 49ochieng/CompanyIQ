// Shared Entra credential for keyless (managed identity / developer) auth to
// Azure OpenAI and Azure AI Search. Used only when the corresponding key is
// absent, so key-based local setups keep working unchanged.
const { DefaultAzureCredential, getBearerTokenProvider } = require("@azure/identity");

let credential;

function getAzureCredential() {
    if (!credential) {
        credential = new DefaultAzureCredential({
            managedIdentityClientId: process.env.CLIENT_ID,
        });
    }
    return credential;
}

// Token provider for Azure OpenAI (Cognitive Services audience).
function getOpenAITokenProvider() {
    return getBearerTokenProvider(getAzureCredential(), "https://cognitiveservices.azure.com/.default");
}

module.exports = { getAzureCredential, getOpenAITokenProvider };
