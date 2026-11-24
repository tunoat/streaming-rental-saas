ALTER TABLE streaming_account_cost_rates
  ADD COLUMN broker_amount numeric(18,2) CHECK (broker_amount>=0),
  ADD COLUMN subscription_amount numeric(18,2) CHECK (subscription_amount>=0),
  ADD CHECK (
    (broker_amount IS NULL AND subscription_amount IS NULL)
    OR (broker_amount IS NOT NULL AND subscription_amount IS NOT NULL AND amount=broker_amount+subscription_amount)
  );

CREATE INDEX orders_store_booked_date ON orders(store_id,created_at);

CREATE FUNCTION public.store_booked_order_lines(target_store uuid, from_day date, until_day date)
RETURNS TABLE(order_id uuid,customer_id uuid,booked_day date,package_name text,platform text,kind text,
  status text,days integer,price numeric,allocated_cost numeric)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT o.id,o.customer_id,(o.created_at AT TIME ZONE 'Asia/Bangkok')::date,k.name,o.platform,o.kind,
   o.status,o.days,o.amount,c.amount*o.days/(30::numeric*p.profile_count)
 FROM public.orders o
 LEFT JOIN public.streaming_packages k ON (k.store_id,k.id)=(o.store_id,o.package_id)
 LEFT JOIN public.rental_service_periods p ON (p.store_id,p.order_id)=(o.store_id,o.id)
 LEFT JOIN public.streaming_account_cost_rates c ON (c.store_id,c.id)=(p.store_id,p.cost_rate_id)
 WHERE o.store_id=target_store
   AND o.created_at >= (from_day::timestamp AT TIME ZONE 'Asia/Bangkok')
   AND o.created_at < (until_day::timestamp AT TIME ZONE 'Asia/Bangkok');
$$;
REVOKE ALL ON FUNCTION public.store_booked_order_lines(uuid,date,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.store_booked_order_lines(uuid,date,date) TO stream_app;

CREATE FUNCTION public.store_monthly_booked_sales(target_store uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT COALESCE(sum(amount),0)
 FROM public.orders o
 WHERE o.store_id=target_store AND o.kind IN ('PURCHASE','RENEWAL')
 AND o.created_at >= (date_trunc('month',now() AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok')
 AND o.created_at < ((date_trunc('month',now() AT TIME ZONE 'Asia/Bangkok')+interval '1 month') AT TIME ZONE 'Asia/Bangkok');
$$;
REVOKE ALL ON FUNCTION public.store_monthly_booked_sales(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.store_monthly_booked_sales(uuid) TO stream_app;

CREATE OR REPLACE FUNCTION public.admin_monthly_account_cost(target_owner uuid,target_store uuid,bearer text) RETURNS jsonb
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
   'month',to_char(now() AT TIME ZONE 'Asia/Bangkok','YYYY-MM'),
   'total',round(COALESCE(sum(f.total),0),2)::text,
   'income',round(COALESCE(sum(public.store_monthly_booked_sales(s.id)),0),2)::text,
   'configured',COALESCE(sum(f.configured),0),
   'unconfigured',COALESCE(sum(f.unconfigured),0)
 ) INTO report
 FROM public.stores s CROSS JOIN LATERAL public.store_monthly_account_cost(s.id) f
 WHERE s.id=target_store OR (target_store IS NULL AND EXISTS (
   SELECT 1 FROM public.memberships m WHERE m.store_id=s.id AND m.user_id=target_owner AND m.role='OWNER'
 ));
 RETURN report;
END;
$$;
