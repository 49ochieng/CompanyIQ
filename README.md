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
        → src/tools/webSearch.js          (flag-gated allowlist fetch; Bing Grounding later)
    → src/formatting/responseFormatter.js (Adaptive Card tables, citations, labeled external web section)
  → MessageActivity back to Teams
```

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
| `AZURE_SQL_USERNAME` / `AZURE_SQL_PASSWORD` | SQL auth | env file | Key Vault `azure-sql-username` / `azure-sql-password` |
| `DEV_USER_SCOPE` | TEMPORARY scope when not signed in | env file | — (unset in Azure) |
| `USER_SCOPE_MAP` | JSON UPN/objectId → scope | env file | app setting |
| `OAUTH_CONNECTION_NAME` | bot OAuth connection (default `graph`) | env file | app setting |
| `SHAREPOINT_SITES` | comma-separated site URLs constraining SharePoint search | env file | app setting |
| `CONNECTOR_PUBLIC_WEB_ENABLED` / `ORG_WEBSITE_ALLOWLIST` | web tool gate + domains | env file | app setting |
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

## Local vs deployed

| | Local / Playground | Azure (dev) |
| - | - | - |
| Start | F5 "Debug in Microsoft 365 Agents Playground" (no auth) or "Start Agent Locally" (Teams + dev tunnel) | `atk provision --env dev` + `atk deploy --env dev` |
| Bot identity | Entra app + secret (`aadApp/create`) | user-assigned managed identity |
| Secrets | `env/.env.*.user` → `.localConfigs` | Key Vault via managed identity |
| SSO/Graph | works in Teams local debug only (OAuth connection on the dev.botframework.com registration) | OAuth connection on the Azure Bot resource |
| SQL scope | `DEV_USER_SCOPE` (playground) / `USER_SCOPE_MAP` (Teams) | `USER_SCOPE_MAP` |
| Tests | `npm test` (30 tests, DB mocked) | — |
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
> - [Node.js](https://nodejs.org/), supported versions: 20, 22
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