ALTER TABLE users ADD COLUMN is_admin boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD CHECK (NOT (is_super AND is_admin));

-- Existing interface-created Admin accounts used the former Super Admin flag.
WITH delegated AS (
  SELECT DISTINCT subject_id FROM admin_audit WHERE action='ADMIN_CREATED' AND actor_id<>subject_id
), retained_super AS (
  SELECT u.id FROM users u LEFT JOIN delegated d ON d.subject_id=u.id
  WHERE u.is_super AND u.active ORDER BY (d.subject_id IS NULL) DESC,u.id LIMIT 1
)
UPDATE users u SET is_super=false,is_admin=true
FROM delegated d WHERE u.id=d.subject_id AND u.is_super
  AND u.id IS DISTINCT FROM (SELECT id FROM retained_super);
