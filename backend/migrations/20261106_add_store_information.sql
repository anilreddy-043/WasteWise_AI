USE `wastewise_ai`;

CREATE TABLE `store_information` (
  `store_id` BIGINT UNSIGNED NOT NULL DEFAULT 1,
  `store_name` VARCHAR(160) NOT NULL DEFAULT '',
  `store_address` VARCHAR(255) NOT NULL DEFAULT '',
  `contact_number` VARCHAR(32) NOT NULL DEFAULT '',
  `email` VARCHAR(254) NOT NULL DEFAULT '',
  `logo_path` VARCHAR(512) NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`store_id`),
  CONSTRAINT `ck_store_information_singleton` CHECK (`store_id` = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `store_information` (`store_id`) VALUES (1);
