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
