ALTER TABLE users ADD COLUMN username text UNIQUE;
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

DO $$
DECLARE
  account record;
  candidate text;
BEGIN
  FOR account IN SELECT id,email FROM users ORDER BY email,id LOOP
    candidate := left(regexp_replace(split_part(account.email,'@',1),'[^a-z0-9_.-]','-','g'),64);
    IF length(candidate)<3 OR EXISTS (SELECT 1 FROM users WHERE username=candidate) THEN
      candidate := 'user-'||account.id::text;
      WHILE EXISTS (SELECT 1 FROM users WHERE username=candidate) LOOP
        candidate := 'user-'||gen_random_uuid()::text;
      END LOOP;
    END IF;
    UPDATE users SET username=candidate WHERE id=account.id;
  END LOOP;
END $$;

ALTER TABLE users ALTER COLUMN username SET NOT NULL;
ALTER TABLE users ADD CHECK (username ~ '^[a-z0-9_.-]{3,64}$');
