CREATE OR REPLACE FUNCTION authorized_store(candidate uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT candidate::text = current_setting('app.store',true)
  AND (
    EXISTS (
      SELECT 1 FROM public.sessions s
      JOIN public.users u ON u.id=s.user_id AND u.active
      JOIN public.memberships m ON m.user_id=u.id AND m.store_id=candidate
      WHERE s.digest=encode(sha256(convert_to(current_setting('app.auth',true),'UTF8')),'hex') AND s.expires_at>now()
    )
    OR EXISTS (
      SELECT 1 FROM public.workers w JOIN public.worker_stores ws ON ws.worker_id=w.id
      WHERE w.token_digest=encode(sha256(convert_to(current_setting('app.auth',true),'UTF8')),'hex')
        AND w.expires_at>now() AND ws.store_id=candidate
    )
  )
$$;

