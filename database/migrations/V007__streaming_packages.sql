CREATE TABLE streaming_packages (
  store_id uuid NOT NULL REFERENCES stores(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  platform text NOT NULL CHECK (platform=lower(btrim(platform)) AND platform<>''),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 150),
  days integer NOT NULL CHECK (days BETWEEN 1 AND 365),
  amount numeric(18,2) NOT NULL CHECK (amount>0),
  PRIMARY KEY(store_id,id),
  UNIQUE(store_id,id,platform)
);
CREATE UNIQUE INDEX streaming_package_name ON streaming_packages(store_id,platform,lower(name));
ALTER TABLE streaming_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE streaming_packages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_select ON streaming_packages FOR SELECT USING (authorized_store(store_id));
CREATE POLICY tenant_insert ON streaming_packages FOR INSERT WITH CHECK (authorized_store(store_id));
CREATE POLICY tenant_update ON streaming_packages FOR UPDATE USING (authorized_store(store_id)) WITH CHECK (authorized_store(store_id));
GRANT SELECT,INSERT,UPDATE ON streaming_packages TO stream_app;

ALTER TABLE orders ADD COLUMN package_id uuid, ADD COLUMN platform text;
ALTER TABLE orders ADD CHECK ((package_id IS NULL)=(platform IS NULL));
ALTER TABLE orders ADD FOREIGN KEY(store_id,package_id,platform) REFERENCES streaming_packages(store_id,id,platform);
