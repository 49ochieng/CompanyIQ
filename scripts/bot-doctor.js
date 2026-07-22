#!/usr/bin/env node
// One-shot readiness check for the local (tunnel-based) bot debug loop:
//
//   npm run bot:doctor
//
// Checks, in order, everything that has silently broken "the bot isn't
// responding" in the past: az identity, endpoint drift between the Azure
// Bot resource and the currently running tunnel, whether the Teams channel
// is enabled, and whether the local server is actually answering. Each
// line is a clear PASS/FAIL so a broken link is obvious at a glance instead
// of showing up as Teams silently not responding.
"use strict";
const http = require("http");
const https = require("https");
const { az, loadEnvFile } = require("./lib/botEnv");

const env = loadEnvFile("env/.env.local");
let failures = 0;

function pass(label, detail) {
    console.log(`  PASS  ${label}${detail ? " — " + detail : ""}`);
}
function fail(label, detail) {
    failures++;
    console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`);
}

function httpStatus(url) {
    return new Promise((resolve) => {
        const lib = url.startsWith("https:") ? https : http;
        const req = lib.request(url, { method: "POST", timeout: 8000 }, (res) => {
            res.resume();
            resolve(res.statusCode);
        });
        req.on("timeout", () => { req.destroy(); resolve(null); });
        req.on("error", () => resolve(null));
        req.end("{}");
    });
}

async function main() {
    console.log("1) az identity");
    let account;
    try {
        account = assertIdentityNonExiting();
    } catch (err) {
        fail("az identity", err.message);
    }
    if (account) {
        pass("az identity", `${account.user.name} on ${account.name} (${account.id})`);
    }

    console.log("\n2) Azure Bot registered endpoint vs current tunnel");
    if (!env.BOT_ID || !env.AZURE_SUBSCRIPTION_ID || !env.AZURE_RESOURCE_GROUP_NAME) {
        fail("endpoint check", "BOT_ID/AZURE_SUBSCRIPTION_ID/AZURE_RESOURCE_GROUP_NAME missing from env/.env.local");
    } else if (account) {
        try {
            const registered = az(
                "resource show" +
                ` --subscription ${env.AZURE_SUBSCRIPTION_ID}` +
                ` --resource-group ${env.AZURE_RESOURCE_GROUP_NAME}` +
                " --resource-type Microsoft.BotService/botServices" +
                ` --name ${env.BOT_ID}` +
                ' --query "properties.endpoint" -o tsv'
            );
            const expected = `${env.BOT_ENDPOINT}/api/messages`;
            if (registered === expected) {
                pass("endpoint match", registered);
            } else {
                fail("endpoint match", `registered=${registered} but current tunnel=${expected} — run npm run bot:sync`);
            }
        } catch (err) {
            fail("endpoint check", err.message);
        }
    } else {
        fail("endpoint check", "skipped — az identity failed above");
    }

    console.log("\n3) Teams channel enabled");
    if (account && env.BOT_ID) {
        try {
            const raw = az(
                "rest --method get --url " +
                `"https://management.azure.com/subscriptions/${env.AZURE_SUBSCRIPTION_ID}/resourceGroups/${env.AZURE_RESOURCE_GROUP_NAME}/providers/Microsoft.BotService/botServices/${env.BOT_ID}/channels/MsTeamsChannel?api-version=2021-03-01" -o json`
            );
            const parsed = JSON.parse(raw);
            const enabled = parsed && parsed.properties && parsed.properties.properties && parsed.properties.properties.isEnabled;
            if (enabled) {
                pass("MsTeamsChannel", "isEnabled=true");
            } else {
                fail("MsTeamsChannel", `unexpected response: ${raw.slice(0, 200)}`);
            }
        } catch (err) {
            fail("MsTeamsChannel", "not found or not enabled — " + err.message.split("\n")[0]);
        }
    } else {
        fail("MsTeamsChannel", "skipped — az identity failed above");
    }

    console.log("\n4) Local server on :3978");
    const port = process.env.PORT || 3978;
    const status = await httpStatus(`http://localhost:${port}/api/messages`);
    if (status !== null) {
        pass("localhost:" + port, `HTTP ${status} (any response means the process is up and routing /api/messages)`);
    } else {
        fail("localhost:" + port, "no response — is `npm run dev:teamsfx` / the Start application task running?");
    }

    console.log(`\n${failures === 0 ? "All checks passed." : failures + " check(s) failed."}`);
    process.exit(failures === 0 ? 0 : 1);
}

// Like assertIdentity, but returns undefined instead of process.exit(1) so
// this script can keep running the remaining checks and report all of them.
function assertIdentityNonExiting() {
    let account;
    try {
        account = JSON.parse(az("account show -o json"));
    } catch {
        throw new Error("not logged in — run az login");
    }
    const wantTenant = env.TEAMS_APP_TENANT_ID || env.AZURE_TENANT_ID;
    const wantSub = env.AZURE_SUBSCRIPTION_ID;
    if (account.tenantId !== wantTenant || account.id !== wantSub) {
        throw new Error(
            `wrong account — logged in as ${account.user.name} (tenant ${account.tenantId}, sub ${account.id}), ` +
            `expected tenant ${wantTenant}, sub ${wantSub}`
        );
    }
    return account;
}

main();
