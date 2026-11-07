CREATE TABLE IF NOT EXISTS `user_notifications` (
  `notification_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `event_key` VARCHAR(191) NOT NULL,
  `title` VARCHAR(160) NOT NULL,
  `description` VARCHAR(500) NOT NULL,
  `category` VARCHAR(32) NOT NULL,
  `priority` VARCHAR(16) NOT NULL,
  `occurred_at` DATETIME NOT NULL,
  `read_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`notification_id`),
  UNIQUE KEY `uq_user_notifications_user_event` (`user_id`, `event_key`),
  KEY `ix_user_notifications_user_read` (`user_id`, `read_at`),
  KEY `ix_user_notifications_user_created` (`user_id`, `created_at`),
  CONSTRAINT `fk_user_notifications_user_id`
    FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
