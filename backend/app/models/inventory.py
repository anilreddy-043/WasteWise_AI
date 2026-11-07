from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Date, DateTime, ForeignKey, Integer, Numeric, String, func, literal, text
from sqlalchemy.dialects.mysql import BIGINT
from sqlalchemy.orm import Mapped, column_property, mapped_column

from app.db.base import Base


class InventoryBatch(Base):
    __tablename__ = "inventory_batches"

    batch_id: Mapped[int] = mapped_column(
        BIGINT(unsigned=True).with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True
    )
    product_id: Mapped[int] = mapped_column(
        BIGINT(unsigned=True), ForeignKey("products.product_id", ondelete="RESTRICT", onupdate="CASCADE"), nullable=False
    )
    batch_code: Mapped[str] = mapped_column(String(64), nullable=False)
    quantity_received: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)
    quantity_remaining: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)
    unit_cost: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False, server_default=text("0"))
    received_at: Mapped[date] = mapped_column(Date, nullable=False)
    expiry_date: Mapped[date] = mapped_column(Date, nullable=False)
    expiry_date_source: Mapped[str | None] = mapped_column(String(32), nullable=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, server_default=text("'active'"))
    location: Mapped[str] = mapped_column(String(120), nullable=False, server_default=text("'Unassigned'"))
    supplier: Mapped[str | None] = mapped_column(String(160), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
        server_onupdate=func.current_timestamp(),
    )
