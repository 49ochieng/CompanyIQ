# CompanyIQ

CompanyIQ is a Teams-based orchestration agent that knows the company. It answers questions by routing to tools: a SQL data tool (highest priority), document search (Azure AI Search), Microsoft Graph tools (SharePoint, OneDrive, email via user SSO), and web search. UC-01 (SBS AI Query) is the reference use case. It is built on the M365 Agents Toolkit "Chat With Your Data (Azure AI Search)" template using the Teams AI Library v2 (`@microsoft/teams.*` v2, plain Node.js CommonJS).

## Architecture

```
Teams message
  → src/app/app.js (entry, auth, history)
    → src/orchestrator/orchestrator.js (ChatPrompt with function calling)
        → src/tools/queryCompanyData.js   (intent whitelist → validator → parameterized SQL)
        → src/tools/searchDocuments.js    (Azure AI Search retrieval as a tool)
        → src/tools/searchSharePoint.js   (Graph OBO — Phase 3)
        → src/tools/searchEmail.js        (Graph OBO — Phase 3)
        → src/tools/searchOneDrive.js     (Graph OBO — Phase 3)
        → src/tools/webSearch.js          (Phase 4)
    → src/formatting/responseFormatter.js (AI-assisted explanation + Adaptive Card tables)
  → MessageActivity back to Teams
```

Hard rules:

- The AI never generates or executes SQL. The model only selects a whitelisted intent and fills parameters via function calling; all SQL is parameterized in application code.
- Every SQL execution carries a row-level scope predicate derived from the authenticated user (config-driven `DEV_USER_SCOPE` until SSO lands in Phase 3).
- Unknown or unparseable requests get the AF-1 fallback response; the bot never guesses an intent.
- Secrets live in `env/.env.*.user` locally and Azure app settings / Key Vault in the cloud — never in code or committed env files.

## Phase plan

| Phase | Scope | Status |
| - | - | - |
| 0 | Repo hygiene: declare transitive deps, fix history accumulation, folder scaffolding | done |
| 1 | Orchestrator with function calling, tool registry, `searchDocuments` + `queryCompanyData` stub, response formatter | pending |
| 2 | Real SQL tool: `mssql` pool, schema introspection, intent whitelist, validation, row caps, audit logging, unit tests | pending |
| 3 | Teams SSO (Entra app, `webApplicationInfo`, OAuth connection) and Graph tools: SharePoint, OneDrive, email | pending |
| 4 | Web search, Key Vault, managed-identity auth to Azure services, telemetry, Azure deploy | pending |

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