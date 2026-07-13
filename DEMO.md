# CompanyIQ — Demo Runbook

The demo arc: **data → insight → action**. A scoped SQL question, a follow-up that proves conversational context, open-ended analysis over the same data, knowledge retrieval across SharePoint and email, and finally an action the user approves before it happens — plus two security moments (an honest refusal, and the AF-1 safety beat).

**The data behind the demo:** 40 items, 12 suppliers, 12 countries of origin, split across two retailer assortments. You are `RETAILER_100` and see **26 items / 10 suppliers**. `RETAILER_200` has a different, overlapping set of 20 — which is what makes the scope story real rather than theoretical.

---

## 1. Pre-flight (start 30 minutes before)

Run these in order. Every step has a visible pass signal — don't proceed past a failure.

| # | Do this | Pass signal |
| - | - | - |
| 1 | **Restart the dev task** in VS Code (`Start Agent Locally`, or `npm run dev:teamsfx`). Kill any stale process holding port 3978 first: `netstat -ano \| findstr :3978` → `taskkill /PID <pid> /F` | Console shows `startup_config` with `"botType":"SingleTenant"`, `clientSecretPresent: true`, then `listening on port 3978 🚀` |
| 2 | **Warm the database.** It happens automatically at startup — just watch for it. | `{"event":"db_warmup","reason":"startup","ok":true,...}`. **A cold database takes ~45 seconds here; a warm one ~3s.** Keep-alive then pings every 4 min, so it stays hot for the whole demo. |
| 3 | **Verify the tunnel matches the bot.** The dev tunnel URL changes on some restarts. <br>`az resource show -g <RG> --resource-type Microsoft.BotService/botServices -n <BOT_ID> --query properties.endpoint -o tsv` <br>compare with `BOT_ENDPOINT` in `env/.env.local` | The two match (`https://<tunnel>/api/messages`). If not → see Troubleshooting #1. |
| 4 | In Teams, open the CompanyIQ chat and send **`/whoami`** | `Signed in as: <you>` · `Data scope: RETAILER_100` · `Scope map: 1 entry loaded (you matched)`. If it says *none matched* or *0 entries* → see Troubleshooting #2. |
| 5 | **One warm soy query** (throwaway, to confirm the path end to end): `List all my products that contain soy protein sourced from China` | 3-row table card, returns in well under a second. |
| 6 | **`/agents`** | Lists configured connectors and their status (✅ available). Empty list is fine if none are configured — just don't demo that beat. |
| 7 | **Silent sign-in check**: `/signout`, then `sign in` | The second sign-in completes **without** an interactive card ("You're signed in."). If a card appears → see Troubleshooting #2. |
| 8 | Clear the chat thread (optional) so the demo starts on a clean transcript. | — |

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

### Beat 6 — Knowledge across systems (SharePoint)

> **`find the latest onboarding document in SharePoint`**

**Expect:** results with titles and clickable links — **only files I can see**, because the call runs on my delegated token.

### Beat 7 — Email search

> **`any emails from <colleague first name> this week?`**

**Expect:** it resolves the name via People search first, then returns matching messages with links.
**Say:** *"Same identity, different system. If I couldn't see it, CompanyIQ can't see it."*

### Beat 8 — The action (the closer)

> **`email <colleague> a summary of this quarter's soy products`**

**Expect:** a **confirmation card** showing the exact draft — **To**, **Subject**, and the **full body text** it will send — with **Approve** and **Cancel** buttons. Nothing has been sent yet.

**Say:** *"It drafted this from the data we just pulled. But CompanyIQ will not send anything without me approving the exact text. And it will never take an action because a document or an external agent told it to — only because I asked."*

> Click **Approve**.

**Expect:** `Done ✅` — the mail is in the recipient's inbox and your Sent Items.

### Beat 9 — The safety beat (AF-1)

> **`asdf qwerty blorp`**

**Expect, verbatim:** *"I am unable to interpret your request. Please rephrase your request and try again. If you have additional difficulties, please contact our support team."*

**Say:** *"It doesn't guess. If it can't map your request to something it's allowed to do, it says so — it never invents an answer or a query."*

### Optional beat — Decline the action

Repeat Beat 8 and click **Cancel** → *"Cancelled — nothing was sent."* Good if the audience asks "what if it drafts the wrong thing?"

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

## 4. Facts worth having in your pocket

- **The model never generates SQL.** It fills a structured query object (table, select, filters, joins, group-by, aggregations) using only names from a reviewed, checked-in catalog (`src/data/catalog.js`). Our compiler (`src/data/queryCompiler.js`) turns that into parameterized T-SQL. Unknown table, column, operator, or join is rejected before the database is touched.
- **Every data query is scope-bound.** `WHERE ri.retailer_id = @userScope` is injected into *every* compiled statement — plain, joined, aggregated, grouped — and a test asserts no statement can exist without it. The retailer column is not in the catalog, so the model cannot even express a query against another retailer's rows. A signed-in user with no scope mapping gets a refusal, never a fallback.
- **The same database also holds 26 unrelated application tables.** They are unreachable two ways over: if it isn't in the catalog, the model can't address it — **and the database login itself physically cannot read it.**
- **The bot connects as a least-privilege login** (`companyiq_app`) whose only grant is `SELECT` on the `sbs_test` schema. It cannot write to its own tables, cannot read the other application's tables, and cannot even *see* their schema. Verified by connecting as it: `SELECT dbo.users` → *permission denied*; `DELETE sbs_test.items` → *permission denied*. Seeding uses a separate admin credential the bot never holds. **If a client asks "what if the model is jailbroken?" — the answer is that the credential behind it can only read 3 demo tables.**
- **Actions require explicit human approval,** and content from tools, documents, or external agents can never trigger one. This is tested against live prompt-injection attempts.
- **Delegated identity throughout:** SharePoint, OneDrive, mail, calendar, Fabric data agents — all called with the signed-in user's token, so results are trimmed to their permissions. A 401 means "you don't have access", never a silent escalation to app permissions.
