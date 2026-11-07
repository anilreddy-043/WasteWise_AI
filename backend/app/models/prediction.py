from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Date, DateTime, ForeignKey, Integer, Numeric, String, func, text
from sqlalchemy.dialects.mysql import BIGINT, JSON
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class DemandForecast(Base):
    __tablename__ = "demand_forecasts"

    forecast_id: Mapped[int] = mapped_column(
        BIGINT(unsigned=True).with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True
    )
    product_id: Mapped[int] = mapped_column(
        BIGINT(unsigned=True), ForeignKey("products.product_id", ondelete="RESTRICT", onupdate="CASCADE"), nullable=False
    )
    forecast_date: Mapped[date] = mapped_column(Date, nullable=False)
    predicted_demand: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)
    lower_bound: Mapped[Decimal | None] = mapped_column(Numeric(12, 3))
    upper_bound: Mapped[Decimal | None] = mapped_column(Numeric(12, 3))
    model_version: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))


class Recommendation(Base):
    __tablename__ = "recommendations"

    recommendation_id: Mapped[int] = mapped_column(
        BIGINT(unsigned=True).with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True
    )
    product_id: Mapped[int] = mapped_column(
        BIGINT(unsigned=True), ForeignKey("products.product_id", ondelete="RESTRICT", onupdate="CASCADE"), nullable=False
    )
    batch_id: Mapped[int | None] = mapped_column(
        BIGINT(unsigned=True), ForeignKey("inventory_batches.batch_id", ondelete="SET NULL", onupdate="CASCADE")
    )
    recommendation_type: Mapped[str] = mapped_column(String(16), nullable=False)
    recommended_quantity: Mapped[Decimal | None] = mapped_column(Numeric(12, 3))
    discount_percent: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    reason: Mapped[str] = mapped_column(String(500), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, server_default=text("'pending'"))
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        nullable=False,
        server_default=text("CURRENT_TIMESTAMP"),
        server_onupdate=func.current_timestamp(),
    )
    applied_by: Mapped[int | None] = mapped_column(
        BIGINT(unsigned=True), ForeignKey("users.user_id", ondelete="SET NULL", onupdate="CASCADE")
    )
    applied_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class ExpiryRiskPrediction(Base):
    __tablename__ = "expiry_risk_predictions"

    prediction_id: Mapped[int] = mapped_column(BIGINT(unsigned=True).with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    batch_id: Mapped[int] = mapped_column(BIGINT(unsigned=True), ForeignKey("inventory_batches.batch_id", ondelete="CASCADE", onupdate="CASCADE"), nullable=False)
    predicted_class: Mapped[int] = mapped_column(Integer, nullable=False)
    risk_probability: Mapped[Decimal] = mapped_column(Numeric(8, 6), nullable=False)
    model_version: Mapped[str] = mapped_column(String(64), nullable=False)
    predicted_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))


class ModelMetric(Base):
    __tablename__ = "model_metrics"

    metric_id: Mapped[int] = mapped_column(
        BIGINT(unsigned=True).with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True
    )
    model_name: Mapped[str] = mapped_column(String(120), nullable=False)
    model_version: Mapped[str] = mapped_column(String(64), nullable=False)
    evaluated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    mae: Mapped[Decimal | None] = mapped_column(Numeric(14, 6))
    rmse: Mapped[Decimal | None] = mapped_column(Numeric(14, 6))
    r2_score: Mapped[Decimal | None] = mapped_column(Numeric(8, 6))
    sample_size: Mapped[int] = mapped_column(BIGINT(unsigned=True), nullable=False, server_default=text("0"))
    metrics_json: Mapped[dict | None] = mapped_column(JSON)