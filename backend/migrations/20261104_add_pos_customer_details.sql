-- Optional POS customer details for existing sales_transactions tables.
-- Safe to run once; each statement uses MySQL's information_schema guard.

SET @has_customer_name := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales_transactions' AND COLUMN_NAME = 'customer_name'
);
SET @sql_customer_name := IF(@has_customer_name = 0,
  'ALTER TABLE sales_transactions ADD COLUMN customer_name VARCHAR(120) NULL AFTER payment_method',
  'SELECT 1');
PREPARE stmt_customer_name FROM @sql_customer_name;
EXECUTE stmt_customer_name;
DEALLOCATE PREPARE stmt_customer_name;

SET @has_customer_phone := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales_transactions' AND COLUMN_NAME = 'customer_phone'
);
SET @sql_customer_phone := IF(@has_customer_phone = 0,
  'ALTER TABLE sales_transactions ADD COLUMN customer_phone VARCHAR(32) NULL AFTER customer_name',
  'SELECT 1');
PREPARE stmt_customer_phone FROM @sql_customer_phone;
EXECUTE stmt_customer_phone;
DEALLOCATE PREPARE stmt_customer_phone;
