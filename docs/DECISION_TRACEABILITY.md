# Decision traceability

Ranges reflect the grouped decisions in Part C. Partial indicates that the implementation or verification covers selected requirements. Progress for individual omitted behaviors is recorded in KNOWN_GAPS.

| Decision | Status | Implementation | Evidence |
|---|---|---|---|
| DB-01–DB-07 | Partial | apps/api/{admin,db}.mjs | HTTP integration and browser bootstrap |
| DB-08–DB-16 | Not implemented | — | — |
| DB-17–DB-24 | Partial | database/migrations/V001__foundation.sql | HTTP integration |
| DB-25–DB-30 | Partial | apps/api/admin.mjs | Owner provisioning in mobile browser |
| DB-31 | Deferred | — | — |
| DB-32–DB-48 | Not implemented | — | — |
| DB-49–DB-63 | Partial | apps/api/workflow.mjs | Subscription check and eligible allocation |
| DB-64–DB-68 | Partial | apps/api/{jobs,workflow}.mjs | HTTP revocation reconciliation |
| DB-69–DB-79 | Partial | apps/api/{jobs,workflow}.mjs | Lease, allocation and rental tests |
| DB-80–DB-84 | Partial | apps/api/workflow.mjs | Mock credit only |
| DB-85–DB-86 | Not implemented | — | — |
| DB-87 | Partial | database/migrations/V002__workflow.sql; V003__tenant_context_proof.sql | Restricted role context test |
| DB-88 | Partial | database/migrations/V002__workflow.sql | Restricted runtime cannot update ledger |
| DB-89–DB-94 | Partial | apps/api/db.mjs; database/migrate.mjs | Concurrency; fresh and repeated migrations |
| DB-95 | Partial | scripts/backup-drill.mjs | Local restore; PITR pending |
| DB-96 | Partial | database/migrations/V001__foundation.sql; V002__workflow.sql | Job trail |
| DB-97 | Partial | apps/api/jobs.mjs | Durable jobs and lease tests |
| DB-98 | Not implemented | — | — |
| DB-99–DB-100 | Partial | database/migrations; docs/ERD.md | Restricted-role checks and schema migration |
