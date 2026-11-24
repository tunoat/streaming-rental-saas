CREATE TABLE streaming_email_addresses (
  store_id uuid NOT NULL REFERENCES stores(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (email=lower(btrim(email))),
  PRIMARY KEY(store_id,id),
  UNIQUE(store_id,email)
);
INSERT INTO streaming_email_addresses(store_id,email)
SELECT DISTINCT store_id,email FROM streaming_emails;
ALTER TABLE streaming_emails ADD FOREIGN KEY(store_id,email)
  REFERENCES streaming_email_addresses(store_id,email) ON UPDATE CASCADE;

ALTER TABLE streaming_email_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE streaming_email_addresses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_select ON streaming_email_addresses FOR SELECT USING (authorized_store(store_id));
CREATE POLICY tenant_insert ON streaming_email_addresses FOR INSERT WITH CHECK (authorized_store(store_id));
CREATE POLICY tenant_update ON streaming_email_addresses FOR UPDATE USING (authorized_store(store_id)) WITH CHECK (authorized_store(store_id));
GRANT SELECT,INSERT,UPDATE ON streaming_email_addresses TO stream_app;
