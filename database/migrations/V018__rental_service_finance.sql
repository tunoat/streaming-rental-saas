CREATE TABLE streaming_account_cost_rates (
  store_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), account_id uuid NOT NULL,
  amount numeric(18,2) NOT NULL CHECK(amount>=0),
  cycle_days integer NOT NULL CHECK(cycle_days BETWEEN 1 AND 366),
  effective_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_id uuid NOT NULL REFERENCES users(id),
  PRIMARY KEY(store_id,id), UNIQUE(store_id,account_id,id),
  FOREIGN KEY(store_id,account_id) REFERENCES accounts(store_id,id)
);
CREATE INDEX current_streaming_cost ON streaming_account_cost_rates(store_id,account_id,effective_at DESC,id DESC);
CREATE TABLE rental_service_periods (
  store_id uuid NOT NULL, order_id uuid NOT NULL, rental_id uuid NOT NULL, account_id uuid NOT NULL,
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL CHECK(ends_at>starts_at),
  cost_rate_id uuid, profile_count integer,
  PRIMARY KEY(store_id,order_id),
  FOREIGN KEY(store_id,order_id) REFERENCES orders(store_id,id),
  FOREIGN KEY(store_id,rental_id) REFERENCES rentals(store_id,id),
  FOREIGN KEY(store_id,account_id) REFERENCES accounts(store_id,id),
  FOREIGN KEY(store_id,account_id,cost_rate_id) REFERENCES streaming_account_cost_rates(store_id,account_id,id),
  CHECK ((cost_rate_id IS NULL AND profile_count IS NULL) OR (cost_rate_id IS NOT NULL AND profile_count IS NOT NULL AND profile_count>0))
);

WITH history AS (
  SELECT r.store_id,r.id AS rental_id,r.starts_at,p.account_id,o.id AS order_id,o.days,
    COALESCE(sum(o.days) OVER (PARTITION BY r.store_id,r.id
      ORDER BY (o.id=r.order_id) DESC,o.created_at,o.id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS preceding_days
  FROM rentals r JOIN profiles p ON (p.store_id,p.id)=(r.store_id,r.profile_id)
  JOIN orders o ON o.store_id=r.store_id AND (o.id=r.order_id OR o.rental_id=r.id)
)
INSERT INTO rental_service_periods(store_id,order_id,rental_id,account_id,starts_at,ends_at)
SELECT store_id,order_id,rental_id,account_id,starts_at+preceding_days*interval '24 hours',
  starts_at+(preceding_days+days)*interval '24 hours' FROM history;

DO $$
DECLARE relation text;
BEGIN
 FOREACH relation IN ARRAY ARRAY['streaming_account_cost_rates','rental_service_periods']
 LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY tenant_select ON %I FOR SELECT USING (authorized_store(store_id))',relation);
  EXECUTE format('CREATE POLICY tenant_insert ON %I FOR INSERT WITH CHECK (authorized_store(store_id))',relation);
  EXECUTE format('GRANT SELECT,INSERT ON %I TO stream_app',relation);
 END LOOP;
END $$;

CREATE FUNCTION public.store_service_finance(target_store uuid)
RETURNS TABLE(income numeric,cost numeric,unpriced_periods bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT COALESCE(sum(o.amount * elapsed.seconds / extract(epoch FROM p.ends_at-p.starts_at)),0),
   COALESCE(sum(c.amount * elapsed.seconds / (c.cycle_days::numeric*86400*p.profile_count)),0),
   count(*) FILTER (WHERE p.cost_rate_id IS NULL AND elapsed.seconds>0)
 FROM public.rental_service_periods p
 JOIN public.orders o ON (o.store_id,o.id)=(p.store_id,p.order_id)
 LEFT JOIN public.streaming_account_cost_rates c ON (c.store_id,c.id)=(p.store_id,p.cost_rate_id)
 CROSS JOIN LATERAL (SELECT greatest(0,extract(epoch FROM least(now(),p.ends_at)-p.starts_at)) AS seconds) elapsed
 WHERE p.store_id=target_store;
$$;
REVOKE ALL ON FUNCTION public.store_service_finance(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.store_service_finance(uuid) TO stream_app;

CREATE FUNCTION public.admin_service_finance(target_owner uuid,target_store uuid,bearer text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE report jsonb;
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM public.sessions s JOIN public.users u ON u.id=s.user_id
   WHERE s.digest=encode(sha256(convert_to(bearer,'UTF8')),'hex')
     AND s.expires_at>now() AND u.active AND u.is_super
 ) THEN RAISE EXCEPTION 'Super Admin required' USING ERRCODE='42501';
 END IF;
 SELECT jsonb_build_object(
   'income',round(COALESCE(sum(f.income),0),2)::text,
   'cost',round(COALESCE(sum(f.cost),0),2)::text,
   'margin',round(COALESCE(sum(f.income-f.cost),0),2)::text,
   'unpriced_periods',COALESCE(sum(f.unpriced_periods),0)
 ) INTO report
 FROM public.stores s CROSS JOIN LATERAL public.store_service_finance(s.id) f
 WHERE s.id=target_store OR (target_store IS NULL AND EXISTS (
   SELECT 1 FROM public.memberships m WHERE m.store_id=s.id AND m.user_id=target_owner AND m.role='OWNER'
 ));
 RETURN report;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_service_finance(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_service_finance(uuid,uuid,text) TO stream_app;
