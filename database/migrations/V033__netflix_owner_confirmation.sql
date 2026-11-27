CREATE TABLE netflix_owner_confirmation (
 store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
 email_id uuid NOT NULL,
 entered boolean NOT NULL,
 confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(store_id,email_id),
 FOREIGN KEY(store_id,email_id) REFERENCES streaming_email_addresses(store_id,id) ON DELETE CASCADE
);
ALTER TABLE netflix_owner_confirmation ENABLE ROW LEVEL SECURITY;
ALTER TABLE netflix_owner_confirmation FORCE ROW LEVEL SECURITY;
CREATE POLICY netflix_owner_confirmation_tenant ON netflix_owner_confirmation
  USING (authorized_store(store_id)) WITH CHECK (authorized_store(store_id));
GRANT SELECT,INSERT,UPDATE ON netflix_owner_confirmation TO stream_app;
GRANT DELETE ON netflix_owner_confirmation TO stream_app;

CREATE FUNCTION public.clear_netflix_owner_confirmation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.email IS DISTINCT FROM OLD.email OR NEW.archived_at IS NOT NULL THEN
   DELETE FROM public.netflix_owner_confirmation WHERE (store_id,email_id)=(NEW.store_id,NEW.id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER clear_netflix_owner_confirmation AFTER UPDATE OF email,archived_at ON streaming_email_addresses
FOR EACH ROW EXECUTE FUNCTION public.clear_netflix_owner_confirmation();
