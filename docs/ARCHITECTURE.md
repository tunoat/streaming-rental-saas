# Local architecture and ADR

Fastify serves same-origin static Thai admin screens and JSON routes. PostgreSQL 16 is the durable transactional store. Node 24 is the Docker runtime and supports native Argon2 and TypeScript stripping for the shared worker SDK. The separate worker has HTTP credentials only. Direct SQL preserves RLS, composite keys and advisory locks.

Control-plane writes serialize on a bootstrap/admin guard. Tenant mutations use a store-scoped transaction lock. Multi-store claims acquire store locks in UUID order. Account, profile, order and rental updates and the associated bot job commit in the same transaction. No external actions run inside transaction retries.

Decisions for the first vertical slice include same-origin vanilla browser modules, local scoped opaque worker tokens, a static plan table in code, derived mock wallet balances and a production startup gate.

