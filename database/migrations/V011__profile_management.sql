ALTER TABLE profiles ADD COLUMN pin_hash text, ADD COLUMN archived_at timestamptz;
ALTER TABLE profiles ADD CHECK (archived_at IS NULL OR status='AVAILABLE');
