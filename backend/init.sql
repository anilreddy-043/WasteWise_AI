USE `wastewise_ai`;

CREATE TABLE IF NOT EXISTS `users` (
  `user_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `full_name` VARCHAR(120) NOT NULL,
  `email` VARCHAR(254) NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `role` ENUM('admin', 'store_manager', 'staff', 'viewer') NOT NULL DEFAULT 'viewer',
  `approval_status` ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  `is_active` BOOLEAN NOT NULL DEFAULT TRUE,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`),
  UNIQUE KEY `uq_users_email` (`email`),
  KEY `ix_users_role_approval` (`role`, `approval_status`),
  KEY `ix_users_active` (`is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `products` (
  `product_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(160) NOT NULL,
  `category` VARCHAR(80) NOT NULL,
  `sku` VARCHAR(64) NOT NULL,
  `unit` VARCHAR(32) NOT NULL,
  `price` DECIMAL(12,2) NOT NULL,
  `supplier` VARCHAR(160) NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`product_id`),
  UNIQUE KEY `uq_products_sku` (`sku`),
  KEY `ix_products_name` (`name`),
  KEY `ix_products_category` (`category`),
  KEY `ix_products_supplier` (`supplier`),
  CONSTRAINT `ck_products_price_nonnegative` CHECK (`price` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `category_shelf_life_settings` (
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
  ('Seafood', 2), ('Meat & Poultry', 3), ('Dairy Products', 9),
  ('Bakery Products', 5), ('Vegetables', 9), ('Fruits', 9),
  ('Ready-to-Eat Foods', 4), ('Fresh Juices', 3), ('Frozen Foods', 228),
  ('Beverages', 105)
ON DUPLICATE KEY UPDATE `category` = VALUES(`category`);

CREATE TABLE IF NOT EXISTS `inventory_batches` (
  `batch_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `batch_code` VARCHAR(64) NOT NULL,
  `quantity_received` DECIMAL(12,3) NOT NULL,
  `quantity_remaining` DECIMAL(12,3) NOT NULL,
  `unit_cost` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `received_at` DATE NOT NULL,
  `expiry_date` DATE NOT NULL,
  `expiry_date_source` VARCHAR(32) NULL COMMENT 'NULL means expiry source is unverified',
  `status` ENUM('active', 'expired', 'depleted', 'recalled') NOT NULL DEFAULT 'active',
  `location` VARCHAR(120) NOT NULL DEFAULT 'Unassigned',
  `supplier` VARCHAR(160) NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`batch_id`),
  UNIQUE KEY `uq_inventory_batches_product_code` (`product_id`, `batch_code`),
  KEY `ix_inventory_batches_expiry_status` (`expiry_date`, `status`),
  KEY `ix_inventory_batches_product` (`product_id`),
  CONSTRAINT `fk_inventory_batches_product` FOREIGN KEY (`product_id`)
    REFERENCES `products` (`product_id`) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `ck_inventory_batches_quantities` CHECK (
    `quantity_received` >= 0 AND `quantity_remaining` >= 0
    AND `quantity_remaining` <= `quantity_received`
  ),
  CONSTRAINT `ck_inventory_batches_unit_cost` CHECK (`unit_cost` >= 0),
  CONSTRAINT `ck_inventory_batches_dates` CHECK (`expiry_date` >= `received_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sales_records` (
  `sale_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `batch_id` BIGINT UNSIGNED NULL,
  `sold_at` DATETIME NOT NULL,
  `quantity` DECIMAL(12,3) NOT NULL,
  `unit_price` DECIMAL(12,2) NOT NULL,
  `total_amount` DECIMAL(14,2) NOT NULL,
  `source` VARCHAR(40) NOT NULL DEFAULT 'manual',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`sale_id`),
  KEY `ix_sales_sold_at` (`sold_at`),
  KEY `ix_sales_product_date` (`product_id`, `sold_at`),
  KEY `ix_sales_batch` (`batch_id`),
  CONSTRAINT `fk_sales_product` FOREIGN KEY (`product_id`)
    REFERENCES `products` (`product_id`) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_batch` FOREIGN KEY (`batch_id`)
    REFERENCES `inventory_batches` (`batch_id`) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `ck_sales_amounts` CHECK (`quantity` > 0 AND `unit_price` >= 0 AND `total_amount` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sales_transactions` (
  `sale_transaction_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `transaction_number` VARCHAR(64) NOT NULL,
  `subtotal` DECIMAL(14,2) NOT NULL,
  `discount_type` VARCHAR(16) NOT NULL,
  `discount_value` DECIMAL(12,2) NOT NULL DEFAULT 0,
  `discount_amount` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `total_amount` DECIMAL(14,2) NOT NULL,
  `payment_method` VARCHAR(16) NOT NULL,
  `customer_name` VARCHAR(120) NULL,
  `customer_phone` VARCHAR(32) NULL,
  `sold_at` DATETIME NOT NULL,
  `processed_by` BIGINT UNSIGNED NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'completed',
  `idempotency_key` VARCHAR(128) NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`sale_transaction_id`),
  UNIQUE KEY `uq_sales_transactions_number` (`transaction_number`),
  UNIQUE KEY `uq_sales_transactions_idempotency` (`idempotency_key`),
  KEY `ix_sales_transactions_processed_at` (`processed_by`, `sold_at`),
  CONSTRAINT `fk_sales_transactions_user` FOREIGN KEY (`processed_by`) REFERENCES `users` (`user_id`) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `ck_sales_transactions_discount_type` CHECK (`discount_type` IN ('percentage', 'amount', 'none')),
  CONSTRAINT `ck_sales_transactions_payment_method` CHECK (`payment_method` IN ('cash', 'upi', 'card')),
  CONSTRAINT `ck_sales_transactions_status` CHECK (`status` IN ('completed', 'cancelled', 'refunded')),
  CONSTRAINT `ck_sales_transactions_amounts` CHECK (`subtotal` >= 0 AND `discount_value` >= 0 AND `discount_amount` >= 0 AND `total_amount` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sales_transaction_items` (
  `sale_item_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `sale_transaction_id` BIGINT UNSIGNED NOT NULL,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `quantity` DECIMAL(12,3) NOT NULL,
  `unit_price` DECIMAL(12,2) NOT NULL,
  `line_subtotal` DECIMAL(14,2) NOT NULL,
  `discount_amount` DECIMAL(14,2) NOT NULL,
  `line_total` DECIMAL(14,2) NOT NULL,
  PRIMARY KEY (`sale_item_id`),
  KEY `ix_sales_transaction_items_transaction` (`sale_transaction_id`),
  KEY `ix_sales_transaction_items_product` (`product_id`),
  CONSTRAINT `fk_sales_transaction_items_transaction` FOREIGN KEY (`sale_transaction_id`) REFERENCES `sales_transactions` (`sale_transaction_id`) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT `fk_sales_transaction_items_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`product_id`) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `ck_sales_transaction_items_values` CHECK (`quantity` > 0 AND `unit_price` >= 0 AND `line_subtotal` >= 0 AND `discount_amount` >= 0 AND `line_total` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sales_transaction_batches` (
  `allocation_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `sale_item_id` BIGINT UNSIGNED NOT NULL,
  `batch_id` BIGINT UNSIGNED NOT NULL,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `quantity_allocated` DECIMAL(12,3) NOT NULL,
  PRIMARY KEY (`allocation_id`),
  UNIQUE KEY `uq_sales_transaction_batch_item` (`sale_item_id`, `batch_id`),
  KEY `ix_sales_transaction_batches_item` (`sale_item_id`),
  KEY `ix_sales_transaction_batches_batch` (`batch_id`),
  KEY `ix_sales_transaction_batches_product` (`product_id`),
  CONSTRAINT `fk_sales_transaction_batches_item` FOREIGN KEY (`sale_item_id`) REFERENCES `sales_transaction_items` (`sale_item_id`) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT `fk_sales_transaction_batches_batch` FOREIGN KEY (`batch_id`) REFERENCES `inventory_batches` (`batch_id`) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_sales_transaction_batches_product` FOREIGN KEY (`product_id`) REFERENCES `products` (`product_id`) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `ck_sales_transaction_batches_quantity` CHECK (`quantity_allocated` > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `waste_records` (
  `waste_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `batch_id` BIGINT UNSIGNED NULL,
  `recorded_by` BIGINT UNSIGNED NULL,
  `quantity` DECIMAL(12,3) NOT NULL,
  `reason` ENUM('spoilage', 'expired', 'damaged', 'overstock', 'other') NOT NULL,
  `waste_cost` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `recorded_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `notes` VARCHAR(500) NULL,
  PRIMARY KEY (`waste_id`),
  KEY `ix_waste_recorded_at` (`recorded_at`),
  KEY `ix_waste_product_reason_date` (`product_id`, `reason`, `recorded_at`),
  KEY `ix_waste_batch` (`batch_id`),
  KEY `ix_waste_recorded_by` (`recorded_by`),
  CONSTRAINT `fk_waste_product` FOREIGN KEY (`product_id`)
    REFERENCES `products` (`product_id`) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_waste_batch` FOREIGN KEY (`batch_id`)
    REFERENCES `inventory_batches` (`batch_id`) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_waste_user` FOREIGN KEY (`recorded_by`)
    REFERENCES `users` (`user_id`) ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT `ck_waste_amounts` CHECK (`quantity` > 0 AND `waste_cost` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `expiry_risk_predictions` (
  `prediction_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `batch_id` BIGINT UNSIGNED NOT NULL,
  `predicted_class` INT NOT NULL,
  `risk_probability` DECIMAL(8,6) NOT NULL,
  `model_version` VARCHAR(64) NOT NULL,
  `predicted_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`prediction_id`),
  KEY `ix_expiry_predictions_batch_day` (`batch_id`, `predicted_at`),
  CONSTRAINT `fk_expiry_predictions_batch` FOREIGN KEY (`batch_id`)
    REFERENCES `inventory_batches` (`batch_id`) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT `ck_expiry_risk_probability` CHECK (`risk_probability` BETWEEN 0 AND 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `demand_forecasts` (
  `forecast_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `forecast_date` DATE NOT NULL,
  `predicted_demand` DECIMAL(12,3) NOT NULL,
  `lower_bound` DECIMAL(12,3) NULL,
  `upper_bound` DECIMAL(12,3) NULL,
  `model_version` VARCHAR(64) NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`forecast_id`),
  UNIQUE KEY `uq_forecast_product_day_model` (`product_id`, `forecast_date`, `model_version`),
  KEY `ix_forecasts_date` (`forecast_date`),
  CONSTRAINT `fk_forecasts_product` FOREIGN KEY (`product_id`)
    REFERENCES `products` (`product_id`) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `ck_forecasts_bounds` CHECK (
    `predicted_demand` >= 0
    AND (`lower_bound` IS NULL OR `lower_bound` >= 0)
    AND (`upper_bound` IS NULL OR `upper_bound` >= `predicted_demand`)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `recommendations` (
  `recommendation_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `recommendation_type` ENUM('restock', 'discount', 'transfer', 'donate', 'reorder', 'remove') NOT NULL,
  `batch_id` BIGINT UNSIGNED NULL,
  `recommended_quantity` DECIMAL(12,3) NULL,
  `discount_percent` DECIMAL(5,2) NULL,
  `reason` VARCHAR(500) NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `applied_by` BIGINT UNSIGNED NULL,
  `applied_at` DATETIME NULL,
  PRIMARY KEY (`recommendation_id`),
  KEY `ix_recommendations_status_date` (`status`, `created_at`),
  KEY `ix_recommendations_product` (`product_id`),
  KEY `ix_recommendations_applied_by` (`applied_by`),
  KEY `ix_recommendations_batch` (`batch_id`),
  CONSTRAINT `fk_recommendations_product` FOREIGN KEY (`product_id`)
    REFERENCES `products` (`product_id`) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT `fk_recommendations_user` FOREIGN KEY (`applied_by`)
    REFERENCES `users` (`user_id`) ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT `fk_recommendations_batch` FOREIGN KEY (`batch_id`)
    REFERENCES `inventory_batches` (`batch_id`) ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT `ck_recommendations_quantity` CHECK (
    `recommended_quantity` IS NULL OR `recommended_quantity` >= 0
  ),
  CONSTRAINT `ck_recommendations_discount` CHECK (
    `discount_percent` IS NULL OR (`discount_percent` >= 0 AND `discount_percent` <= 100)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `model_metrics` (
  `metric_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `model_name` VARCHAR(120) NOT NULL,
  `model_version` VARCHAR(64) NOT NULL,
  `evaluated_at` DATETIME NOT NULL,
  `mae` DECIMAL(14,6) NULL,
  `rmse` DECIMAL(14,6) NULL,
  `r2_score` DECIMAL(8,6) NULL,
  `sample_size` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `metrics_json` JSON NULL,
  PRIMARY KEY (`metric_id`),
  KEY `ix_model_metrics_name_date` (`model_name`, `evaluated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `user_activity` (
  `activity_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NULL,
  `action` VARCHAR(80) NOT NULL,
  `entity_type` VARCHAR(80) NOT NULL,
  `entity_id` BIGINT UNSIGNED NULL,
  `details` JSON NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`activity_id`),
  KEY `ix_activity_user_date` (`user_id`, `created_at`),
  KEY `ix_activity_entity` (`entity_type`, `entity_id`),
  CONSTRAINT `fk_activity_user` FOREIGN KEY (`user_id`)
    REFERENCES `users` (`user_id`) ON UPDATE CASCADE ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
