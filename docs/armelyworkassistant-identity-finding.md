# ArmelyWorkAssistant — how its tools authenticate to data (for the agent owner)

**What this is:** a factual summary of how ArmelyWorkAssistant (project `firstProject` on `AI-FOUNDRY-MAIN-001`, version 3) authenticates to its knowledge and tool sources when it runs on behalf of a signed-in user. It affects everyone who uses this agent — in Teams or anywhere else — not one specific caller. Sharing it so the decision sits with you, with full information.

## Summary

When a caller invokes the agent with their own Entra token (delegated / on-behalf-of), the agent's **inner tools do not all run as the caller.** They split into two groups by how their project connection is configured:

| Inner tool | Project connection | Credential type | Runs as |
| --- | --- | --- | --- |
| WorkIQ SharePoint / Calendar / Mail / Teams / OneDrive (`agent365.svc.cloud.microsoft`) | `WorkIQ*` | `UserEntraToken` | the **caller** (on-behalf-of) |
| SharePoint knowledge the agent actually uses | `kb-foundryiqsharepoint-ctup5` → Azure AI Search knowledge base `foundryiqsharepoint001` | `CustomKeys` (underlying search connection `armelyaisearchectup5` = `ApiKey`) | a **shared key**, not the caller |
| web_search | built-in | — | public web (no user data) |
| code_interpreter | agent container | agent instance identity | no user data unless passed in |

## Why the knowledge-base path can't trim per user

Azure AI Search enforces per-user document-level security only when the **caller's identity reaches the search service** — i.e. the retrieval call carries the user's on-behalf-of token, and the index has document-level access control. The `kb-foundryiqsharepoint-ctup5` connection authenticates with a **stored key**, so every retrieval runs as that key with the same permissions regardless of who asked. There is no per-user principal for the search service to trim against.

Net effect: two different employees asking the same question receive the **same** SharePoint-derived content, even if one of them has no permission to the underlying SharePoint documents. Content indexed into `foundryiqsharepoint001` is effectively readable by anyone who can invoke the agent.

References: [Agent identity concepts](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/agent-identity) · [Connect Azure AI Search to Foundry agents](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/ai-search) · [Security in Azure AI Search](https://learn.microsoft.com/en-us/azure/search/search-security-overview)

## The platform already supports the trimmed path

This is a configuration choice, not a platform limitation. The same project already has a `WorkIQSharePoint` connection (`agent365 .../mcp_SharePointRemoteServer`) configured as `UserEntraToken` — that path forwards the caller's identity and returns only what each user is permitted to see. The agent's blueprint currently grounds SharePoint through the key-based Azure AI Search knowledge base instead.

## What you'd change if you want per-user trimming

Any one of:

1. **Swap the knowledge source** in the agent's blueprint from the `foundryiqsharepoint001` Azure AI Search knowledge base to the on-behalf-of SharePoint tool (`WorkIQSharePoint`, already present as `UserEntraToken`).
2. **Make the knowledge base identity-aware** — configure the Azure AI Search connection for Entra / on-behalf-of instead of a key, and ensure the index carries document-level permissions (ACL/security-trimming fields) sourced from SharePoint.
3. **Accept it deliberately** — if the indexed corpus is intended to be readable by everyone who can use the agent, no change is needed; just make that an explicit, recorded decision.

## How to confirm empirically

Put a document with a unique phrase in a SharePoint location one account can access and another cannot; make sure it's indexed into `foundryiqsharepoint001`. Ask the agent the same question as each account. If the account **without** access still gets the content, per-user trimming is off.

*No action is requested here — this is information so you can decide.*
