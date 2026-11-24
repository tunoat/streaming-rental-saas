ALTER TABLE streaming_account_cost_rates ALTER COLUMN cycle_days SET DEFAULT 30;

CREATE FUNCTION public.store_monthly_account_cost(target_store uuid)
RETURNS TABLE(total numeric,configured bigint,unconfigured bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT COALESCE(sum(rate.amount),0),count(rate.amount),count(*)-count(rate.amount)
 FROM public.accounts a
 LEFT JOIN LATERAL (
   SELECT c.amount FROM public.streaming_account_cost_rates c
   WHERE (c.store_id,c.account_id)=(a.store_id,a.id) AND c.effective_at<=now()
   ORDER BY c.effective_at DESC,c.id DESC LIMIT 1
 ) rate ON true
 WHERE a.store_id=target_store;
$$;
REVOKE ALL ON FUNCTION public.store_monthly_account_cost(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.store_monthly_account_cost(uuid) TO stream_app;

CREATE FUNCTION public.admin_monthly_account_cost(target_owner uuid,target_store uuid,bearer text) RETURNS jsonb
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
REVOKE ALL ON FUNCTION public.admin_monthly_account_cost(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_monthly_account_cost(uuid,uuid,text) TO stream_app;
