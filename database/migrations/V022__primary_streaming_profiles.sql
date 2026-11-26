ALTER TABLE profiles ADD COLUMN is_primary boolean NOT NULL DEFAULT false;
WITH named AS (
  SELECT store_id,id,row_number() OVER (PARTITION BY store_id,account_id ORDER BY id) AS slot
  FROM profiles WHERE archived_at IS NULL AND lower(btrim(label))='profile1'
)
UPDATE profiles p SET is_primary=true FROM named n WHERE (p.store_id,p.id)=(n.store_id,n.id) AND n.slot=1;
CREATE UNIQUE INDEX one_primary_profile_per_account ON profiles(store_id,account_id) WHERE is_primary;
ALTER TABLE profiles ADD CHECK (NOT is_primary OR archived_at IS NULL);
