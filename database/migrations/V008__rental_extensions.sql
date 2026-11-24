ALTER TABLE orders DROP CONSTRAINT orders_amount_check;
ALTER TABLE orders
  ADD COLUMN kind text NOT NULL DEFAULT 'PURCHASE',
  ADD COLUMN rental_id uuid,
  ADD COLUMN reason text,
  ADD COLUMN actor_id uuid REFERENCES users(id),
  ADD FOREIGN KEY(store_id,rental_id) REFERENCES rentals(store_id,id),
  ADD CHECK (
    (kind='PURCHASE' AND amount>0 AND rental_id IS NULL AND reason IS NULL)
    OR (kind='RENEWAL' AND amount>0 AND rental_id IS NOT NULL AND package_id IS NOT NULL AND reason IS NULL
      AND actor_id IS NOT NULL AND profile_id IS NOT NULL AND status='FULFILLED')
    OR (kind='COMPENSATION' AND amount=0 AND rental_id IS NOT NULL AND package_id IS NULL
      AND reason IS NOT NULL AND length(btrim(reason)) BETWEEN 1 AND 150
      AND actor_id IS NOT NULL AND profile_id IS NOT NULL AND status='FULFILLED')
  );
