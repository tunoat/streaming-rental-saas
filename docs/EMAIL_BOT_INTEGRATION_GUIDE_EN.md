# Email Bot V1 integration

The [OpenAPI contract](../contracts/openapi.email-bot.v1.yaml) is also served at `/openapi.email-bot.v1.yaml`. The [generated types](../packages/shared/gmail-contract.d.ts) and [shared client](../packages/shared/gmail-worker-client.mts) support the standalone worker. Bot Control V1 keeps its existing job types and endpoints. The Gmail namespace has a separate capability and shares the per-store active-job budget.

| Audience | Endpoint suffix | Result |
|---|---|---|
| Owner | `POST /v1/stores/{storeId}/email-addresses/{emailId}/connections/gmail/authorize` | Authorization URL and expiry plus an HttpOnly state-binding cookie |
| Browser | `GET /v1/oauth/google/callback` | Fixed local result-page redirect |
| Owner | `GET /v1/stores/{storeId}/email-addresses/{emailId}/connection` | Sanitized connection, mode and evidence |
| Owner | `POST .../connection/verify` | Job UUID |
| Owner | `POST .../connection/disconnect` | Local state and remote revocation outcome |
| Worker | `POST /v1/email-worker/stores/{storeId}/jobs/claim` | One job or HTTP 204 |
| Worker | `POST .../jobs/{jobId}/{start,heartbeat,complete,fail}` | Transition result |
| Worker | `POST .../jobs/{jobId}/access-token` | Live provider access token, expiry and expected email |

Use the correct bearer audience and an `Idempotency-Key` on mutating routes other than callback and access-token. Claim takes `{"worker_id":"gmail-mock-local"}`. Start and heartbeat take `worker_id`, `lease_token` and `fencing_token`. Complete also takes the job's `generation`, `observed_at`, `provenance`, `identity_match`, `profile_ok`, `list_ok`, `empty_inbox` and `metadata_read`. Empty inbox requires `metadata_read=false`. Fail takes a contract-defined error and generation instead. The broker allows at most two token requests per running lease. The second can request `refresh:true` after one HTTP 401.

`NOT_CONNECTED` → `AUTHORIZING` → `VERIFYING` → `CONNECTED` is the successful path. `AUTH_REQUIRED` needs reconnect; `FAILED` can be retried when a credential is still available. Disconnect uses `{"confirm":true}` and invalidates the generation immediately. Stale fences, stale generations and expired leases must be abandoned. `EMAIL_WORKER_FORBIDDEN` indicates a wrong worker capability, store or mode. `TOKEN_RATE_LIMIT` indicates that the lease's broker limit was reached.

A worker uses a dedicated token registered by the database operator. It needs only `BOT_API_URL`, `BOT_WORKER_ID`, `BOT_WORKER_TOKEN`, `GMAIL_WORKER_STORE_ID` and the matching `GMAIL_ADAPTER`. In live test mode also set `GMAIL_LIVE_TEST_ENABLED=true`. Run `npm.cmd run gmail-worker`. Heartbeat every 15 seconds during work and discard all provider responses after producing the result. Never print access tokens, message IDs or content. The worker only uses the fixed profile, Inbox list and metadata endpoints. [Gmail messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)

OAuth sessions expire after five minutes and are pruned on a new authorization attempt. Disconnect and registry invalidation erase local credentials and state. Verification evidence has no message IDs or content. Verification job history and normal idempotency records follow the existing database and backup retention of the demo installation. Backups containing ciphertext remain sensitive. For a key change in this module, disconnect existing test grants first, replace the key and version, restart the API, then reconnect. Lost keys require reconnect and provider-side revocation if needed. The module does not support online multi-key rotation.
