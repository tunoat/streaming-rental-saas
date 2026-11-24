CREATE TABLE store_creation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  reviewer_id uuid REFERENCES users(id),
  reviewed_at timestamptz,
  store_id uuid UNIQUE REFERENCES stores(id),
  CHECK (
    (status='PENDING' AND reviewer_id IS NULL AND reviewed_at IS NULL AND store_id IS NULL)
    OR
    (status IN ('APPROVED','REJECTED') AND reviewer_id IS NOT NULL AND reviewed_at IS NOT NULL
      AND (store_id IS NOT NULL)=(status='APPROVED'))
  )
);
CREATE UNIQUE INDEX store_request_pending_name
  ON store_creation_requests(requester_id, lower(name)) WHERE status='PENDING';
GRANT SELECT,INSERT,UPDATE ON store_creation_requests TO stream_app;
