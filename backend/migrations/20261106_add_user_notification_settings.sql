CREATE TABLE `user_notification_settings` (
  `user_id` BIGINT UNSIGNED NOT NULL,
  `expiry_alerts` BOOLEAN NOT NULL DEFAULT TRUE,
  `low_stock_alerts` BOOLEAN NOT NULL DEFAULT TRUE,
  `high_demand_alerts` BOOLEAN NOT NULL DEFAULT TRUE,
  `daily_reports` BOOLEAN NOT NULL DEFAULT FALSE,
  `weekly_insights` BOOLEAN NOT NULL DEFAULT TRUE,
  `system_notifications` BOOLEAN NOT NULL DEFAULT TRUE,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`),
  CONSTRAINT `fk_user_notification_settings_user`
    FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
