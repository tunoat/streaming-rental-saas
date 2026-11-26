ALTER TABLE streaming_email_addresses ADD COLUMN encrypted_password text,
  ADD COLUMN archived_at timestamptz;
