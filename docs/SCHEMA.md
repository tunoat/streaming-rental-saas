# Schema dictionary

- Control plane: users, sessions, admin_guard, stores, memberships, workers, worker_stores and admin_audit.
- Tenant business data: customers, accounts, profiles, payment_requests, transfers, orders, rentals and wallet_ledger.
- Jobs: jobs stores status, lease metadata, fence and sanitized evidence. job_events records lifecycle history. requests stores idempotent response metadata. incidents records account blocks and uncertain outcomes.
- Migrations: V001 establishes local roles and control plane. V002 creates tenant tables, composite keys and policies. V003 requires bearer proof preimages for authorization context. V004 adds incidents and append-only audit and ledger triggers. Migration checksums are recorded in migration_history.

