CREATE FUNCTION public.admin_store_sales(target_store uuid, bearer text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$
DECLARE report jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.sessions s JOIN public.users u ON u.id=s.user_id
    WHERE s.digest=encode(sha256(convert_to(bearer,'UTF8')),'hex')
      AND s.expires_at>now() AND u.active AND u.is_super
  ) THEN RAISE EXCEPTION 'Super Admin required' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.stores WHERE id=target_store) THEN RETURN NULL; END IF;

  WITH shop_orders AS (
    SELECT kind,package_id,platform,days,amount FROM public.orders WHERE store_id=target_store
  ), paid AS (
    SELECT * FROM shop_orders WHERE kind IN ('PURCHASE','RENEWAL')
  ), sales AS (
    SELECT p.package_id,coalesce(k.name,'ออเดอร์เดิม') AS name,p.platform,p.days,
      p.amount::text AS unit_price,count(*)::int AS sold,sum(p.amount)::text AS total
    FROM paid p LEFT JOIN public.streaming_packages k ON k.store_id=target_store AND k.id=p.package_id
    GROUP BY p.package_id,k.name,p.platform,p.days,p.amount
    UNION ALL
    SELECT k.id,k.name,k.platform,k.days,k.amount::text,0,'0.00'
    FROM public.streaming_packages k WHERE k.store_id=target_store
      AND NOT EXISTS (SELECT 1 FROM paid p WHERE p.package_id=k.id AND p.days=k.days AND p.amount=k.amount)
  )
  SELECT jsonb_build_object(
    'purchase_count',(SELECT count(*)::int FROM shop_orders WHERE kind='PURCHASE'),
    'renewal_count',(SELECT count(*)::int FROM shop_orders WHERE kind='RENEWAL'),
    'compensation_count',(SELECT count(*)::int FROM shop_orders WHERE kind='COMPENSATION'),
    'packages_sold',(SELECT count(*)::int FROM paid WHERE package_id IS NOT NULL),
    'total_sales',(SELECT coalesce(sum(amount),0.00)::text FROM paid),
    'packages',coalesce((SELECT jsonb_agg(to_jsonb(sales) ORDER BY platform,days,name,unit_price) FROM sales),'[]'::jsonb)
  ) INTO report;
  RETURN report;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_store_sales(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_store_sales(uuid,text) TO stream_app;
