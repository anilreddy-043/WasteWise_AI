USE `wastewise_ai`;

CREATE TABLE IF NOT EXISTS `dashboard_import_runs` (
  `import_run_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `source_file` VARCHAR(255) NOT NULL,
  `source_sha256` VARCHAR(64) NOT NULL,
  `started_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `completed_at` DATETIME NULL,
  `rows_seen` INT NOT NULL DEFAULT 0,
  `rows_inserted` INT NOT NULL DEFAULT 0,
  `rows_skipped` INT NOT NULL DEFAULT 0,
  PRIMARY KEY (`import_run_id`),
  KEY `ix_dashboard_import_runs_source_started` (`source_file`, `started_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `dashboard_import_records` (
  `import_record_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `source_file` VARCHAR(255) NOT NULL,
  `source_record_key` VARCHAR(255) NOT NULL,
  `entity_type` VARCHAR(32) NOT NULL,
  `entity_id` BIGINT UNSIGNED NOT NULL,
  `import_run_id` BIGINT UNSIGNED NOT NULL,
  `imported_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`import_record_id`),
  UNIQUE KEY `uq_dashboard_import_source_record` (`source_file`, `source_record_key`, `entity_type`),
  KEY `ix_dashboard_import_entity` (`entity_type`, `entity_id`),
  CONSTRAINT `fk_dashboard_import_run` FOREIGN KEY (`import_run_id`)
    REFERENCES `dashboard_import_runs` (`import_run_id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `dashboard_historical_metrics` (
  `historical_metric_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `source_file` VARCHAR(255) NOT NULL,
  `source_record_key` VARCHAR(255) NOT NULL,
  `source_run_id` BIGINT UNSIGNED NOT NULL,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `business_date` DATE NOT NULL,
  `sales_quantity` DECIMAL(12,3) NOT NULL,
  `sales_revenue` DECIMAL(14,2) NOT NULL,
  `waste_quantity` DECIMAL(12,3) NOT NULL,
  `data_kind` VARCHAR(32) NOT NULL DEFAULT 'training_history',
  `imported_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`historical_metric_id`),
  UNIQUE KEY `uq_dashboard_history_source_record` (`source_file`, `source_record_key`),
  KEY `ix_dashboard_history_date_product` (`business_date`, `product_id`),
  CONSTRAINT `fk_dashboard_history_run` FOREIGN KEY (`source_run_id`)
    REFERENCES `dashboard_import_runs` (`import_run_id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_dashboard_history_product` FOREIGN KEY (`product_id`)
    REFERENCES `products` (`product_id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `ck_dashboard_history_nonnegative` CHECK (
    `sales_quantity` >= 0 AND `sales_revenue` >= 0 AND `waste_quantity` >= 0
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;