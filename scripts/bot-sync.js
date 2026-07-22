#!/usr/bin/env node
// Reads the current BOT_ENDPOINT from env/.env.local and updates the Azure
// Bot Service messaging endpoint to match. Run this after any tunnel restart
// that creates a new tunnel URL:
//
//   npm run bot:sync
//
// Requires an active `az login` session in the SAME tenant/subscription the
// bot resource lives in — checked below before anything is touched, because
// a silent identity mismatch here previously looked like success while the
// endpoint drifted for days.
"use strict";
const { az, loadEnvFile, requireKeys, assertIdentity } = require("./lib/botEnv");

const env = loadEnvFile("env/.env.local");
requireKeys(
    env,
    ["BOT_ENDPOINT", "BOT_ID", "AZURE_SUBSCRIPTION_ID", "AZURE_RESOURCE_GROUP_NAME", "TEAMS_APP_TENANT_ID"],
    "env/.env.local"
);

const account = assertIdentity(env);
console.log(`az identity OK — ${account.user.name} on ${account.name} (${account.id})`);

const endpoint = `${env.BOT_ENDPOINT}/api/messages`;
console.log(`Syncing Azure Bot endpoint → ${endpoint}`);
try {
    const result = az(
        "resource update" +
        ` --subscription ${env.AZURE_SUBSCRIPTION_ID}` +
        ` --resource-group ${env.AZURE_RESOURCE_GROUP_NAME}` +
        " --resource-type Microsoft.BotService/botServices" +
        ` --name ${env.BOT_ID}` +
        ` --set properties.endpoint=${endpoint}` +
        ' --query "properties.endpoint" -o tsv'
    );
    console.log(`Done. Registered endpoint is now: ${result}`);
} catch (err) {
    console.error("az resource update failed:", err.message);
    process.exit(1);
}
