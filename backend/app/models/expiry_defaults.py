from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class CategoryShelfLifeSetting(Base):
    __tablename__ = "category_shelf_life_settings"

    category: Mapped[str] = mapped_column(String(80), primary_key=True)
    days: Mapped[int] = mapped_column(Integer, nullable=False)
    updated_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.user_id", ondelete="SET NULL", onupdate="CASCADE"),
        nullable=True,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
        server_onupdate=func.current_timestamp(),
    )
