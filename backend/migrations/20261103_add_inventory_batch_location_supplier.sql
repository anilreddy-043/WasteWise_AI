-- Align inventory_batches with the InventoryBatch model.
-- Review before applying; adding location backfills existing rows to "Unassigned".

ALTER TABLE inventory_batches
  ADD COLUMN location VARCHAR(120) NOT NULL DEFAULT 'Unassigned' AFTER status,
  ADD COLUMN supplier VARCHAR(160) NULL AFTER location;
