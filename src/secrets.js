// Startup secret resolution. When KEY_VAULT_URI is set (deployed to Azure),
// missing secret env vars are filled from Key Vault using the app's managed
// identity. Env vars that are already set win, which keeps the plain
// env-var path working for local and playground runs.
//
// IMPORTANT: this module must run BEFORE src/config.js is first required,
// because config captures process.env at require time. src/index.js awaits
// resolveSecrets() and only then requires the app.
const { DefaultAzureCredential } = require("@azure/identity");

const SECRET_TO_ENV = {
    "azure-openai-api-key": "AZURE_OPENAI_API_KEY",
    "azure-search-query-key": "AZURE_SEARCH_QUERY_KEY",
    "azure-sql-username": "AZURE_SQL_USERNAME",
    "azure-sql-password": "AZURE_SQL_PASSWORD",
};

async function resolveSecrets() {
    const vaultUri = process.env.KEY_VAULT_URI;
    if (!vaultUri) {
        return; // local/playground: plain env vars only
    }

    const missing = Object.entries(SECRET_TO_ENV).filter(([, envName]) => !process.env[envName]);
    if (missing.length === 0) {
        return;
    }

    // Lazy require: keeps cold start light when no vault is configured.
    const { SecretClient } = require("@azure/keyvault-secrets");
    const credential = new DefaultAzureCredential({
        managedIdentityClientId: process.env.CLIENT_ID,
    });
    const client = new SecretClient(vaultUri, credential);

    for (const [secretName, envName] of missing) {
        try {
            const secret = await client.getSecret(secretName);
            if (secret.value) {
                process.env[envName] = secret.value;
            }
        } catch (error) {
            // A missing secret is fine when the service uses Entra auth instead
            // of keys; anything else should be visible in the logs.
            if (error.statusCode !== 404) {
                console.error(`Key Vault: failed to read '${secretName}': ${error.message}`);
            }
        }
    }
    console.log(
        JSON.stringify({
            event: "secrets_resolved",
            vault: vaultUri,
            resolved: missing.map(([, envName]) => envName).filter((e) => !!process.env[e]),
        })
    );
}

module.exports = { resolveSecrets };
