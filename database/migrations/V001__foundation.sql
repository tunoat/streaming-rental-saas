CREATE ROLE stream_app LOGIN PASSWORD 'local_runtime_only' NOSUPERUSER NOBYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL CHECK (email=lower(btrim(email))),
  password_hash text NOT NULL,
  is_super boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  failed integer NOT NULL DEFAULT 0,
  failed_since timestamptz,
  locked_until timestamptz
);
CREATE TABLE admin_guard (id boolean PRIMARY KEY CHECK(id));
INSERT INTO admin_guard VALUES(true);
CREATE TABLE sessions (
  digest text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL
);
CREATE TABLE stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  plan text NOT NULL DEFAULT 'STARTER' CHECK(plan IN ('STARTER','PRO','BUSINESS')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','SUSPENDED','CLOSED')),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days'
);
CREATE TABLE memberships (
  store_id uuid NOT NULL REFERENCES stores(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK(role IN ('OWNER','HEAD_STAFF','STAFF')),
  PRIMARY KEY(store_id,user_id)
);
CREATE UNIQUE INDEX single_owner ON memberships(store_id) WHERE role='OWNER';
CREATE TABLE workers (
  id text PRIMARY KEY,
  token_digest text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE worker_stores (
  worker_id text REFERENCES workers(id),
  store_id uuid REFERENCES stores(id),
  PRIMARY KEY(worker_id,store_id)
);
CREATE TABLE admin_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL,
  subject_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT,INSERT,UPDATE ON users TO stream_app;
GRANT SELECT,UPDATE ON admin_guard TO stream_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON sessions TO stream_app;
GRANT SELECT,INSERT ON stores,memberships TO stream_app;
GRANT SELECT ON workers,worker_stores TO stream_app;
GRANT INSERT,SELECT ON admin_audit TO stream_app;

CREATE FUNCTION authorized_store(candidate uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT candidate::text = current_setting('app.store',true)
  AND (
    EXISTS (
      SELECT 1 FROM public.sessions s
      JOIN public.users u ON u.id=s.user_id AND u.active
      JOIN public.memberships m ON m.user_id=u.id AND m.store_id=candidate
      WHERE s.digest=current_setting('app.auth',true) AND s.expires_at>now()
    )
    OR EXISTS (
      SELECT 1 FROM public.workers w JOIN public.worker_stores ws ON ws.worker_id=w.id
      WHERE w.token_digest=current_setting('app.auth',true) AND w.expires_at>now() AND ws.store_id=candidate
    )
  )
$$;

