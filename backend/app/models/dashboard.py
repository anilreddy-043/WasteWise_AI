from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Date, DateTime, ForeignKey, Index, Integer, Numeric, String, UniqueConstraint, text
from sqlalchemy.dialects.mysql import BIGINT
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class DashboardImportRun(Base):
    __tablename__ = "dashboard_import_runs"

    import_run_id: Mapped[int] = mapped_column(BIGINT(unsigned=True).with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    source_file: Mapped[str] = mapped_column(String(255), nullable=False)
    source_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)
    rows_seen: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    rows_inserted: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    rows_skipped: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))

    __table_args__ = (Index("ix_dashboard_import_runs_source_started", "source_file", "started_at"),)


class DashboardImportRecord(Base):
    __tablename__ = "dashboard_import_records"

    import_record_id: Mapped[int] = mapped_column(BIGINT(unsigned=True).with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    source_file: Mapped[str] = mapped_column(String(255), nullable=False)
    source_record_key: Mapped[str] = mapped_column(String(255), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(32), nullable=False)
    entity_id: Mapped[int] = mapped_column(BIGINT(unsigned=True), nullable=False)
    import_run_id: Mapped[int] = mapped_column(
        BIGINT(unsigned=True), ForeignKey("dashboard_import_runs.import_run_id", ondelete="RESTRICT"), nullable=False
    )
    imported_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))

    __table_args__ = (
        UniqueConstraint("source_file", "source_record_key", "entity_type", name="uq_dashboard_import_source_record"),
        Index("ix_dashboard_import_entity", "entity_type", "entity_id"),
    )


class DashboardHistoricalMetric(Base):
    __tablename__ = "dashboard_historical_metrics"

    historical_metric_id: Mapped[int] = mapped_column(BIGINT(unsigned=True).with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True)
    source_file: Mapped[str] = mapped_column(String(255), nullable=False)
    source_record_key: Mapped[str] = mapped_column(String(255), nullable=False)
    source_run_id: Mapped[int] = mapped_column(
        BIGINT(unsigned=True), ForeignKey("dashboard_import_runs.import_run_id", ondelete="RESTRICT"), nullable=False
    )
    product_id: Mapped[int] = mapped_column(
        BIGINT(unsigned=True), ForeignKey("products.product_id", ondelete="RESTRICT", onupdate="CASCADE"), nullable=False
    )
    business_date: Mapped[date] = mapped_column(Date, nullable=False)
    sales_quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)
    sales_revenue: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    waste_quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)
    data_kind: Mapped[str] = mapped_column(String(32), nullable=False, server_default=text("'training_history'"))
    imported_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, server_default=text("CURRENT_TIMESTAMP"))

    __table_args__ = (
        UniqueConstraint("source_file", "source_record_key", name="uq_dashboard_history_source_record"),
        Index("ix_dashboard_history_date_product", "business_date", "product_id"),
    )