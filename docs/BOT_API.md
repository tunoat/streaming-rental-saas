# Bot API handoff

The [English integration guide](BOT_API_INTEGRATION_GUIDE_EN.md) is the original Part E proposal. The [canonical OpenAPI](../contracts/openapi.bot-control.v1.yaml) is the exact Part F export. The [proposed header revision](../contracts/openapi.bot-control.v1.headers-proposed.yaml) documents the request headers already required by Part E and the demo runtime. It fills omitted worker path parameters and describes error bodies. Cross-team review is pending. Runtime serves the canonical YAML at `/openapi.bot-control.v1.yaml`.

Use the generated schema types in `packages/shared/bot-contract.d.ts` and `WorkerClient` in `packages/shared/worker-client.mts`. The PostgreSQL-backed API serves as the local mock server. Use `npm run worker` to call the API through HTTP with the separate worker. Never supply database credentials to the worker.

```http
POST /v1/worker/jobs/claim
Authorization: Bearer <scoped-local-worker-token>
Content-Type: application/json
Idempotency-Key: c1d7efe2-1b17-4a97-83c1-20cd08f5733a
X-Request-ID: local-claim-01

{"worker_id":"mock-local","capabilities":["VERIFY_SUBSCRIPTION"],"max_jobs":1}
```

Pass the returned lease and fence to start, heartbeat and complete/fail. Reuse the original mutation key when retrying an identical payload after a transport error. A fresh polling attempt uses a fresh key. The local demo uses scoped opaque credentials expiring after 24 hours. Delivery and revocation jobs are created by the store's workflow, which supplies validated target references and reservation state.

## Correlating work with orders and accounts

Poll the claim endpoint with supported capabilities. Use the returned `job.type` to choose the handler. For `VERIFY_SUBSCRIPTION`, the target is `job.account_id`, and an order ID is optional. For `DELIVER_ACCESS`, allocation puts the existing order, account and profile IDs into `job.order_id`, `job.account_id` and `job.profile_id`. The worker does not search the dashboard or create its own IDs.

Report to `/v1/worker/jobs/{job.id}/complete` or `/v1/worker/jobs/{job.id}/fail` using the same worker ID, lease token and fencing token. The backend validates the result and applies it to the stored target references. The Phase 1 execution context identifies the mock adapter and does not include provider credentials.

## Integration checklist

- [x] Export original contract and generate schema types.
- [x] Implement 11 paths and mock HTTP executor.
- [x] Run two-store isolation, concurrent lease, stale result and idempotency checks in PostgreSQL.
- [ ] Review the proposed header/path revision with both teams.
- [ ] Agree on OAuth2/mTLS, token rotation, incident reconciliation and retry policy before staging.
- [ ] Run independent consumer tests before treating the contract as approved.

