# Security checkpoints

Development runtime checks separate admin and worker audiences. Argon2id protects passwords. Database RLS requires authenticated proof and scoped membership, and browser output uses text nodes. Bot lease tokens are derived for idempotent claim replays and excluded from the database response record. Local Compose ports bind to loopback.

Only disposable data belongs in this demo. Database least-privilege separation and production provisioning are open. See KNOWN_GAPS for release blockers.

