# CompanyIQ capability audit — baseline

**Date:** 2026-07-27 (Phase 12, Step 1). This is the baseline snapshot future claims of "proven live" get checked against. Update it in place (with a dated entry in Amendments) rather than trusting memory or commit messages going forward.

## Evidence standard

- **Code exists** — the file/module is present and wired into the tool or connector registry.
- **Unit test** — whether `npm test` exercises it, and critically whether the test is a **mock/stub** or a **real network/credential call**. All 174 tests at audit time were mocked; none call a real endpoint.
- **Live — Teams local / deployed dev** — whether the capability has ever produced a verifiable result in one of those environments. "Verified" means a concrete captured result exists (HTTP status, response body, specific output — either in this repo or in a session record). "Claimed-only" means it's asserted in a doc, commit message, or demo script with no captured execution evidence. "Never" means no evidence exists at all.
- **Harness-level vs. Teams-client-level (added 2026-07-27, post-audit refinement):** proof captured via the headless channel-sink harness (posting Activities to `/api/messages`) exercises the same orchestrator/tool/connector logic path a real Teams turn would, and **counts as live proof for that logic**. It does **not** count as proof of card rendering, the OAuth sign-in card flow, or proactive delivery (digests, notifications) — those only happen in a real Teams client and must be marked separately. Entries below predate this refinement; where the underlying evidence is harness-level, it's noted explicitly rather than folded into a blanket "Teams local" claim.
- No acceptance-harness scripts are committed to this repo — they run from an ephemeral scratchpad, not source control, so "verified" claims below rely on session records at the time of audit, not a re-runnable artifact in this repo.

## Tools / data sources

| Capability | Code exists | Unit test | Live — Teams local | Live — deployed dev |
|---|---|---|---|---|
| queryCompanyData (SQL) | Yes | Mock | **Verified** (harness-level) — user-confirmed soy query + `/whoami` in local Teams, Phase 6 | Never |
| queryCompanyData (Fabric lakehouse source) | Yes | Mock | Never found | Never |
| searchDocuments (AI Search RAG) | Yes | Mock (added 2026-07-27) | Never found | Never |
| searchSharePoint | Yes | Mock (added 2026-07-27) | Claimed-only (DEMO.md script) | Never |
| searchOneDrive | Yes | Mock (added 2026-07-27) | Never found | Never |
| searchEmail (read/search) | Yes | Mock (added 2026-07-27) | Claimed-only (DEMO.md script) | Never |
| getCalendar | Yes | Mock (added 2026-07-27) | Never found | Never |
| getPlannerTasks | Yes | Mock (added 2026-07-27) | Never found | Never |
| findPeople | Yes | Mock (added 2026-07-27) | Claimed-only (implied dependency of other beats) | Never |
| webSearch | Yes | Mock | Not registered (`CONNECTOR_PUBLIC_WEB_ENABLED=false`) | Not registered |
| watchlistSearch / watchlistBrief | Yes | Mock | **Verified** (harness-level) — real dated dallascounty.org citation captured, digest delivery confirmed | Partially verified (crawl half explicitly run from dev App Service for egress reasons; the chat-turn side is ambiguous local vs. dev) |

## Connector / agent types

| Connector | Code exists | Unit test | Live — local | Live — dev | Currently registered? |
|---|---|---|---|---|---|
| Foundry agent (`ask_agent_*`) | Yes | Mock | **Verified** (harness-level) — but only ever against ArmelyWorkAssistant (HTTP 200, delegation audit captured, 2026-07-23) | Never | No — `FOUNDRY_AGENTS=[]` in both envs |
| Fabric data agent (`ask_fabric_*`, MCP-based) | Yes | Mock (no network path exercised even in mock) | **Never** | **Never** | No — `FABRIC_DATA_AGENTS=[]`. 100% code-only |
| Generic HTTP agent (`ask_agent_*` via httpAgent.js) | Yes | **No test file** | Never | Never | No — `HTTP_AGENTS=[]` |
| Generic MCP client (`mcp_<server>_<tool>`) | Yes | Mock, only pure helper functions — no real or fake network round-trip tested | Never | Never | No — `MCP_SERVERS=[]` |
| Bing grounding (`ask_agent_webgrounding`) | Yes | No dedicated real-path test | **Verified** (harness-level) — 200 response, 3 citations, plus full watchlist acceptance | Verified (crawl half) | Yes — `WEB_GROUNDING` populated |

## Actions

| Action | Code exists | Unit test | Live — local | Live — dev |
|---|---|---|---|---|
| sendEmail (Graph `POST /me/sendMail`, confirmation-gated) | Yes — `src/actions/sendEmail.js` | Mock only — the real `/me/sendMail` call is never exercised | **Never** — DEMO.md Beat 10 is a presenter script, not a captured execution. No log/artifact of an actual send anywhere | Never |
| sendTeamsMessage (self-message, no confirmation) | Yes | Mock | Never found | Never |
| runFlow (Power Automate) | Yes | — | Not registered (`FLOWS=[]`, flag off) | Not registered |

Known scope gap: `GRAPH_SCOPES` lists `Mail.Read` but not `Mail.Send`. See the 2026-07-27 amendment below — confirmed `Mail.Send` is not in the SSO app's `requiredResourceAccess` at all, so the send-email test could not have succeeded regardless of consent state.

## Orchestrator / infra

| Capability | Code | Test | Live evidence |
|---|---|---|---|
| Sequential tool-call delegation + `/trace` audit event | Yes | Mock | **Verified** (harness-level) — the Foundry AWA call captured a real delegation audit event end-to-end |
| A2 parallel tool-call fan-out (`ParallelOpenAIChatModel`) | Yes | Mock — against a fake SDK model, never real connectors | **Never exercised live at all**, in either environment, against any real connector |
| `/trace` slash command rendering (vs. the underlying event) | Yes | Unit (pure renderer) | Unconfirmed whether the rendered `/trace` output was ever viewed in an actual Teams turn vs. just the underlying audit event being captured |
| circuit breaker / payload / `userScoped` gate | Yes | Unit | N/A (infra, not user-facing) |

## Bottom line at audit time

Of everything with real config populated, only queryCompanyData (SQL) and Bing grounding/watchlist had solid live evidence — and even that evidence was harness-level, not a human typing in an actual Teams client. Fabric data agent and email send had zero live evidence in either environment. Parallel tool-call fan-out, the generic HTTP agent, and the generic MCP client had never run against anything real, mock or otherwise beyond pure functions.

## Amendments

- **2026-07-27:** Added real unit tests (mocked at the `fetch` boundary, or the SDK-client boundary for `searchDocuments`) for the 7 tools that previously had none: `searchDocuments`, `searchSharePoint`, `searchOneDrive`, `searchEmail`, `getCalendar`, `getPlannerTasks`, `findPeople`. Test suite is now 205/205, still entirely mocked — this closes the *unit-test* gap only, not the *live-proof* gap; none of these have live evidence in either environment as of this date.
- **2026-07-27:** Confirmed via `az ad app show` / `az ad app permission list-grants` on SSO app `4a91eb47-8009-4001-9720-713ef06a9cd2` that `Mail.Send` is **not present** in `requiredResourceAccess` and **not** in the tenant's admin-consent grant — it was never requested, not merely unconsented. This is the root cause of the email-send capability never running live in any environment.
- **2026-07-27:** Added `PARALLEL_TOOL_CALLS_ENABLED` kill switch (default on) around the A2 parallel fan-out path in `src/orchestrator/parallelModel.js`, given it has never run against a real connector.
