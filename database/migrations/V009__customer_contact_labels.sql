ALTER TABLE customers
  ADD COLUMN alias text CHECK (length(alias) BETWEEN 1 AND 150),
  ADD COLUMN url text CHECK (length(url)<=2048 AND url ~ '^https?://');
