CREATE TABLE rental_cancellations (
 store_id uuid NOT NULL, rental_id uuid NOT NULL, customer_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id), reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 150),
 requested_at timestamptz NOT NULL, credit_amount numeric(18,2) NOT NULL CHECK(credit_amount>=0),
 completed_at timestamptz CHECK(completed_at>=requested_at),
 PRIMARY KEY(store_id,rental_id),
 FOREIGN KEY(store_id,rental_id) REFERENCES rentals(store_id,id),
 FOREIGN KEY(store_id,customer_id) REFERENCES customers(store_id,id)
);

CREATE TABLE wallet_adjustments (
 store_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), customer_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id), reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 150),
 amount numeric(18,2) NOT NULL CHECK(amount<>0), source text NOT NULL,
 request_key uuid, rental_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(store_id,id), UNIQUE(store_id,request_key), UNIQUE(store_id,rental_id),
 FOREIGN KEY(store_id,customer_id) REFERENCES customers(store_id,id),
 FOREIGN KEY(store_id,rental_id) REFERENCES rental_cancellations(store_id,rental_id),
 CHECK (
   (source='MANUAL_NO_PAYMENT' AND request_key IS NOT NULL AND rental_id IS NULL)
   OR (source='RENTAL_CANCEL_CREDIT' AND request_key IS NULL AND rental_id IS NOT NULL AND amount>0)
 )
);
CREATE INDEX wallet_adjustments_customer ON wallet_adjustments(store_id,customer_id);

DO $$
DECLARE relation text;
BEGIN
 FOREACH relation IN ARRAY ARRAY['rental_cancellations','wallet_adjustments']
 LOOP
   EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
   EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
   EXECUTE format('CREATE POLICY tenant_select ON %I FOR SELECT USING (authorized_store(store_id))',relation);
   EXECUTE format('CREATE POLICY tenant_insert ON %I FOR INSERT WITH CHECK (authorized_store(store_id))',relation);
   EXECUTE format('GRANT SELECT,INSERT ON %I TO stream_app',relation);
 END LOOP;
END $$;
CREATE POLICY tenant_update ON rental_cancellations FOR UPDATE USING (authorized_store(store_id)) WITH CHECK (authorized_store(store_id));
GRANT UPDATE(completed_at) ON rental_cancellations TO stream_app;
CREATE TRIGGER immutable_wallet_adjustments BEFORE UPDATE OR DELETE OR TRUNCATE ON wallet_adjustments
FOR EACH STATEMENT EXECUTE FUNCTION reject_posted_change();

CREATE VIEW wallet_entries WITH (security_invoker=true) AS
SELECT store_id,customer_id,amount FROM wallet_ledger
UNION ALL
SELECT store_id,customer_id,amount FROM wallet_adjustments;
GRANT SELECT ON wallet_entries TO stream_app;
