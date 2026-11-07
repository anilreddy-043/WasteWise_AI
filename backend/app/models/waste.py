from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Integer, Numeric, String, text
from sqlalchemy.dialects.mysql import BIGINT, JSON
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


def _utc_now_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class WasteRecord(Base):
    __tablename__ = "waste_records"

    waste_id: Mapped[int] = mapped_column(
        BIGINT(unsigned=True).with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True
    )
    product_id: Mapped[int] = mapped_column(
        BIGINT(unsigned=True), ForeignKey("products.product_id", ondelete="RESTRICT", onupdate="CASCADE"), nullable=False
    )
    batch_id: Mapped[int | None] = mapped_column(
        BIGINT(unsigned=True), ForeignKey("inventory_batches.batch_id", ondelete="RESTRICT", onupdate="CASCADE")
    )
    recorded_by: Mapped[int | None] = mapped_column(
        BIGINT(unsigned=True), ForeignKey("users.user_id", ondelete="SET NULL", onupdate="CASCADE")
    )
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)
    reason: Mapped[str] = mapped_column(String(16), nullable=False)
    waste_cost: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, server_default=text("0"))
    recorded_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    notes: Mapped[str | None] = mapped_column(String(500))


class UserActivity(Base):
    __tablename__ = "user_activity"

    activity_id: Mapped[int] = mapped_column(
        BIGINT(unsigned=True).with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True
    )
    user_id: Mapped[int | None] = mapped_column(
        BIGINT(unsigned=True), ForeignKey("users.user_id", ondelete="SET NULL", onupdate="CASCADE")
    )
    action: Mapped[str] = mapped_column(String(80), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(80), nullable=False)
    entity_id: Mapped[int | None] = mapped_column(BIGINT(unsigned=True))
    details: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        default=_utc_now_naive,
        server_default=text("CURRENT_TIMESTAMP"),
    )
