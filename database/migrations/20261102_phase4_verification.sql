SELECT VERSION() AS mysql_version, DATABASE() AS selected_database;

SHOW CREATE TABLE recommendations;
SHOW CREATE TABLE inventory_batches;

SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'recommendations'
  AND COLUMN_NAME IN ('recommendation_id', 'batch_id', 'applied_at', 'recommendation_type')
ORDER BY ORDINAL_POSITION;

SELECT recommendation_type, COUNT(*) AS record_count
FROM recommendations
GROUP BY recommendation_type
ORDER BY recommendation_type;

SELECT COUNT(*) AS recommendation_total_before_and_after_check
FROM recommendations;

SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
FROM information_schema.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'recommendations'
  AND REFERENCED_TABLE_NAME IS NOT NULL
ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION;

SELECT COUNT(*) AS orphaned_batch_references
FROM recommendations r
LEFT JOIN inventory_batches b ON b.batch_id = r.batch_id
WHERE r.batch_id IS NOT NULL AND b.batch_id IS NULL;

SELECT COUNT(*) AS batch_id_index_count
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'recommendations'
  AND COLUMN_NAME = 'batch_id'
  AND INDEX_NAME = 'ix_recommendations_batch';
