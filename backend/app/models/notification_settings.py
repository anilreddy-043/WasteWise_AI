from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, func, text
from sqlalchemy.dialects.mysql import BIGINT
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class UserNotificationSettings(Base):
    __tablename__ = "user_notification_settings"

    user_id: Mapped[int] = mapped_column(
        BIGINT(unsigned=True).with_variant(Integer, "sqlite"),
        ForeignKey("users.user_id", ondelete="CASCADE", onupdate="CASCADE"),
        primary_key=True,
    )
    expiry_alerts: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("1"))
    low_stock_alerts: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("1"))
    high_demand_alerts: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("1"))
    daily_reports: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("0"))
    weekly_insights: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("1"))
    system_notifications: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("1"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
        server_onupdate=func.current_timestamp(),
    )
