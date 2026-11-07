from datetime import datetime
from decimal import Decimal

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, Integer, Numeric, String, func, text, UniqueConstraint
from sqlalchemy.dialects.mysql import BIGINT
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class SaleRecord(Base):
    __tablename__ = "sales_records"

    sale_id: Mapped[int] = mapped_column(
        BIGINT(unsigned=True).with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True
    )
    product_id: Mapped[int] = mapped_column(
        BIGINT(unsigned=True), ForeignKey("products.product_id", ondelete="RESTRICT", onupdate="CASCADE"), nullable=False
    )
    batch_id: Mapped[int | None] = mapped_column(
        BIGINT(unsigned=True), ForeignKey("inventory_batches.batch_id", ondelete="RESTRICT", onupdate="CASCADE")
    )
    sold_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)
    unit_price: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    total_amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    source: Mapped[str] = mapped_column(String(40), nullable=False, server_default=text("'manual'"))
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))


class SalesTransaction(Base):
    __tablename__ = "sales_transactions"
    __table_args__ = (
        CheckConstraint("discount_type IN ('percentage', 'amount', 'none')", name="ck_sales_transactions_discount_type"),
        CheckConstraint("payment_method IN ('cash', 'upi', 'card')", name="ck_sales_transactions_payment_method"),
        CheckConstraint("status IN ('completed', 'cancelled', 'refunded')", name="ck_sales_transactions_status"),
        CheckConstraint("subtotal >= 0 AND discount_value >= 0 AND discount_amount >= 0 AND total_amount >= 0", name="ck_sales_transactions_amounts"),
        Index("ix_sales_transactions_processed_at", "processed_by", "sold_at"),
        UniqueConstraint("transaction_number", name="uq_sales_transactions_number"),
        UniqueConstraint("idempotency_key", name="uq_sales_transactions_idempotency"),
    )

    sale_transaction_id: Mapped[int] = mapped_column(BIGINT(unsigned=True).with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    transaction_number: Mapped[str] = mapped_column(String(64), nullable=False)
    subtotal: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    discount_type: Mapped[str] = mapped_column(String(16), nullable=False)
    discount_value: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False, server_default=text("0"))
    discount_amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, server_default=text("0"))
    total_amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    payment_method: Mapped[str] = mapped_column(String(16), nullable=False)
    customer_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    customer_phone: Mapped[str | None] = mapped_column(String(32), nullable=True)
    sold_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    processed_by: Mapped[int] = mapped_column(BIGINT(unsigned=True), ForeignKey("users.user_id", onupdate="CASCADE", ondelete="RESTRICT"), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, server_default=text("'completed'"))
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"), server_onupdate=func.current_timestamp())


class SalesTransactionItem(Base):
    __tablename__ = "sales_transaction_items"
    __table_args__ = (
        CheckConstraint("quantity > 0 AND unit_price >= 0 AND line_subtotal >= 0 AND discount_amount >= 0 AND line_total >= 0", name="ck_sales_transaction_items_values"),
    )

    sale_item_id: Mapped[int] = mapped_column(BIGINT(unsigned=True).with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    sale_transaction_id: Mapped[int] = mapped_column(BIGINT(unsigned=True), ForeignKey("sales_transactions.sale_transaction_id", onupdate="CASCADE", ondelete="CASCADE"), nullable=False, index=True)
    product_id: Mapped[int] = mapped_column(BIGINT(unsigned=True), ForeignKey("products.product_id", onupdate="CASCADE", ondelete="RESTRICT"), nullable=False, index=True)
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)
    unit_price: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    line_subtotal: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    discount_amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    line_total: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)


class SalesTransactionBatch(Base):
    __tablename__ = "sales_transaction_batches"
    __table_args__ = (
        CheckConstraint("quantity_allocated > 0", name="ck_sales_transaction_batches_quantity"),
        UniqueConstraint("sale_item_id", "batch_id", name="uq_sales_transaction_batch_item"),
    )

    allocation_id: Mapped[int] = mapped_column(BIGINT(unsigned=True).with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    sale_item_id: Mapped[int] = mapped_column(BIGINT(unsigned=True), ForeignKey("sales_transaction_items.sale_item_id", onupdate="CASCADE", ondelete="CASCADE"), nullable=False, index=True)
    batch_id: Mapped[int] = mapped_column(BIGINT(unsigned=True), ForeignKey("inventory_batches.batch_id", onupdate="CASCADE", ondelete="RESTRICT"), nullable=False, index=True)
    product_id: Mapped[int] = mapped_column(BIGINT(unsigned=True), ForeignKey("products.product_id", onupdate="CASCADE", ondelete="RESTRICT"), nullable=False, index=True)
    quantity_allocated: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)
