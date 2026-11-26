ALTER TABLE accounts ADD COLUMN archived_at timestamptz;
ALTER TABLE accounts DROP CONSTRAINT accounts_platform_email_key;
CREATE UNIQUE INDEX active_streaming_account_email ON accounts(platform,email) WHERE archived_at IS NULL;

CREATE OR REPLACE FUNCTION public.store_monthly_account_cost(target_store uuid)
RETURNS TABLE(total numeric,configured bigint,unconfigured bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT COALESCE(sum(rate.amount),0),count(rate.amount),count(*)-count(rate.amount)
 FROM public.accounts a
 LEFT JOIN LATERAL (
   SELECT c.amount FROM public.streaming_account_cost_rates c
   WHERE (c.store_id,c.account_id)=(a.store_id,a.id) AND c.effective_at<=now()
   ORDER BY c.effective_at DESC,c.id DESC LIMIT 1
 ) rate ON true
 WHERE a.store_id=target_store AND a.archived_at IS NULL;
$$;
