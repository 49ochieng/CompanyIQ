# CompanyIQ

CompanyIQ is a Teams-based orchestration agent that knows the company. It answers questions by routing to tools: a SQL data tool (highest priority), document search (Azure AI Search), Microsoft Graph tools (SharePoint, OneDrive, email via user SSO), and web search. UC-01 (SBS AI Query) is the reference use case. It is built on the M365 Agents Toolkit "Chat With Your Data (Azure AI Search)" template using the Teams AI Library v2 (`@microsoft/teams.*` v2, plain Node.js CommonJS).

## Architecture

```
Teams message
  → src/index.js (startup: Key Vault secret resolution, then app boot)
  → src/app/app.js (App setup, SSO sign-in flow, conversation history)
      src/auth/userContext.js (identity from SSO token → data scope via USER_SCOPE_MAP)
    → src/orchestrator/orchestrator.js (ChatPrompt with function calling + audit log)
        → src/tools/queryCompanyData.js   (intent whitelist → validator → parameterized SQL, row-level scope)
        → src/tools/searchDocuments.js    (Azure AI Search hybrid retrieval)
        → src/tools/searchSharePoint.js   (Graph Search API, delegated token)
        → src/tools/searchOneDrive.js     (Graph /me/drive search, delegated token)
        → src/tools/searchEmail.js        (Graph /me/messages $search, delegated token)
        → src/tools/getCalendar.js        (Graph /me/calendarView, delegated token)
        → src/tools/getPlannerTasks.js    (Graph /me/planner/tasks, delegated token)
        → src/tools/findPeople.js         (Graph /me/people fuzzy lookup, delegated token)
        → src/tools/webSearch.js          (flag-gated allowlist fetch; Bing Grounding later)
        → src/connectors/*                (external: ask_agent_<name> via Foundry Responses API
                                           or HTTP contract; mcp_<server>_<tool> via MCP
                                           Streamable HTTP — untrusted, circuit-broken, no tokens)
    → src/formatting/responseFormatter.js (Adaptive Card tables, citations, labeled external sections)
  → MessageActivity back to Teams
```

Slash commands (parsed in `src/app/commands.js` before the orchestrator): `/help`, `/whoami`, `/data`, `/docs`, `/mail`, `/calendar`, `/agents`, `/web`. Unknown commands get help text, never AF-1.

Supporting modules: `src/data/db.js` (mssql pool), `src/data/intents.js` (the ONLY SQL in the app), `src/auth/graph.js` (delegated Graph fetch), `src/auth/azureCredential.js` (managed-identity auth), `src/secrets.js` (Key Vault at startup).

Hard rules:

- The AI never generates or executes SQL. The model only selects a whitelisted intent and fills parameters via function calling; all SQL is parameterized in application code (`src/data/intents.js`).
- Every SQL execution carries the row-level scope predicate `ri.retailer_id = @userScope`. The scope comes from the signed-in user via `USER_SCOPE_MAP`; a signed-in but unmapped user gets "no data scope assigned" (never a fallback). `DEV_USER_SCOPE` applies only when nobody is signed in (playground).
- Graph tools use delegated tokens only (Teams SSO → OAuth connection token exchange). Results inherit the signed-in user's own permissions. Never app-only.
- Unknown or unparseable requests get the AF-1 fallback response; the bot never guesses an intent.
- Secrets live in `env/.env.*.user` locally and Key Vault (resolved at startup by managed identity) in Azure — never in code or committed env files.
- The public web tool registers only when `CONNECTOR_PUBLIC_WEB_ENABLED=true`, fetches only `ORG_WEBSITE_ALLOWLIST` domains, and its output renders in a separate section labeled as external information.

## Environment variables

| Variable | Purpose | Local source | Azure source |
| - | - | - | - |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI key (omit to use managed identity) | `env/.env.*.user` | Key Vault `azure-openai-api-key` |
| `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_API_VERSION` | Azure OpenAI resource | env file | app setting |
| `AZURE_OPENAI_CHAT_DEPLOYMENT` / `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` | deployments | env file | app setting |
| `AZURE_SEARCH_ENDPOINT` / `AZURE_SEARCH_INDEX_NAME` | AI Search resource + index | env file | app setting |
| `AZURE_SEARCH_QUERY_KEY` | runtime search key (omit for managed identity) | env file | Key Vault `azure-search-query-key` |
| `AZURE_SEARCH_ADMIN_KEY` | indexer scripts only | env file | — |
| `AZURE_SQL_SERVER` / `AZURE_SQL_DATABASE` | SQL target | env file | app setting |
| `AZURE_SQL_USERNAME` / `AZURE_SQL_PASSWORD` | SQL auth — the **least-privilege** app login (`SELECT` on `sbs_test` only; see [least-privilege-setup.sql](src/data/least-privilege-setup.sql)) | env file | Key Vault `azure-sql-username` / `azure-sql-password` |
| `AZURE_SQL_ADMIN_USERNAME` / `AZURE_SQL_ADMIN_PASSWORD` | Elevated credential used **only** by `db:seed` / `db:introspect`. The bot never uses it. | env file | — |
| `DEV_USER_SCOPE` | TEMPORARY scope when not signed in | env file | — (unset in Azure) |
| `USER_SCOPE_MAP` | JSON UPN/objectId → scope | env file | app setting |
| `OAUTH_CONNECTION_NAME` | bot OAuth connection (default `graph`) | env file | app setting |
| `SHAREPOINT_SITES` | comma-separated site URLs constraining SharePoint search | env file | app setting |
| `CONNECTOR_PUBLIC_WEB_ENABLED` / `ORG_WEBSITE_ALLOWLIST` | web tool gate + domains | env file | app setting |
| `MCP_SERVERS` | JSON: `[{name,url,authHeader?,authMode?:"user",connection?,allowedTools?,allowedContext?}]` | env file | app setting |
| `FOUNDRY_AGENTS` | JSON: `[{name,description,projectEndpoint,agentIdOrName,identity?:"user"\|"app",allowedContext?}]` | env file | app setting |
| `HTTP_AGENTS` | JSON: `[{name,description,url,tokenEnv,allowedContext?}]` | env file | app setting |
| `FABRIC_DATA_AGENTS` | JSON: `[{name,description,workspaceId,dataAgentId}]` — registers `ask_fabric_<name>` | env file | app setting |
| `FABRIC_SQL_ENDPOINT` / `FABRIC_DATABASE` | The lakehouse SQL analytics endpoint and database. Both required, or the source is not registered (`/sources` says so). | env file | app setting |
| `FABRIC_LOCAL_DEV_IDENTITY` | **Local only.** Use the developer's own `az login` identity for Fabric when there is no Teams SSO (playground/harness). **Hard-disabled on Azure** — otherwise `DefaultAzureCredential` would return the managed identity and silently turn this into an app-identity source. | env file | never set |
| `FABRIC_TENANT_ID` / `FABRIC_CLIENT_ID` / `FABRIC_CLIENT_SECRET` | **Not used at runtime.** The Fabric source authenticates as the signed-in user; no service principal is involved. Kept only for reference/tools. | env file | — |
| `GRAPH_SCOPES` | delegated scope list (must match the OAuth connection) | env file | — |
| `PARALLEL_TOOL_CALLS_ENABLED` | kill switch for the A2 parallel tool-call fan-out (`ParallelOpenAIChatModel`); default **on**; set to `false` to fall back to the stock SDK's sequential model without a deploy | env file | app setting |
| `KEY_VAULT_URI` | enables startup secret resolution | — | Bicep output |
| `CLIENT_ID` / `CLIENT_SECRET` / `TENANT_ID` / `BOT_TYPE` | bot identity | `.localConfigs` (generated) | Bicep (managed identity) |

## How to add a new SQL intent

1. Add an entry to `INTENTS` in [src/data/intents.js](src/data/intents.js): parameter rules (`required`, `maxLength`, `pattern`, optional `normalize`, `sqlType`) and the parameterized `where` fragment. Never interpolate values — bind everything as `@params`. The scope predicate is injected automatically by `buildStatement()`.
2. Add the intent name to nothing else — the tool's enum reads `Object.keys(INTENTS)`.
3. Add validator/statement tests in [src/data/intents.test.js](src/data/intents.test.js) (the scope-predicate test loops all intents automatically).
4. If the intent needs new columns, extend `BASE_SELECT` and the formatter's `TABLE_COLUMNS`.

## How to add a new tool

1. Create `src/tools/<name>.js` exporting `{ name, description, parameters (JSON schema), handler(args, context) }`. The handler returns a JSON-serializable result; return `{ error: "..." }` shapes for structured refusals (`auth_required` triggers the sign-in flow; `validation_failed` maps to AF-1).
2. Register it in [src/tools/index.js](src/tools/index.js) (gate on a config flag if it must be invisible by default).
3. Teach the model when to use it: add a selection rule to [src/app/instructions.txt](src/app/instructions.txt).
4. If it produces a new render shape, extend [src/formatting/responseFormatter.js](src/formatting/responseFormatter.js).
5. Log through the existing JSON-line audit events (no user content in logs).

## Data sources and identity

CompanyIQ has two structured data sources behind **one** tool (`queryCompanyData`). The model picks a source from the catalog; it never writes SQL. Each source declares its **scope policy** in code — a source with no declared policy fails at **startup**, never silently at query time.

| Source | Data | Identity | How row-level access is enforced |
| - | - | - | - |
| `company_sql` (Azure SQL, `sbs_test`) | Company products, suppliers, assortment | App login, **least-privilege** (`SELECT` on `sbs_test` only) | **`row_predicate`** — the compiler injects `ri.retailer_id = @userScope` into **every** statement (plain, joined, aggregated, grouped). Mandatory and unconditional; asserted in tests. |
| `healthcare_fabric` (Fabric lakehouse SQL analytics endpoint) | Patients, providers, encounters, appointments, labs, notes | **The signed-in user** (delegated token) | **`enforced_by_source`** — the TDS connection carries the user's own token, so **Fabric enforces that user's workspace permissions inside the engine**. They see exactly what they are entitled to see. |

**The Fabric source runs as the user, not as a service principal.** A spike proved the Fabric SQL analytics endpoint accepts a delegated user token over TDS, so there is no org-wide data exposure and no client secret at runtime. Two things this depends on:

- **The TDS audience is `https://database.windows.net/`** — *not* `https://api.fabric.microsoft.com/`, which TDS rejects (that audience is only for the Fabric REST / data-agent MCP surface). This is why there are two Fabric OAuth connections: `fabric` (REST/MCP) and `fabric_sql` (TDS).
- **`encrypt: true` + `trustServerCertificate: false` are mandatory.** Omitting them fails the Entra handshake and surfaces as a generic login timeout that looks exactly like a bad password.

Other hard-won details: a fast `18456` login failure *after* a token was successfully acquired means Fabric-side authorization is missing (tenant setting "Service principals can call Fabric public APIs", plus the workspace/item grant) — **not** a bad credential, so don't rotate secrets chasing it. Cold lakehouse endpoints are slow on first connect, so sources warm up at startup, real queries retry, but `probe()` fails fast (single attempt, ~10s) so one dead source can never stall a user's turn.

**If a source is ever switched to app identity**, its scope policy must be revisited: every user would then see identical data, and that must be labeled in every response. The formatter — not the model — emits the source label on every card, so it cannot be omitted.

Cross-source joins are not supported: a single query may only reference tables from one source. A question spanning both produces two tool calls composed in prose. The catalogs are checked-in, reviewed artifacts (`src/data/catalogs/`); runtime never auto-discovers schema. Re-run `npm run fabric:introspect` deliberately when the lakehouse changes, then review the diff.

## Identity architecture — one CompanyIQ SSO app, one URI per bot

Teams **bot** SSO requires the token-exchange resource URI to embed the bot's ID (`api://botid-<botId>`) — the client rejects any other shape with `resourcematchfailed`. A single CompanyIQ-owned Entra app therefore carries **one `api://botid-…` identifier URI per environment's bot** (possible because it's a v2-token app; tenant policy blocks such URIs on v1 apps, which ruled out reusing the shared Mela app for SSO).

| App | Role | Where referenced |
| - | - | - |
| **CompanyIQlocal** (`4a91eb47…` = `SSO_APP_ID` everywhere, and local `BOT_ID`) | The CompanyIQ SSO app: `access_as_user`, Teams clients pre-authorized, admin consent on the 8 delegated `.Read` scopes, identifier URIs `api://botid-<local bot>` **and** `api://botid-<dev bot>`. Locally it doubles as the bot channel credential. | `webApplicationInfo.id`; OAuth connection `graph` (client id + `companyiq-oauth` secret) on both bot registrations |
| **Mela AI Meeting Assistant** (`7ed650f2…` = `AZURE_CLIENT_ID`) | App-only Graph credential for other integrations; NOT used for user SSO | env only |
| **bot<suffix> managed identity** (dev) | Deployed bot channel credential | Bicep (`msaAppType: UserAssignedMSI`) |

`webApplicationInfo.resource` = `api://botid-${{BOT_ID}}` (resolves per environment); each connection's Token Exchange URL matches its own bot's URI. Adding an environment = add one `api://botid-<newBotId>` URI to the SSO app.

## Identity-propagating delegation (Fabric + Foundry as the user)

The bot holds one OAuth connection per downstream audience — `graph` (default), `fabric` (`https://api.fabric.microsoft.com/.default`), `foundry` (`https://ai.azure.com/.default`) — all exchanging the same Teams SSO assertion. Tools resolve a per-audience user token at call time (`context.getAudienceToken(connection)`); a missing token triggers the sign-in flow for that specific connection and the question is retried after sign-in.

- **Fabric data agents** (`FABRIC_DATA_AGENTS` → `ask_fabric_<name>`): calls the published data agent's MCP endpoint with the **user's** Fabric token, so workspace/agent permissions bind to the person asking. Consent on the SSO app: Power BI Service delegated `Item.Execute.All` + `Workspace.Read.All`.
- **Foundry agents with `identity: "user"`**: the Responses API call carries the user's `ai.azure.com` token (consent: Microsoft Cognitive Services delegated `user_impersonation`); the user needs the **Azure AI User** role on the Foundry project. `identity: "app"` (default) keeps the bot's own credential.
- **Hard rule (tested)**: user-identity tools never fall back to the app credential. A 401/403 surfaces as a clean "you don't have access" message — that is the permission model working, not an error — and the model is instructed to relay it without retrying or answering from another source.
- All delegation results remain untrusted data (delimited markers, labeled sections, injection-tested).

### `userScoped` — every connector must classify itself

Each external connector entry (Foundry / HTTP / MCP / Fabric) **must** declare `"userScoped": true|false`. There is no default: an entry without an explicit boolean **fails at startup** (`src/connectors/validate.js`), because silently guessing is how one user ends up seeing another's data.

- `userScoped: true` — the caller's identity propagates all the way to the underlying data, so results are limited to what the signed-in user is allowed to see (a 401/403 is the permission model working). Required for the delegation guarantee to hold.
- `userScoped: false` — results **may include data beyond the caller's own access** (e.g. an agent that grounds on a knowledge base reached with a shared key, where the search service has no caller principal to trim against). The formatter labels every such result: *"⚠️ This may include information beyond your own access."*

**A label is disclosure, not a control.** Marking a connector `userScoped: false` does not make it safe — it only warns the user after the fact. Registering a non-user-scoped connector is a **deliberate exception to CompanyIQ's core guarantee that no path returns data the user can't see**, and must carry a written reason (why the broader exposure is acceptable for that specific source), recorded here or in the connector config review. Prefer fixing the propagation (an on-behalf-of / Entra path) over registering an exception. When a specific connector is found to be non-user-scoped, record the finding and remediation privately with the resource owner — internal security findings are not committed to this public repo.

## Parallel tool calls — SDK coupling ⚠️

`src/orchestrator/parallelModel.js` (`ParallelOpenAIChatModel`) subclasses the SDK's `OpenAIChatModel` and reimplements the batched-tool-call round so that **independent** calls the model emits in one turn run concurrently (`Promise.all`) instead of sequentially. Multi-hop chaining (call A → see result → call B) is unaffected — that already works via the SDK's own recursion.

**This overrides `send()` and mirrors the SDK's internal message-mapping and follow-up-completion logic. It is coupled to `@microsoft/teams.openai` internals.** On every `@microsoft/teams.*` upgrade, re-verify against the installed `node_modules/@microsoft/teams.openai/dist/chat.mjs`:
- the `send(input, options)` shape and the `{ system, messages, functions, request, onChunk, autoFunctionCalling }` options,
- the model→assistant / function→tool message mapping,
- the auto-function-calling recursion.

`src/orchestrator/parallelModel.test.js` locks the observable behavior (concurrency, single-call delegation, multi-hop chaining, resilient batch on a throwing call). If those tests fail after a bump, the override — not the test — is what needs updating. 0/1-call rounds and any streaming path delegate to `super`, so a mismatch degrades to the SDK's own behavior rather than breaking outright.

## Local vs deployed

| | Local / Playground | Azure (dev) |
| - | - | - |
| Start | F5 "Debug in Microsoft 365 Agents Playground" (no auth) or "Start Agent Locally" (Teams + dev tunnel) | `atk provision --env dev` + `atk deploy --env dev` |
| Bot identity | Entra app + secret (`aadApp/create`) | user-assigned managed identity |
| Secrets | `env/.env.*.user` → `.localConfigs` | Key Vault via managed identity |
| SSO/Graph | works in Teams local debug only (OAuth connection on the dev.botframework.com registration) | OAuth connection on the Azure Bot resource |
| SQL scope | `DEV_USER_SCOPE` (playground) / `USER_SCOPE_MAP` (Teams) | `USER_SCOPE_MAP` |
| Tests | `npm test` (54 tests, DB mocked) | — |
| Search index | `npm run indexer:create` / `db:seed` for SQL test schema | same resources |

## Phase plan

| Phase | Scope | Status |
| - | - | - |
| 0 | Repo hygiene: declare transitive deps, fix history accumulation, folder scaffolding | done |
| 1 | Orchestrator with function calling, tool registry, `searchDocuments` + `queryCompanyData` stub, response formatter | done |
| 2 | Real SQL tool: `mssql` pool, schema introspection, intent whitelist, validation, row caps, audit logging, unit tests | done |
| 3 | Teams SSO (Entra app, `webApplicationInfo`, OAuth connection) and Graph tools: SharePoint, OneDrive, email | done (live-tested) |
| 4 | Web search, Key Vault, managed-identity auth to Azure services, telemetry, Azure deploy | in progress |

---

# Overview of the Chat With Your Data (Using Azure AI Search) template

This app template showcases how to build one of the most powerful applications enabled by LLM - sophisticated question-answering (Q&A) chat bots that can answer questions about specific source information right in the Microsoft Teams.
This app template also demonstrates usage of techniques like: 
- [Retrieval Augmented Generation](https://python.langchain.com/docs/use_cases/question_answering/#what-is-rag), or RAG.
- [Azure AI Search](https://learn.microsoft.com/azure/search/search-what-is-azure-search)
- [Microsoft Teams SDK](https://aka.ms/teams-ai-library-v2)

## Get started with the template

> **Prerequisites**
>
> To run the template in your local dev machine, you will need:
>
> - [Node.js](https://nodejs.org/), supported version: 22 (Node 20 reached end-of-life April 2026)
> - [Microsoft 365 Agents Toolkit Visual Studio Code Extension](https://aka.ms/teams-toolkit) version 5.0.0 and higher or [Microsoft 365 Agents Toolkit CLI](https://aka.ms/teamsfx-toolkit-cli)
> - Prepare your own [Azure OpenAI](https://aka.ms/oai/access) resource and [Azure AI Search](https://azure.microsoft.com/en-us/products/ai-services/ai-search).

> For local debugging using Microsoft 365 Agents Toolkit CLI, you need to do some extra steps described in [Set up your Microsoft 365 Agents Toolkit CLI for local debugging](https://aka.ms/teamsfx-cli-debugging).

1. First, select the Microsoft 365 Agents Toolkit icon on the left in the VS Code toolbar.
1. In file *env/.env.playground.user*, fill in your Azure OpenAI key `AZURE_OPENAI_API_KEY=<your-key>`, endpoint `AZURE_OPENAI_ENDPOINT=<your-endpoint>`, API version `AZURE_OPENAI_API_VERSION=<api-version>`, chat deployment `AZURE_OPENAI_CHAT_DEPLOYMENT=<your-deployment>`, and embedding deployment `AZURE_OPENAI_EMBEDDING_DEPLOYMENT=<your-embedding-deployment>`. And fill in your Azure AI Search endpoint `AZURE_SEARCH_ENDPOINT=<your-ai-search-endpoint>`, query key `AZURE_SEARCH_QUERY_KEY=<query-key>`, admin key `AZURE_SEARCH_ADMIN_KEY=<admin-key>` (indexer only), and index name `AZURE_SEARCH_INDEX_NAME=<index-name>`.
1. Do `npm install` and `npm run indexer:create` to create the document index (keys are read from the env file; the index vector dimensions are derived from your embedding model automatically). Once you're done using the sample it's good practice to delete the index. You can do so with the `npm run indexer:delete` command.
1. Press F5 to start debugging which launches your app in Microsoft 365 Agents Playground using a web browser. Select `Debug in Microsoft 365 Agents Playground`.
1. You can send any message to get a response from the agent.

**Congratulations**! You are running an application that can now interact with users in Microsoft 365 Agents Playground:

![AI Search Bot](https://github.com/user-attachments/assets/464fe1b0-d8c6-4ecf-a410-8dde7d9ca9b3)

## What's included in the template

| Folder       | Contents                                            |
| - | - |
| `.vscode`    | VSCode files for debugging                          |
| `appPackage` | Templates for the application manifest        |
| `env`        | Environment files                                   |
| `infra`      | Templates for provisioning Azure resources          |
| `src`        | The source code for the application                 |

The following files can be customized and demonstrate an example implementation to get you started.

| File                                 | Contents                                           |
| - | - |
|`src/index.js`| Application entry point.|
|`src/config.js`| Defines the environment variables.|
|`src/app/app.js`| Main application code|
|`src/app/azureAISearchDataSource.js`| Defines the Azure AI search data source.|
|`src/indexers/data/*.md`| Raw text data sources.|
|`src/indexers/utils.js`| Basic index tools. |
|`src/indexers/setup.js`| A script to create index and upload documents. |
|`src/indexers/delete.js`| A script to delete index and documents. |

The following are Microsoft 365 Agents Toolkit specific project files. You can [visit a complete guide on Github](https://github.com/OfficeDev/TeamsFx/wiki/Teams-Toolkit-Visual-Studio-Code-v5-Guide#overview) to understand how Microsoft 365 Agents Toolkit works.

| File                                 | Contents                                           |
| - | - |
|`m365agents.yml`|This is the main Microsoft 365 Agents Toolkit project file. The project file defines two primary things:  Properties and configuration Stage definitions. |
|`m365agents.local.yml`|This overrides `m365agents.yml` with actions that enable local execution and debugging.|
|`m365agents.playground.yml`| This overrides `m365agents.yml` with actions that enable local execution and debugging in Microsoft 365 Agents Playground.|

## Extend the template

To extend the Basic AI Chatbot template with more AI capabilities, explore [Microsoft Teams SDK documentation](https://aka.ms/m365-agents-toolkit/teams-agent-extend-ai).

## Additional information and references

- [Microsoft 365 Agents Toolkit Documentations](https://docs.microsoft.com/microsoftteams/platform/toolkit/teams-toolkit-fundamentals)
- [Microsoft 365 Agents Toolkit CLI](https://aka.ms/teamsfx-toolkit-cli)
- [Microsoft 365 Agents Toolkit Samples](https://github.com/OfficeDev/TeamsFx-Samples)