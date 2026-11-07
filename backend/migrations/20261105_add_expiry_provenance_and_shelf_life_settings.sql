ALTER TABLE `inventory_batches`
  ADD COLUMN `expiry_date_source` VARCHAR(32) NULL
    COMMENT 'NULL means the existing or submitted expiry date has not been verified';

CREATE TABLE `category_shelf_life_settings` (
  `category` VARCHAR(80) NOT NULL,
  `days` INT NOT NULL,
  `updated_by` BIGINT UNSIGNED NULL,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`category`),
  CONSTRAINT `fk_shelf_life_updated_by` FOREIGN KEY (`updated_by`)
    REFERENCES `users` (`user_id`) ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT `ck_shelf_life_days_positive` CHECK (`days` BETWEEN 1 AND 3650)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `category_shelf_life_settings` (`category`, `days`) VALUES
  ('Seafood', 2),
  ('Meat & Poultry', 3),
  ('Dairy Products', 9),
  ('Bakery Products', 5),
  ('Vegetables', 9),
  ('Fruits', 9),
  ('Ready-to-Eat Foods', 4),
  ('Fresh Juices', 3),
  ('Frozen Foods', 228),
  ('Beverages', 105);
