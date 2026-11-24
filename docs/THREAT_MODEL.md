# Threat model

Browser sessions, worker credentials, application SQL connections and the migration connection are distinct trust boundaries. Tenant selectors are untrusted. The API checks role and bearer audience, then PostgreSQL checks membership/scoped worker access using transaction-local proof. The mock worker reports evidence but the workflow transitions remain under backend control.

Open areas include scoped database roles, network TLS and worker key rotation, production financial data handling, denial-of-service protection, recoverability, credentials at rest and production identity provisioning. See KNOWN_GAPS.

