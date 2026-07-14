# CompanyIQ — Demo Runbook

The demo arc: **data → insight → action**. A scoped SQL question, a follow-up that proves conversational context, open-ended analysis over the same data, knowledge retrieval across SharePoint and email, and finally an action the user approves before it happens — plus two security moments (an honest refusal, and the AF-1 safety beat).

**The data behind the demo — two sources, two security models:**
- **Azure SQL (company products)**: 40 items, 12 suppliers, 12 countries, split across two retailer assortments. You are `RETAILER_100` and see **26 items / 10 suppliers**; `RETAILER_200` has a different, overlapping set of 20. Scoping is a **row-level predicate our compiler injects into every statement**.
- **Microsoft Fabric (healthcare lakehouse)**: 250 patients, 45 cardiologists, 240 appointments across 7 tables. Scoping is **your own Fabric permissions** — the connection carries your token, so Fabric filters inside its engine.

---

## 1. Pre-flight (start 30 minutes before)

Run these in order. Every step has a visible pass signal — don't proceed past a failure.

> ### ⚠️ The one that will bite you: **prime every OAuth connection**
> The bot holds **four** connections — `graph`, `fabric_sql`, `foundry`, `flow` — and each one prompts for consent **the first time it is used, per user**. A connection you have never exercised **will** throw a sign-in card on stage.
> **Step 5 below deliberately triggers each one once.** Do not skip it. `fabric_sql` is brand new and has never been signed into, so it is guaranteed to prompt if you don't prime it.

| # | Do this | Pass signal |
| - | - | - |
| 1 | **Restart the dev task** in VS Code (`Start Agent Locally`, or `npm run dev:teamsfx`). Kill any stale process holding port 3978 first: `netstat -ano \| findstr :3978` → `taskkill /PID <pid> /F` | Console shows `startup_config` with `"botType":"SingleTenant"`, `clientSecretPresent: true`, then `listening on port 3978 🚀` |
| 2 | **Both data sources warm up automatically.** Watch the console. | `{"event":"sources_init", ...}` listing `company_sql` and `healthcare_fabric`. **A cold Azure SQL takes ~45s; a cold Fabric endpoint ~10–20s.** After that, the SQL keep-alive pings every 4 min. |
| 3 | **Verify the tunnel matches the bot.** The dev tunnel URL changes on some restarts. <br>`az resource show -g <RG> --resource-type Microsoft.BotService/botServices -n <BOT_ID> --query properties.endpoint -o tsv` <br>compare with `BOT_ENDPOINT` in `env/.env.local` | The two match (`https://<tunnel>/api/messages`). If not → see Troubleshooting #1. |
| 4 | In Teams, send **`/whoami`** | `Signed in as: <you>` · `Data scope: RETAILER_100` · `Scope map: 1 entry loaded (you matched)`. This primes the **`graph`** connection. If it says *none matched* → see Troubleshooting #2. |
| 5 | **Prime the remaining connections — one prompt each, once.** Send these four, in order, and **complete any sign-in card that appears**: <br>a) `find the latest onboarding document in SharePoint` → primes **`graph`** for Graph data <br>b) `How many patients are in the healthcare lakehouse?` → primes **`fabric_sql`** ⬅ *the new one; expect a card the first time* <br>c) `Ask the test agent to say hello` → primes **`foundry`** *(skip if no Foundry agent is configured)* <br>d) `/web armely` → primes **`flow`**-adjacent paths *(skip: flows are disabled — `ACTIONS_FLOWS_ENABLED=false`)* | Each returns a real answer with **no** sign-in card **on the second attempt**. Re-send each one to confirm it is now silent. |
| 6 | **One warm soy query** (throwaway): `List all my products that contain soy protein sourced from China` | 3-row table card, well under a second. |
| 7 | **`/sources`** | Both sources listed, **both ✅ reachable**. If Fabric shows ⛔ *"Sign in to use the healthcare lakehouse"*, step 5b did not complete — redo it. |
| 8 | **`/agents`** | Lists configured connectors. **An empty list is fine** — just don't demo that beat. |
| 9 | **Rehearse the email send end-to-end** (see §2 Beat 10). Send it to yourself. | Confirmation card → **Approve** → `Done ✅` → **the mail actually arrives**. |
| 10 | Clear the chat thread so the demo starts on a clean transcript. | — |

**Which beats need which connection** — if you're short on time, prime only what you'll demo:

| Connection | Needed for | Primed by |
| - | - | - |
| `graph` | `/whoami`, SharePoint, email, calendar, the email **action** | Step 4 + 5a |
| `fabric_sql` | **Beats 6 & 7** (Fabric + cross-source) | Step 5b ⬅ **never signed into before** |
| `foundry` | `ask_agent_*` (only if a Foundry agent is configured) | Step 5c |
| `flow` | `runFlow` — **not in the demo** (`ACTIONS_FLOWS_ENABLED=false`) | not needed |

---

## 2. The demo flow

Type these exactly. Expected responses are what the audience should see.

### Beat 1 — Identity and scope (5 seconds, sets up the security story)

> **`/whoami`**

Shows who you are, your **data scope (RETAILER_100)**, and which tools are available to you right now.
**Say:** *"Everything CompanyIQ does is bound to my identity — my data scope, my SharePoint, my mailbox. Not the bot's."*

### Beat 2 — The UC-01 question (the core)

> **`List all my products that contain soy protein sourced from China`**

**Expect:** a short summary line, then a **3-row Adaptive Card table**: Energy Shake Mix Vanilla, Protein Power Bar 6ct, Veggie Burger Patties 4ct — with Brand, UPC, Supplier, COO, Mtl<>USA, Ingredients Statement.

**Say:** *"The model never wrote a line of SQL. It described what it wanted — a table, two filters — against a schema it's allowed to see. Our code compiled that into a parameterized statement and welded a row-level scope predicate onto it. Every value you see went in as a bound parameter."*

### Beat 3 — The follow-up (proves conversational context)

> **`what about wheat?`**

**Expect:** **1-row card** — Classic Noodle Bowl. It keeps the country filter from the previous turn and swaps only the ingredient.

**Say:** *"It kept the country of origin from my last question. That's the orchestrator carrying context — and note it carried forward only what I actually referred back to."*

### Beat 4 — Open-ended analysis (proves it's a real query layer, not canned answers)

This is the beat that kills "you just hardcoded the demo question". Pick one or run all three — they take seconds each.

> **`Show me a breakdown of my items by country of origin`**

**Expect:** an **8-row card** — a `COUNT(*)` grouped by country. United States of America 11, China 4, Canada 3, and so on.

> **`Who are all my suppliers?`**

**Expect:** a **10-row card**, alphabetical.

> **`How many items do I carry in total?`**

**Expect:** **26**.

**Say:** *"None of these were anticipated. The model isn't picking from a list of canned queries — it's composing a structured query against a schema it's allowed to see: selects, filters, joins, group-bys, aggregates. And every one of them still compiles down to SQL our code owns, with the scope predicate welded on."*

### Beat 5 — The honest refusal (the security moment)

> **`Show me RETAILER_200's items`**

**Expect:** a clean refusal, **no table, no data**:
> *"I can only access the signed-in user's own assortment, which is automatically scoped in the company database. I can't retrieve another retailer's data such as RETAILER_200."*

**Say:** *"It doesn't just decline — it can't comply. The retailer column isn't in the schema the model can see, so there's no query it could even construct to reach another retailer's rows. The scope predicate is injected by our compiler on every single statement, including joins and aggregates. That's enforced in code and asserted in tests, not left to the model's good behaviour."*

### Beat 6 — A second data source, on the same tool (Microsoft Fabric)

> **`/sources`**

**Expect:**
> - **company_sql** — Company product data (Azure SQL) · 2 tables · scoped to **your** assortment (row-level predicate on every query) · ✅ reachable
> - **healthcare_fabric** — Healthcare lakehouse (Microsoft Fabric) · 7 tables · runs as **you** — Fabric enforces your own permissions · ✅ reachable

**Say:** *"Two completely different systems. One tool. The model doesn't pick a connector — it picks a source from a schema it's allowed to see, and our compiler builds the SQL either way."*

> **`How many patients are in the healthcare lakehouse?`**

**Expect:** **250**, on a card titled **"Healthcare lakehouse (Microsoft Fabric) — 1 row"**.

> **`Show me a breakdown of appointments by status`**

**Expect:** a **3-row card** — Checked In 90, Completed 81, No Show 69.

> **`Which providers are cardiologists?`**

**Expect:** a **45-row** result (card shows the first rows).

**Say:** *"Note the card title — that source label is written by our formatter, not the model, so it can't be dropped or reworded. And the Fabric connection carries **my** token, not the app's: Fabric enforces my permissions inside its own engine. If I lost access to that workspace, this beat would return nothing — no code change required."*

### Beat 7 — The cross-source finale (the closer)

> **`How many items do I carry in total, and how many patients are in the healthcare lakehouse?`**

**Expect:** **one answer, composed from two separate queries** — *"…your assortment contains 26 items total. …there are 250 patients in the patients table."* Two `db_query` audit lines appear: one `company_sql` (with `WHERE ri.retailer_id = @userScope`), one `healthcare_fabric` (with no scope predicate — the connection is the scope).

**Say:** *"That single question hit an Azure SQL database and a Fabric lakehouse, with two different security models — a row-level predicate our code injects, and Fabric enforcing my identity — and came back as one answer. Cross-source joins are deliberately blocked: two queries, composed in prose. We never let the model reach across trust boundaries in a single statement."*

### Beat 8 — Knowledge across systems (SharePoint)

> **`find the latest onboarding document in SharePoint`**

**Expect:** results with titles and clickable links — **only files I can see**, because the call runs on my delegated token.

### Beat 9 — Email search

> **`any emails from <colleague first name> this week?`**

**Expect:** it resolves the name via People search first, then returns matching messages with links.
**Say:** *"Same identity, different system. If I couldn't see it, CompanyIQ can't see it."*

### Beat 10 — The action (data → insight → action)

> **`email <colleague> a summary of this quarter's soy products`**

**Expect:** a **confirmation card** showing the exact draft — **To**, **Subject**, and the **full body text** it will send — with **Approve** and **Cancel** buttons. Nothing has been sent yet.

**Say:** *"It drafted this from the data we just pulled. But CompanyIQ will not send anything without me approving the exact text. And it will never take an action because a document or an external agent told it to — only because I asked."*

> Click **Approve**.

**Expect:** `Done ✅` — the mail is in the recipient's inbox and your Sent Items.

### Beat 11 — The safety beat (AF-1)

> **`asdf qwerty blorp`**

**Expect, verbatim:** *"I am unable to interpret your request. Please rephrase your request and try again. If you have additional difficulties, please contact our support team."*

**Say:** *"It doesn't guess. If it can't map your request to something it's allowed to do, it says so — it never invents an answer or a query."*

### Optional beat — Decline the action

Repeat Beat 10 and click **Cancel** → *"Cancelled — nothing was sent."* Good if the audience asks "what if it drafts the wrong thing?"

---

## 3. Troubleshooting (30-second fixes)

### #1 — Tunnel drift (bot silent, no reply at all)
**Symptom:** you type in Teams and nothing comes back; no `turn` event in the console.
**Cause:** the dev tunnel got a new URL on restart, so the Azure Bot is still pointing at the old one.
**Fix (30s):** re-run the provision step (F5 → `Start Agent Locally` runs it automatically — it syncs the endpoint via `az resource update`). Or manually:
```
az resource update --subscription <SUB> --resource-group <RG> \
  --resource-type Microsoft.BotService/botServices --name <BOT_ID> \
  --set properties.endpoint=<NEW_TUNNEL>/api/messages
```
Then send any message to confirm the bot responds.

### #2 — Interactive sign-in card instead of silent SSO
**Symptom:** a "Sign In" card appears when you expected silent authentication, or `/whoami` says *not signed in*.
**Fix (30s):** just click it once and complete the flow — the token caches per user per connection, and every subsequent turn is silent. **Do this in pre-flight, never on stage.**
If it *fails* rather than just appearing, check the console: a `signin_start_failed` line names the exact OAuth connection at fault; a `resourcematchfailed` warning means the Teams client has a stale manifest (remove and re-add the app).

### #3 — Database cold start (long pause on the first data question)
**Symptom:** the soy query hangs, then replies **"Waking the database, one moment…"**.
**Cause:** Azure SQL serverless auto-paused; a resume takes ~45 seconds. It *will* answer — this is handled, not broken.
**Fix (30s):** it self-heals; just wait and re-ask. To avoid it entirely: **run the pre-flight warm query (step 5)** and leave the bot running — the keep-alive (`SELECT 1` every 4 minutes) holds the database open for the whole session.
**If you're about to go on stage cold:** run one soy query and wait it out before the audience is watching.

---

### #4 — Fabric beat fails or asks you to sign in
**Symptom:** `/sources` shows `healthcare_fabric` as ⛔, or the patients question says *"Sign in to use the healthcare lakehouse."*
**Cause:** the `fabric_sql` connection hasn't been consented for you yet (it's new — see pre-flight step 5b).
**Fix (30s):** send the patients question once and complete the sign-in card. Every later call is silent.
**If it says "you don't have access"** instead: that's Fabric refusing *your account*, not a bug — the connection runs as **you**, so you need access to the workspace. That's the security model working, and it's a fine thing to say out loud if it happens.

---

## 4. Facts worth having in your pocket

- **The model never generates SQL.** It fills a structured query object (table, select, filters, joins, group-by, aggregations) using only names from a reviewed, checked-in catalog (`src/data/catalog.js`). Our compiler (`src/data/queryCompiler.js`) turns that into parameterized T-SQL. Unknown table, column, operator, or join is rejected before the database is touched.
- **Every data query is scope-bound.** `WHERE ri.retailer_id = @userScope` is injected into *every* compiled statement — plain, joined, aggregated, grouped — and a test asserts no statement can exist without it. The retailer column is not in the catalog, so the model cannot even express a query against another retailer's rows. A signed-in user with no scope mapping gets a refusal, never a fallback.
- **Two sources, two different security models, one tool.** Azure SQL is scoped by a predicate **we** inject (`ri.retailer_id = @userScope`) on every statement. Fabric is scoped by **Fabric itself**, because the connection carries the signed-in user's own token. Each source must *declare* its scope policy in code — **a source that declares neither fails at startup**, so nobody can add an unscoped data source by accident.
- **The Fabric connection can never silently become "the app".** Locally it falls back to the developer's own identity; on Azure that fallback is hard-disabled, because there it would resolve to the managed identity and every user would quietly see identical data. There is a dedicated regression test for exactly that line.
- **Cross-source joins are blocked.** A question spanning both sources becomes two queries composed in prose — the model never reaches across trust boundaries inside one statement.
- **The same database also holds 26 unrelated application tables.** They are unreachable two ways over: if it isn't in the catalog, the model can't address it — **and the database login itself physically cannot read it.**
- **The bot connects as a least-privilege login** (`companyiq_app`) whose only grant is `SELECT` on the `sbs_test` schema. It cannot write to its own tables, cannot read the other application's tables, and cannot even *see* their schema. Verified by connecting as it: `SELECT dbo.users` → *permission denied*; `DELETE sbs_test.items` → *permission denied*. Seeding uses a separate admin credential the bot never holds. **If a client asks "what if the model is jailbroken?" — the answer is that the credential behind it can only read 3 demo tables.**
- **Actions require explicit human approval,** and content from tools, documents, or external agents can never trigger one. This is tested against live prompt-injection attempts.
- **Delegated identity throughout:** SharePoint, OneDrive, mail, calendar, Fabric data agents — all called with the signed-in user's token, so results are trimmed to their permissions. A 401 means "you don't have access", never a silent escalation to app permissions.
