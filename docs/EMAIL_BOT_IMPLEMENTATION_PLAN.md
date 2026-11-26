# Gmail Bot Module 01

## Repository audit

The starting main commit was `85bce4dea39913c73777287f1dc703c769542d70`. The checkout also contained local changes through V029, including the platform-neutral email registry, its archived rows and the Thai email details screen. Those changes are preserved separately in baseline commit `4fc4fdcca0a5a382ef4c527e195b8e601cd09123`. The baseline PostgreSQL suite passed 23 of 23. Gmail work uses branch `feature/gmail-bot-module-01`.

- Fastify routes use `secured`, PostgreSQL transactions, bearer audiences and store-level advisory locks. V003 ties RLS context to a valid session or worker token. The Gmail module reuses those primitives.
- V012 originally modeled platform-specific emails. V014 introduced `streaming_email_addresses` and V015 added a legacy mock password. V026 added archive and encrypted mock-password fields. Gmail uses the registry's composite key. The mock password remains unrelated to Google authorization.
- Both Bot Control V1 contracts are unchanged. Adding a Gmail job to that job enum would change existing workers' claim and response assumptions. Email Bot V1 therefore uses an independent namespace and a worker-mode registration. Both queues coordinate under the same store lock and share the four-live-lease limit.
- V030 adds connection state, a tenant-bound encrypted vault, single-use authorization state, an isolated job queue and worker capability registration. Registry email changes and archival invalidate the connection. Existing migrations are preserved.

## Implemented differences from the prompt

- The first module uses explicit verification only. It has no scheduled health checks and does not read message bodies. Empty inbox evidence is valid, as is metadata access for one message. Even metadata responses request only the ID.
- Google token endpoints and JWKS are fixed. Live runs require a loopback bind and redirect, explicit development/test mode and an encryption key. Provider-issued access token lifetime is reported as issued by Google. A lease controls when the broker can release the token, not Google's remaining token lifetime after issuance.
- Owner consent uses a separate tab, five-minute PKCE state, a state-specific HttpOnly cookie and the current Owner session. Live callback validates exact origin at authorization and returns only a fixed local result status.
- Worker capability registration belongs to mock or live mode. A mock result cannot advance a live connection. Live Google smoke verification passed for Inbox listing and one metadata read after tester consent.
- Remote revocation is best effort after committing local disconnect. The server skips remote revoke when another local credential uses the same Google subject. The service has no visibility into grants held by other applications.

## Rollback

Keep the additive schema while rolling back application code and stopping the Gmail worker. For live test decommissioning, disconnect while the feature is enabled so local credentials are erased and Google revocation can be attempted. Revoke the Google grant separately if remote revocation is unconfirmed. Before any destructive schema removal, take an appropriately access-controlled backup and review retention. V030 can remain installed even if the previous app is restored.

## Verification checkpoint

| Check | Result |
|---|---|
| Baseline PostgreSQL suite | PASS, 23 checks before editing |
| Migration | PASS, V030 over the existing baseline and V001–V030 on a disposable PostgreSQL 16 database |
| Lint and TypeScript build | PASS |
| OpenAPI and generation | PASS, generated Gmail types and validated all three contracts. Redocly emitted 15 warnings, including the Gmail callback's intentionally redirect-only response. |
| PostgreSQL, provider doubles and security regression tests | PASS, 31 checks |
| Edge mobile walkthrough with isolated PostgreSQL | PASS, 1 walkthrough including mock consent, worker evidence and disconnect. Fixed stale legacy selectors encountered on earlier attempts. |
| Actual Google smoke | PASS, backend accepted LIVE profile match, Inbox listing and metadata read on 2026-11-26 |
| Marked test-message body access and independent penetration testing | NOT RUN |

No dependency addition was needed. The existing running web and streaming worker processes were not restarted for this feature. No push or deployment was performed.

See [Google OAuth web server applications](https://developers.google.com/identity/protocols/oauth2/web-server) and [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect).
