CREATE FUNCTION public.guard_store_ledger_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF pg_trigger_depth()>1 AND NOT EXISTS (SELECT 1 FROM public.stores WHERE id=OLD.store_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Posted ledger and audit entries are append-only' USING ERRCODE='55000';
END $$;

DO $$
DECLARE relation name;
BEGIN
  FOREACH relation IN ARRAY ARRAY['wallet_ledger','wallet_adjustments','job_events']::name[] LOOP
    EXECUTE format('DROP TRIGGER %I ON public.%I','immutable_'||relation,relation);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR TRUNCATE ON public.%I
      FOR EACH STATEMENT EXECUTE FUNCTION public.reject_posted_change()','immutable_'||relation,relation);
    EXECUTE format('CREATE TRIGGER guard_store_ledger_delete BEFORE DELETE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION public.guard_store_ledger_delete()',relation);
  END LOOP;
END $$;
