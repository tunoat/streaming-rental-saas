CREATE TABLE streaming_emails (
  store_id uuid NOT NULL REFERENCES stores(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  platform text NOT NULL CHECK (platform=lower(btrim(platform)) AND platform<>''),
  email text NOT NULL CHECK (email=lower(btrim(email))),
  password_hash text,
  PRIMARY KEY(store_id,id),
  UNIQUE(store_id,platform,email)
);
INSERT INTO streaming_emails(store_id,platform,email)
SELECT store_id,platform,email FROM accounts;
ALTER TABLE accounts ADD FOREIGN KEY(store_id,platform,email) REFERENCES streaming_emails(store_id,platform,email);

ALTER TABLE streaming_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE streaming_emails FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_select ON streaming_emails FOR SELECT USING (authorized_store(store_id));
CREATE POLICY tenant_insert ON streaming_emails FOR INSERT WITH CHECK (authorized_store(store_id));
CREATE POLICY tenant_update ON streaming_emails FOR UPDATE USING (authorized_store(store_id)) WITH CHECK (authorized_store(store_id));
GRANT SELECT,INSERT,UPDATE ON streaming_emails TO stream_app;
