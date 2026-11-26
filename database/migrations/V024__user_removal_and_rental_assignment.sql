ALTER TABLE users ADD COLUMN removed_at timestamptz;
ALTER TABLE profiles ADD COLUMN encrypted_pin text;
ALTER TABLE rentals ADD COLUMN profile_unassigned boolean NOT NULL DEFAULT false,
  ADD COLUMN release_requested_at timestamptz;
DROP INDEX active_rental_profile;
CREATE UNIQUE INDEX active_rental_profile ON rentals(store_id,profile_id)
  WHERE status<>'CLOSED' AND NOT profile_unassigned;

-- Delete all store-owned rows in the same statement, including rows whose
-- original foreign keys reference the store through another tenant table.
DO $$
DECLARE relation regclass;
DECLARE constraint_name name;
BEGIN
  FOR relation IN
    SELECT c.oid::regclass FROM pg_class c
    JOIN pg_attribute a ON a.attrelid=c.oid
    WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'
      AND a.attname='store_id' AND NOT a.attisdropped
  LOOP
    FOR constraint_name IN SELECT conname FROM pg_constraint
      WHERE conrelid=relation AND confrelid='public.stores'::regclass AND contype='f'
    LOOP
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',relation,constraint_name);
    END LOOP;
    EXECUTE format('ALTER TABLE %s ADD FOREIGN KEY(store_id) REFERENCES public.stores(id) ON DELETE CASCADE',relation);
  END LOOP;
END $$;

CREATE FUNCTION public.remove_platform_user(target uuid, kind text, bearer text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor uuid;
DECLARE owned uuid[];
DECLARE staff uuid[];
DECLARE store_id_to_remove uuid;
BEGIN
  SELECT u.id INTO actor FROM public.sessions s JOIN public.users u ON u.id=s.user_id
  WHERE s.digest=encode(sha256(convert_to(bearer,'UTF8')),'hex')
    AND s.expires_at>now() AND u.active AND u.is_super;
  IF actor IS NULL THEN RAISE EXCEPTION 'Super Admin required' USING ERRCODE='42501'; END IF;
  IF kind NOT IN ('OWNER','ADMIN') OR NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id=target AND u.removed_at IS NULL AND NOT u.is_super
      AND ((kind='ADMIN' AND u.is_admin) OR (kind='OWNER' AND NOT u.is_admin AND (
        EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id=u.id AND m.role='OWNER')
        OR EXISTS (SELECT 1 FROM public.admin_audit a WHERE a.subject_id=u.id AND a.action='OWNER_CREATED')
        OR NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id=u.id)
      )))
  ) THEN RETURN false; END IF;
  SELECT array_agg(m.store_id ORDER BY m.store_id) INTO owned
    FROM public.memberships m WHERE m.user_id=target AND m.role='OWNER';
  FOREACH store_id_to_remove IN ARRAY coalesce(owned,ARRAY[]::uuid[]) LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(store_id_to_remove::text,1));
  END LOOP;
  SELECT array_agg(DISTINCT m.user_id) INTO staff FROM public.memberships m
    WHERE m.store_id=ANY(owned) AND m.role IN ('STAFF','HEAD_STAFF');
  DELETE FROM public.stores WHERE id=ANY(owned);
  DELETE FROM public.memberships WHERE user_id=target OR (user_id=ANY(staff) AND role<>'OWNER');
  SELECT array_agg(u.id) INTO staff FROM public.users u WHERE u.id=ANY(staff)
    AND NOT u.is_super AND NOT u.is_admin
    AND NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id=u.id);
  DELETE FROM public.store_creation_requests WHERE requester_id=target OR requester_id=ANY(staff);
  DELETE FROM public.sessions WHERE user_id=target OR user_id=ANY(staff);
  UPDATE public.users SET active=false,is_admin=false,removed_at=clock_timestamp(),
    username='removed-'||id,password_hash='disabled'
    WHERE id=target OR id=ANY(staff);
  INSERT INTO public.admin_audit(actor_id,action,subject_id) VALUES(actor,kind||'_REMOVED',target);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.remove_platform_user(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.remove_platform_user(uuid,text,text) TO stream_app;
