# Netflix Module 02 mock binding

V031 adds binding state and event history keyed by store and existing streaming email ID. The Netflix worker is dedicated to this namespace and uses bearer authentication, the store lock, leases and fencing. Its active leases share the existing four-slot store limit. The Gmail adapter and existing inventory creation remain separate. A mock BOUND result verifies only the simulated binding and does not provision streaming inventory.

After applying V031, use a fresh worker ID, set a random 32-byte base64url worker token and specify the store UUID. Run `npm.cmd run netflix-worker:register -- <workerId> <storeId>` from a migration-enabled shell. Set `NETFLIX_WORKER_STORE_ID`, `BOT_API_URL`, `BOT_WORKER_ID`, and `BOT_WORKER_TOKEN` for the worker process and run `npm.cmd run netflix-worker`. Docker provides the `netflix-test` profile. Registry entries with expired Gmail access require an explicit Gmail verification or reconnect before starting.

The mock binding API supports automatic and manual tests. Automatic mode uses a synthetic worker result. Manual mode waits for the synthetic code `123456` and requires a second worker result before it reaches BOUND. No code or code digest is written to the request cache or audit. Cancel and disconnect invalidate the current lease. Expired worker leases move to RECONCILING, where the Owner can explicitly close the interrupted mock operation before retrying.

## HTTP surface

Owner prefix `/v1/stores/{storeId}/email-addresses/{emailId}/streaming-binding` supports GET status and POST actions `bind`, `verify`, `rebind`, `manual`, `cancel`, `reconcile`, and `disconnect`. Use an `Idempotency-Key` for POST. Bind or rebind accepts an optional `challenge` of AUTO or MANUAL. Manual takes the current `generation` and synthetic `code`. Cancel, reconcile and disconnect take `confirm:true`.

Worker prefix `/v1/netflix-worker/stores/{storeId}` supports POST `claim`, `{emailId}/heartbeat`, and `{emailId}/report`. Requests include `worker_id`. Heartbeat and report include `generation`, `fence`, and `lease_token`. Reports require `provenance: MOCK`. The simulated challenge advances through OTP_REQUESTED and WAITING_FOR_EMAIL. Automatic mode records EMAIL_RECEIVED before VERIFIED. Manual mode reports WAITING_FOR_USER and only accepts a final VERIFIED result after Owner submission. See the [OpenAPI contract](../contracts/openapi.netflix-binding.v1.yaml).

## Owner-assisted sign-in

Set `NETFLIX_LOCAL_CHROME_ENABLED=yes` on the loopback Windows API to enable Chrome launching. The buttons open Netflix or Gmail in the same Chrome user-data directory scoped to the store and email registry entry. Sign in manually in that window. Chrome retains its own session until sign-out or site expiry. The app does not collect or copy browser cookies or saved passwords. The regular official sign-in link remains available.

In Streaming accounts, select the email and click Bind. This opens the matching Chrome profile and starts a three-minute Gmail watch. While the panel remains open, the app checks at most once per ten seconds. It inspects the Inbox, the From field and the receipt timestamp for at most three messages per check. A candidate match opens Gmail in the same Chrome profile. The Owner enters the code on Netflix and records whether the primary profile opened from the same panel. A successful Owner confirmation creates or reuses the corresponding inventory account.
