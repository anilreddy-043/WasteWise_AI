USE `wastewise_ai`;

ALTER TABLE `inventory_batches`
  ADD COLUMN `location` VARCHAR(120) NOT NULL DEFAULT 'Unassigned',
  ADD COLUMN `supplier` VARCHAR(160) NULL;
