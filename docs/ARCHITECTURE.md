# Local architecture and ADR

Fastify serves same-origin static Thai admin screens and JSON routes. PostgreSQL 16 is the durable transactional store. Node 24 is the Docker runtime and supports native Argon2 and TypeScript stripping for the shared worker SDK. The separate worker has HTTP credentials only. Direct SQL preserves RLS, composite keys and advisory locks.

Control-plane writes serialize on a bootstrap/admin guard. Tenant mutations use a store-scoped transaction lock. Multi-store claims acquire store locks in UUID order. Account, profile, order and rental updates and the associated bot job commit in the same transaction. No external actions run inside transaction retries.

The Bangkok calendar month report adds the latest broker fee and streaming subscription for each bound account, once per month. A change replaces the account's contribution to the current monthly estimate. An older rate entered as a single amount appears under the streaming subscription component. Monthly gross sales count booked purchase and renewal orders. The fixed-cost estimate is separate from sales and from allocated order costs.

When the worker confirms mock delivery, the backend records the account's current cost rate and the number of non-archived profiles. Renewals and compensation use the same snapshot rule when confirmed. Order cost is the frozen monthly rate times package days, divided by the frozen profile count and 30 days. Order profit is the booked price less that cost. Daily reporting groups by the order's Bangkok purchase date and includes profit once delivery and cost data are available. Compensation carries no charged sale amount and can contribute an allocated cost. Orders without known costs remain pending in the profit breakdown. Reports round for display after aggregation.

Decisions for the first vertical slice include same-origin vanilla browser modules, local scoped opaque worker tokens, a static plan table in code, derived mock wallet balances and a production startup gate.

