from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Integer, String, func, text
from sqlalchemy.dialects.mysql import BIGINT
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

SINGLE_STORE_ID = 1


class StoreInformation(Base):
    __tablename__ = "store_information"
    __table_args__ = (
        CheckConstraint(f"store_id = {SINGLE_STORE_ID}", name="ck_store_information_singleton"),
    )

    store_id: Mapped[int] = mapped_column(
        BIGINT(unsigned=True).with_variant(Integer, "sqlite"),
        primary_key=True,
        default=1,
        server_default=text("1"),
    )
    store_name: Mapped[str] = mapped_column(
        String(160), nullable=False, default="", server_default=text("''")
    )
    store_address: Mapped[str] = mapped_column(
        String(255), nullable=False, default="", server_default=text("''")
    )
    contact_number: Mapped[str] = mapped_column(
        String(32), nullable=False, default="", server_default=text("''")
    )
    email: Mapped[str] = mapped_column(
        String(254), nullable=False, default="", server_default=text("''")
    )
    logo_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
        server_onupdate=func.current_timestamp(),
    )
