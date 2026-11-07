-- WasteWise AI POS sales transaction tables
-- Apply only once to the reviewed database. CREATE statements intentionally fail if a table already exists.
-- Run inside a controlled MySQL client session; MySQL DDL is not transactional.

CREATE TABLE sales_transactions (
  sale_transaction_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  transaction_number VARCHAR(64) NOT NULL,
  subtotal DECIMAL(14,2) NOT NULL,
  discount_type VARCHAR(16) NOT NULL,
  discount_value DECIMAL(12,2) NOT NULL DEFAULT 0,
  discount_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  total_amount DECIMAL(14,2) NOT NULL,
  payment_method VARCHAR(16) NOT NULL,
  customer_name VARCHAR(120) NULL,
  customer_phone VARCHAR(32) NULL,
  sold_at DATETIME NOT NULL,
  processed_by BIGINT UNSIGNED NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'completed',
  idempotency_key VARCHAR(128) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (sale_transaction_id),
  UNIQUE KEY uq_sales_transactions_number (transaction_number),
  UNIQUE KEY uq_sales_transactions_idempotency (idempotency_key),
  KEY ix_sales_transactions_processed_at (processed_by, sold_at),
  CONSTRAINT fk_sales_transactions_user FOREIGN KEY (processed_by) REFERENCES users(user_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT ck_sales_transactions_discount_type CHECK (discount_type IN ('percentage', 'amount', 'none')),
  CONSTRAINT ck_sales_transactions_payment_method CHECK (payment_method IN ('cash', 'upi', 'card')),
  CONSTRAINT ck_sales_transactions_status CHECK (status IN ('completed', 'cancelled', 'refunded')),
  CONSTRAINT ck_sales_transactions_amounts CHECK (subtotal >= 0 AND discount_value >= 0 AND discount_amount >= 0 AND total_amount >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sales_transaction_items (
  sale_item_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sale_transaction_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  quantity DECIMAL(12,3) NOT NULL,
  unit_price DECIMAL(12,2) NOT NULL,
  line_subtotal DECIMAL(14,2) NOT NULL,
  discount_amount DECIMAL(14,2) NOT NULL,
  line_total DECIMAL(14,2) NOT NULL,
  PRIMARY KEY (sale_item_id),
  KEY ix_sales_transaction_items_transaction (sale_transaction_id),
  KEY ix_sales_transaction_items_product (product_id),
  CONSTRAINT fk_sales_transaction_items_transaction FOREIGN KEY (sale_transaction_id) REFERENCES sales_transactions(sale_transaction_id) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_sales_transaction_items_product FOREIGN KEY (product_id) REFERENCES products(product_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT ck_sales_transaction_items_values CHECK (quantity > 0 AND unit_price >= 0 AND line_subtotal >= 0 AND discount_amount >= 0 AND line_total >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sales_transaction_batches (
  allocation_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sale_item_id BIGINT UNSIGNED NOT NULL,
  batch_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  quantity_allocated DECIMAL(12,3) NOT NULL,
  PRIMARY KEY (allocation_id),
  UNIQUE KEY uq_sales_transaction_batch_item (sale_item_id, batch_id),
  KEY ix_sales_transaction_batches_item (sale_item_id),
  KEY ix_sales_transaction_batches_batch (batch_id),
  KEY ix_sales_transaction_batches_product (product_id),
  CONSTRAINT fk_sales_transaction_batches_item FOREIGN KEY (sale_item_id) REFERENCES sales_transaction_items(sale_item_id) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_sales_transaction_batches_batch FOREIGN KEY (batch_id) REFERENCES inventory_batches(batch_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_sales_transaction_batches_product FOREIGN KEY (product_id) REFERENCES products(product_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT ck_sales_transaction_batches_quantity CHECK (quantity_allocated > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
