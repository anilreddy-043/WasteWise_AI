CREATE TABLE `user_general_settings` (
  `user_id` BIGINT UNSIGNED NOT NULL,
  `application_name` VARCHAR(120) NOT NULL DEFAULT 'WasteWise AI',
  `timezone` VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
  `date_format` VARCHAR(16) NOT NULL DEFAULT 'DD MMM YYYY',
  `language` VARCHAR(5) NOT NULL DEFAULT 'en',
  `items_per_page` INT NOT NULL DEFAULT 10,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`),
  CONSTRAINT `fk_user_general_settings_user`
    FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT `ck_user_general_settings_items_per_page`
    CHECK (`items_per_page` IN (10, 20, 50, 100))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
