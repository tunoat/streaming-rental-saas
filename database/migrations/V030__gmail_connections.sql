CREATE TABLE gmail_workers (
 worker_id text PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE,
 mode text NOT NULL CHECK(mode IN ('mock','live'))
);
GRANT SELECT ON gmail_workers TO stream_app;

CREATE TABLE gmail_connections (
 store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
 email_id uuid NOT NULL,
 generation integer NOT NULL DEFAULT 0,
 mode text NOT NULL CHECK(mode IN ('mock','live')),
 status text NOT NULL CHECK(status IN ('VERIFYING','CONNECTED','AUTH_REQUIRED','FAILED','DISCONNECTED')),
 subject text, email text, scopes text[], verified_at timestamptz,
 evidence jsonb, error text,
 PRIMARY KEY(store_id,email_id),
 FOREIGN KEY(store_id,email_id) REFERENCES streaming_email_addresses(store_id,id) ON DELETE CASCADE
);
CREATE TABLE gmail_vault (
 store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
 email_id uuid NOT NULL,
 encrypted_tokens text NOT NULL,
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(store_id,email_id),
 FOREIGN KEY(store_id,email_id) REFERENCES gmail_connections(store_id,email_id) ON DELETE CASCADE
);
CREATE TABLE gmail_oauth_states (
 store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
 email_id uuid NOT NULL, state_digest text NOT NULL,
 request_key text NOT NULL, session_digest text NOT NULL, generation integer NOT NULL,
 sealed_state text NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz,
 PRIMARY KEY(store_id,state_digest),
 UNIQUE(store_id,email_id,session_digest,request_key),
 FOREIGN KEY(store_id,email_id) REFERENCES streaming_email_addresses(store_id,id) ON DELETE CASCADE
);
CREATE TABLE gmail_jobs (
 store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
 id uuid NOT NULL DEFAULT gen_random_uuid(), email_id uuid NOT NULL, generation integer NOT NULL,
 mode text NOT NULL CHECK(mode IN ('mock','live')),
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','LEASED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
 worker_id text REFERENCES gmail_workers(worker_id), fence integer NOT NULL DEFAULT 0,
 attempts integer NOT NULL DEFAULT 0, token_count integer NOT NULL DEFAULT 0,
 lease_until timestamptz, started_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(store_id,id),
 FOREIGN KEY(store_id,email_id) REFERENCES gmail_connections(store_id,email_id) ON DELETE CASCADE
);
CREATE INDEX gmail_jobs_claim ON gmail_jobs(store_id,mode,status,created_at);
CREATE UNIQUE INDEX gmail_active_job ON gmail_jobs(store_id,email_id,generation)
 WHERE status IN ('QUEUED','LEASED','RUNNING');

DO $$
DECLARE relation text;
BEGIN
 FOREACH relation IN ARRAY ARRAY['gmail_connections','gmail_vault','gmail_oauth_states','gmail_jobs'] LOOP
   EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
   EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
   EXECUTE format('CREATE POLICY gmail_tenant ON %I USING (authorized_store(store_id)) WITH CHECK (authorized_store(store_id))',relation);
   EXECUTE format('GRANT SELECT,INSERT,UPDATE ON %I TO stream_app',relation);
 END LOOP;
END $$;
GRANT DELETE ON gmail_vault,gmail_oauth_states TO stream_app;

CREATE FUNCTION public.invalidate_gmail_on_registry_change() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.archived_at IS NOT NULL OR NEW.email IS DISTINCT FROM OLD.email THEN
   UPDATE public.gmail_connections SET generation=generation+1,status='DISCONNECTED',subject=NULL,
     email=NULL,scopes=NULL,verified_at=NULL,evidence=NULL,error=NULL
     WHERE (store_id,email_id)=(NEW.store_id,NEW.id);
   DELETE FROM public.gmail_vault WHERE (store_id,email_id)=(NEW.store_id,NEW.id);
   DELETE FROM public.gmail_oauth_states WHERE (store_id,email_id)=(NEW.store_id,NEW.id);
   UPDATE public.gmail_jobs SET status='CANCELLED',lease_until=NULL
     WHERE (store_id,email_id)=(NEW.store_id,NEW.id) AND status IN ('QUEUED','LEASED','RUNNING');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER invalidate_gmail_on_registry_change AFTER UPDATE OF email,archived_at ON streaming_email_addresses
FOR EACH ROW EXECUTE FUNCTION public.invalidate_gmail_on_registry_change();

CREATE FUNCTION public.gmail_has_shared_grant(target text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS (
   SELECT 1 FROM public.gmail_connections c JOIN public.gmail_vault v USING (store_id,email_id)
   WHERE c.mode='live' AND c.subject=target
 );
$$;
REVOKE ALL ON FUNCTION public.gmail_has_shared_grant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.gmail_has_shared_grant(text) TO stream_app;
