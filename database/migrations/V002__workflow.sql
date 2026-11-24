CREATE TABLE customers (
 store_id uuid NOT NULL REFERENCES stores(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 name text NOT NULL, PRIMARY KEY(store_id,id)
);
CREATE TABLE accounts (
 store_id uuid NOT NULL REFERENCES stores(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 platform text NOT NULL, email text NOT NULL CHECK(email=lower(btrim(email))),
 health text NOT NULL DEFAULT 'UNKNOWN' CHECK(health IN ('UNKNOWN','HEALTHY','BLOCKED')),
 checked_at timestamptz, subscription_until timestamptz,
 PRIMARY KEY(store_id,id), UNIQUE(platform,email)
);
CREATE TABLE profiles (
 store_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), account_id uuid NOT NULL,
 label text NOT NULL, status text NOT NULL DEFAULT 'AVAILABLE' CHECK(status IN ('AVAILABLE','RESERVED','OCCUPIED','HELD')),
 PRIMARY KEY(store_id,id), FOREIGN KEY(store_id,account_id) REFERENCES accounts(store_id,id)
);
CREATE TABLE payment_requests (
 store_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), customer_id uuid NOT NULL,
 amount numeric(18,2) NOT NULL CHECK(amount>0), status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','CLOSED')),
 PRIMARY KEY(store_id,id), FOREIGN KEY(store_id,customer_id) REFERENCES customers(store_id,id)
);
CREATE TABLE transfers (
 store_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), payment_id uuid NOT NULL,
 amount numeric(18,2) NOT NULL CHECK(amount>0), evidence text NOT NULL,
 approved_at timestamptz, PRIMARY KEY(store_id,id), UNIQUE(store_id,evidence),
 FOREIGN KEY(store_id,payment_id) REFERENCES payment_requests(store_id,id)
);
CREATE TABLE orders (
 store_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), customer_id uuid NOT NULL, profile_id uuid,
 amount numeric(18,2) NOT NULL CHECK(amount>0), days integer NOT NULL CHECK(days BETWEEN 1 AND 365),
 created_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL DEFAULT 'PAID_WAITING' CHECK(status IN ('PAID_WAITING','DELIVERING','FULFILLED')),
 PRIMARY KEY(store_id,id), FOREIGN KEY(store_id,customer_id) REFERENCES customers(store_id,id),
 FOREIGN KEY(store_id,profile_id) REFERENCES profiles(store_id,id)
);
CREATE TABLE rentals (
 store_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), order_id uuid NOT NULL, profile_id uuid NOT NULL,
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL CHECK(ends_at>starts_at),
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','REVOCATION_PENDING','CLOSED')),
 PRIMARY KEY(store_id,id), UNIQUE(store_id,order_id),
 FOREIGN KEY(store_id,order_id) REFERENCES orders(store_id,id),
 FOREIGN KEY(store_id,profile_id) REFERENCES profiles(store_id,id)
);
CREATE UNIQUE INDEX active_rental_profile ON rentals(store_id,profile_id) WHERE status<>'CLOSED';
CREATE TABLE wallet_ledger (
 store_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), customer_id uuid NOT NULL,
 transfer_id uuid, order_id uuid, amount numeric(18,2) NOT NULL,
 PRIMARY KEY(store_id,id), UNIQUE(store_id,transfer_id), UNIQUE(store_id,order_id),
 CHECK((transfer_id IS NOT NULL AND order_id IS NULL AND amount>0) OR (order_id IS NOT NULL AND transfer_id IS NULL AND amount<0)),
 FOREIGN KEY(store_id,customer_id) REFERENCES customers(store_id,id),
 FOREIGN KEY(store_id,transfer_id) REFERENCES transfers(store_id,id),
 FOREIGN KEY(store_id,order_id) REFERENCES orders(store_id,id)
);
CREATE INDEX ledger_customer ON wallet_ledger(store_id,customer_id);
CREATE TABLE jobs (
 store_id uuid NOT NULL REFERENCES stores(id), id uuid NOT NULL DEFAULT gen_random_uuid(),
 type text NOT NULL CHECK(type IN ('VERIFY_LOGIN','VERIFY_SUBSCRIPTION','VERIFY_PROFILE_READINESS','DELIVER_ACCESS','REVOKE_ACCESS','RECONCILE_DELIVERY','RECONCILE_REVOCATION','RECOVERY_VERIFICATION','HEALTH_CHECK')),
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','LEASED','RUNNING','SUCCEEDED','FAILED','RETRY_WAIT','RECONCILING','CANCELLED','DEAD_LETTER')),
 priority integer NOT NULL CHECK(priority BETWEEN 1 AND 4), account_id uuid, profile_id uuid, order_id uuid, rental_id uuid,
 attempt integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
 ready_at timestamptz NOT NULL DEFAULT now(), worker_id text REFERENCES workers(id), fence integer NOT NULL DEFAULT 0,
 lease_until timestamptz, lease_digest text, run_at timestamptz, error_code text, result jsonb, reconciles_id uuid,
 PRIMARY KEY(store_id,id), FOREIGN KEY(store_id,account_id) REFERENCES accounts(store_id,id),
 FOREIGN KEY(store_id,profile_id) REFERENCES profiles(store_id,id),
 FOREIGN KEY(store_id,order_id) REFERENCES orders(store_id,id),
 FOREIGN KEY(store_id,rental_id) REFERENCES rentals(store_id,id),
 FOREIGN KEY(store_id,reconciles_id) REFERENCES jobs(store_id,id)
);
CREATE INDEX claim_jobs ON jobs(store_id,status,ready_at,priority,created_at);
CREATE TABLE job_events (
 store_id uuid NOT NULL, event_id uuid NOT NULL DEFAULT gen_random_uuid(), job_id uuid NOT NULL,
 event_type text NOT NULL, actor text NOT NULL, request_id text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(store_id,event_id), FOREIGN KEY(store_id,job_id) REFERENCES jobs(store_id,id)
);
CREATE TABLE requests (
 store_id uuid NOT NULL REFERENCES stores(id), actor text NOT NULL, route text NOT NULL, key text NOT NULL,
 fingerprint text NOT NULL, status integer NOT NULL, response jsonb,
 PRIMARY KEY(store_id,actor,route,key)
);
DO $$
DECLARE relation text;
BEGIN
 FOREACH relation IN ARRAY ARRAY['customers','accounts','profiles','payment_requests','transfers','orders','rentals','wallet_ledger','jobs','job_events','requests']
 LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY tenant_select ON %I FOR SELECT USING (authorized_store(store_id))',relation);
  EXECUTE format('CREATE POLICY tenant_insert ON %I FOR INSERT WITH CHECK (authorized_store(store_id))',relation);
  EXECUTE format('CREATE POLICY tenant_update ON %I FOR UPDATE USING (authorized_store(store_id)) WITH CHECK (authorized_store(store_id))',relation);
  EXECUTE format('CREATE POLICY tenant_delete ON %I FOR DELETE USING (authorized_store(store_id))',relation);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO stream_app',relation);
 END LOOP;
END $$;
GRANT UPDATE ON customers,accounts,profiles,payment_requests,transfers,orders,rentals,jobs TO stream_app;

