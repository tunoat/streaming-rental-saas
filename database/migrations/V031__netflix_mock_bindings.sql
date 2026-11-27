CREATE TABLE netflix_workers (
 worker_id text PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE
);
GRANT SELECT ON netflix_workers TO stream_app;

CREATE TABLE netflix_bindings (
 store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
 email_id uuid NOT NULL,
 generation integer NOT NULL DEFAULT 1,
 status text NOT NULL CHECK(status IN ('QUEUED','BINDING','WAITING_FOR_USER','VERIFYING','BOUND','FAILED','CANCELLED','AUTH_EXPIRED','RECONCILING','UNBOUND')),
 verification_state text,
 challenge text NOT NULL CHECK(challenge IN ('AUTO','MANUAL')),
 worker_id text REFERENCES netflix_workers(worker_id),
 fence integer NOT NULL DEFAULT 0,
 lease_until timestamptz,
 challenge_until timestamptz,
 verified_at timestamptz, last_error text,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(store_id,email_id),
 FOREIGN KEY(store_id,email_id) REFERENCES streaming_email_addresses(store_id,id) ON DELETE CASCADE
);
CREATE TABLE netflix_binding_events (
 store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 email_id uuid NOT NULL,generation integer NOT NULL, status text NOT NULL,actor text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(store_id,id),
 FOREIGN KEY(store_id,email_id) REFERENCES netflix_bindings(store_id,email_id) ON DELETE CASCADE
);
ALTER TABLE netflix_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE netflix_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE netflix_binding_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE netflix_binding_events FORCE ROW LEVEL SECURITY;
CREATE POLICY netflix_bindings_tenant ON netflix_bindings USING (authorized_store(store_id)) WITH CHECK (authorized_store(store_id));
CREATE POLICY netflix_events_tenant ON netflix_binding_events USING (authorized_store(store_id)) WITH CHECK (authorized_store(store_id));
GRANT SELECT,INSERT,UPDATE ON netflix_bindings TO stream_app;
GRANT SELECT,INSERT ON netflix_binding_events TO stream_app;
