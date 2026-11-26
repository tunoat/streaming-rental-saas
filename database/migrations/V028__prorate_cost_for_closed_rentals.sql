ALTER TABLE public.rentals ADD COLUMN closed_at timestamptz;

UPDATE public.rentals r SET closed_at=c.completed_at
FROM public.rental_cancellations c
WHERE (r.store_id,r.id)=(c.store_id,c.rental_id)
  AND r.status='CLOSED' AND c.completed_at IS NOT NULL;

CREATE FUNCTION public.set_rental_closed_at() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.status='CLOSED' AND OLD.status<>'CLOSED' AND NEW.closed_at IS NULL THEN
    NEW.closed_at=clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER set_rental_closed_at BEFORE UPDATE OF status ON public.rentals
FOR EACH ROW EXECUTE FUNCTION public.set_rental_closed_at();

CREATE OR REPLACE FUNCTION public.store_booked_order_lines(target_store uuid, from_day date, until_day date)
RETURNS TABLE(order_id uuid,customer_id uuid,booked_day date,package_name text,platform text,kind text,
  status text,days integer,price numeric,allocated_cost numeric)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
 SELECT o.id,o.customer_id,(o.created_at AT TIME ZONE 'Asia/Bangkok')::date,k.name,o.platform,o.kind,
   o.status,o.days,o.amount,
   coalesce(c.amount/nullif(p.profile_count,0),current_rate.amount/nullif(slots.count,0))*duration.days/30
 FROM public.orders o
 LEFT JOIN public.streaming_packages k ON (k.store_id,k.id)=(o.store_id,o.package_id)
 LEFT JOIN public.rental_service_periods p ON (p.store_id,p.order_id)=(o.store_id,o.id)
 LEFT JOIN public.rentals r ON (r.store_id,r.id)=(p.store_id,p.rental_id)
 LEFT JOIN public.streaming_account_cost_rates c ON (c.store_id,c.id)=(p.store_id,p.cost_rate_id)
 LEFT JOIN public.profiles selected ON (selected.store_id,selected.id)=(o.store_id,o.profile_id)
 LEFT JOIN LATERAL (
   SELECT rate.amount FROM public.streaming_account_cost_rates rate
   WHERE (rate.store_id,rate.account_id)=(selected.store_id,selected.account_id) AND rate.effective_at<=now()
   ORDER BY rate.effective_at DESC,rate.id DESC LIMIT 1
 ) current_rate ON p.order_id IS NULL OR p.cost_rate_id IS NULL
 LEFT JOIN LATERAL (
   SELECT count(*) AS count FROM public.profiles active
   WHERE (active.store_id,active.account_id)=(selected.store_id,selected.account_id)
     AND active.archived_at IS NULL AND NOT active.is_primary AND lower(btrim(active.label))<>'profile1'
 ) slots ON current_rate.amount IS NOT NULL
 CROSS JOIN LATERAL (
   SELECT CASE WHEN p.order_id IS NULL THEN o.days
     ELSE least(o.days,greatest(0,extract(epoch FROM least(p.ends_at,r.ends_at,r.closed_at)-p.starts_at)/86400))
     END AS days
 ) duration
 WHERE o.store_id=target_store
   AND o.created_at >= (from_day::timestamp AT TIME ZONE 'Asia/Bangkok')
   AND o.created_at < (until_day::timestamp AT TIME ZONE 'Asia/Bangkok');
$$;
