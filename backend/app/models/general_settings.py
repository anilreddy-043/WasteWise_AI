from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, String, func, text
from sqlalchemy.dialects.mysql import BIGINT
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class UserGeneralSettings(Base):
    __tablename__ = "user_general_settings"
    __table_args__ = (
        CheckConstraint(
            "items_per_page IN (10, 20, 50, 100)",
            name="ck_user_general_settings_items_per_page",
        ),
    )

    user_id: Mapped[int] = mapped_column(
        BIGINT(unsigned=True).with_variant(Integer, "sqlite"),
        ForeignKey("users.user_id", ondelete="CASCADE", onupdate="CASCADE"),
        primary_key=True,
    )
    application_name: Mapped[str] = mapped_column(
        String(120), nullable=False, server_default=text("'WasteWise AI'")
    )
    timezone: Mapped[str] = mapped_column(
        String(64), nullable=False, server_default=text("'Asia/Kolkata'")
    )
    date_format: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default=text("'DD MMM YYYY'")
    )
    language: Mapped[str] = mapped_column(
        String(5), nullable=False, server_default=text("'en'")
    )
    items_per_page: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default=text("10")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
        server_onupdate=func.current_timestamp(),
    )
