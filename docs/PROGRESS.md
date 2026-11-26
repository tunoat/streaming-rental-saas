# Phase 1 checkpoint

Gmail Bot Module 01 adds Owner-only Gmail consent and bounded inbox verification in a separate worker namespace. Resume with [implementation findings](EMAIL_BOT_IMPLEMENTATION_PLAN.md), [Thai setup](EMAIL_BOT_SETUP.md) and the [English integration guide](EMAIL_BOT_INTEGRATION_GUIDE_EN.md). On 2026-11-26 at 16:33 Asia/Bangkok, live smoke verification passed after Owner consent. The backend accepted LIVE evidence for identity match, Inbox listing and one metadata read.

| Milestone | State | Evidence |
|---|---|---|
| 0 | Done | Workspace inspected. Optional database archive absent. Part E and Part F exported. |
| 1 | Working local baseline | PostgreSQL 16, repeated migrations and seeds, Compose readiness, local backup/restore and CI configuration. PITR and CI execution remain open. |
| 2 | Partial | Tenant RLS and composite keys, scoped jobs, ledger slice. See KNOWN_GAPS. |
| 3 | Partial | Admin auth, storefront provisioning, mock credit/order/delivery and 11 bot routes implemented. Remaining domain workflows listed in KNOWN_GAPS. |
| 4 | Partial | Thai admin workspace, checklist and core demo forms. See UX_ACCEPTANCE. |
| 5 | Partial | See TEST_REPORT for executed evidence and uncovered release gates. |
| 6 | Partial | Local setup and cross-team review instructions in README and BOT_API. |

Resume from KNOWN_GAPS.md. Start with the money or membership acceptance rules and add real PostgreSQL tests while extending the migrations. Use a disposable database. Existing test container `streaming-phase1-postgres` uses host port 55432, `streaming-phase1-browser-db` uses 55433, and Compose test project `streaming-phase1-check` used PostgreSQL 55434 and HTTP 3030. These checkpoints are files because the starting workspace had no Git metadata.

