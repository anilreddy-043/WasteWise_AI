-- Safe, rerunnable MySQL 8 migration for Phase 4 recommendation workflows.
-- Run once with an authorized DBA account after creating and verifying a backup.
-- Existing ENUM values are explicitly preserved: restock, discount, transfer, donate.

ALTER TABLE recommendations
  MODIFY COLUMN recommendation_type ENUM(
    'restock', 'discount', 'transfer', 'donate', 'reorder', 'remove'
  ) NOT NULL;

DROP PROCEDURE IF EXISTS extend_recommendations_phase4;
DELIMITER $$
CREATE PROCEDURE extend_recommendations_phase4()
BEGIN
  DECLARE batch_type VARCHAR(64);
  DECLARE recommendation_batch_type VARCHAR(64);
  DECLARE orphan_count INT DEFAULT 0;
  DECLARE matching_fk_count INT DEFAULT 0;
  DECLARE conflicting_fk_count INT DEFAULT 0;

  SELECT COLUMN_TYPE INTO batch_type
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'inventory_batches'
    AND COLUMN_NAME = 'batch_id';

  IF batch_type IS NULL OR batch_type <> 'bigint unsigned' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'inventory_batches.batch_id must exist as bigint unsigned';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'recommendations'
      AND COLUMN_NAME = 'batch_id'
  ) THEN
    ALTER TABLE recommendations
      ADD COLUMN batch_id BIGINT UNSIGNED NULL;
  END IF;

  SELECT COLUMN_TYPE INTO recommendation_batch_type
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'recommendations'
    AND COLUMN_NAME = 'batch_id';
  IF recommendation_batch_type IS NULL OR recommendation_batch_type <> 'bigint unsigned' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'recommendations.batch_id must be bigint unsigned';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'recommendations'
      AND COLUMN_NAME = 'applied_at'
  ) THEN
    ALTER TABLE recommendations
      ADD COLUMN applied_at DATETIME NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'recommendations'
      AND INDEX_NAME = 'ix_recommendations_batch'
  ) THEN
    ALTER TABLE recommendations
      ADD INDEX ix_recommendations_batch (batch_id);
  END IF;

  SELECT COUNT(*) INTO matching_fk_count
  FROM information_schema.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'recommendations'
    AND COLUMN_NAME = 'batch_id'
    AND REFERENCED_TABLE_NAME = 'inventory_batches'
    AND REFERENCED_COLUMN_NAME = 'batch_id';

  SELECT COUNT(*) INTO conflicting_fk_count
  FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'recommendations'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
    AND CONSTRAINT_NAME = 'fk_recommendations_batch';

  IF matching_fk_count = 0 THEN
    SELECT COUNT(*) INTO orphan_count
    FROM recommendations r
    LEFT JOIN inventory_batches b ON b.batch_id = r.batch_id
    WHERE r.batch_id IS NOT NULL AND b.batch_id IS NULL;
    IF orphan_count > 0 THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'recommendations.batch_id contains orphaned references; resolve them before adding the foreign key';
    END IF;

    IF conflicting_fk_count > 0 THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'fk_recommendations_batch exists but references a different relationship';
    END IF;
    ALTER TABLE recommendations
      ADD CONSTRAINT fk_recommendations_batch
      FOREIGN KEY (batch_id) REFERENCES inventory_batches(batch_id)
      ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
END$$
DELIMITER ;

CALL extend_recommendations_phase4();
DROP PROCEDURE extend_recommendations_phase4;
