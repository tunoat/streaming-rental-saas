ALTER TABLE accounts ADD COLUMN blocked_at timestamptz;
CREATE TABLE incidents (
  store_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), job_id uuid NOT NULL,
  reason text NOT NULL CHECK(reason IN ('ACCOUNT_LOCKED','SUBSCRIPTION_INVALID','RECONCILIATION_REQUIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(store_id,id), UNIQUE(store_id,job_id,reason),
  FOREIGN KEY(store_id,job_id) REFERENCES jobs(store_id,id)
);
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON incidents FOR SELECT USING (authorized_store(store_id));
CREATE POLICY tenant_record ON incidents FOR INSERT WITH CHECK (authorized_store(store_id));
GRANT SELECT,INSERT ON incidents TO stream_app;

CREATE FUNCTION reject_posted_change() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Posted ledger and audit entries are append-only' USING ERRCODE='55000';
END
$$;
CREATE TRIGGER immutable_wallet_ledger BEFORE UPDATE OR DELETE OR TRUNCATE ON wallet_ledger
FOR EACH STATEMENT EXECUTE FUNCTION reject_posted_change();
CREATE TRIGGER immutable_admin_audit BEFORE UPDATE OR DELETE OR TRUNCATE ON admin_audit
FOR EACH STATEMENT EXECUTE FUNCTION reject_posted_change();
CREATE TRIGGER immutable_job_events BEFORE UPDATE OR DELETE OR TRUNCATE ON job_events
FOR EACH STATEMENT EXECUTE FUNCTION reject_posted_change();
