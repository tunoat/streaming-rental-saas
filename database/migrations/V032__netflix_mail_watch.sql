CREATE TABLE netflix_mail_watch (
 store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
 email_id uuid NOT NULL,
 gmail_generation integer NOT NULL,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 checked_at timestamptz,
 found_at timestamptz,
 PRIMARY KEY(store_id,email_id),
 FOREIGN KEY(store_id,email_id) REFERENCES streaming_email_addresses(store_id,id) ON DELETE CASCADE
);
ALTER TABLE netflix_mail_watch ENABLE ROW LEVEL SECURITY;
ALTER TABLE netflix_mail_watch FORCE ROW LEVEL SECURITY;
CREATE POLICY netflix_mail_watch_tenant ON netflix_mail_watch USING (authorized_store(store_id)) WITH CHECK (authorized_store(store_id));
GRANT SELECT,INSERT,UPDATE ON netflix_mail_watch TO stream_app;
