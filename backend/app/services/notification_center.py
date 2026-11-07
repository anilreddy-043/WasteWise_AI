from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Literal
from zoneinfo import ZoneInfo

from sqlalchemy import func, inspect, select
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.models import (
    DemandForecast,
    InventoryBatch,
    Product,
    User,
    UserActivity,
    UserGeneralSettings,
    UserNotification,
    UserNotificationSettings,
)
from app.services.model_artifacts import load_model_artifact

logger = logging.getLogger(__name__)
Category = Literal["expiry", "inventory", "demand", "import", "system"]
Priority = Literal["low", "medium", "high", "critical"]
MANAGER_CATEGORIES = ("expiry", "inventory", "demand")
DEFAULT_REORDER_LEVEL = Decimal("10")
MAX_GENERATED_EVENTS = 100


@dataclass(frozen=True)
class NotificationEvent:
    event_key: str
    title: str
    description: str
    category: Category
    priority: Priority
    occurred_at: datetime


def _utc_naive(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def _local_now(timezone_name: str) -> datetime:
    try:
        zone = ZoneInfo(timezone_name)
    except (ValueError, KeyError) as exc:
        raise ValueError("The user's configured timezone is invalid.") from exc
    return datetime.now(timezone.utc).astimezone(zone)


def _settings_for_user(db: Session, user_id: int) -> tuple[dict[str, bool], str]:
    settings = db.get(UserNotificationSettings, user_id)
    preferences = {
        "expiry_alerts": True,
        "low_stock_alerts": True,
        "high_demand_alerts": True,
        "daily_reports": False,
        "weekly_insights": True,
        "system_notifications": True,
    }
    if settings is not None:
        preferences.update({
            name: bool(getattr(settings, name))
            for name in preferences
        })

    if inspect(db.get_bind()).has_table(UserGeneralSettings.__tablename__):
        general = db.get(UserGeneralSettings, user_id)
        timezone_name = general.timezone if general is not None else "Asia/Kolkata"
    else:
        timezone_name = "Asia/Kolkata"
    return preferences, timezone_name


def _inventory_events(db: Session, today: date, now: datetime, preferences: dict[str, bool]) -> list[NotificationEvent]:
    events: list[NotificationEvent] = []
    if preferences["expiry_alerts"]:
        rows = db.execute(
            select(
                InventoryBatch.batch_id,
                InventoryBatch.batch_code,
                InventoryBatch.expiry_date,
                InventoryBatch.quantity_remaining,
                Product.name,
                Product.unit,
            )
            .join(Product, Product.product_id == InventoryBatch.product_id)
            .where(
                InventoryBatch.quantity_remaining > 0,
                InventoryBatch.status.in_(("active", "expired")),
                InventoryBatch.expiry_date <= today + timedelta(days=14),
            )
            .order_by(InventoryBatch.expiry_date, InventoryBatch.batch_id)
            .limit(MAX_GENERATED_EVENTS)
        ).all()
        for batch_id, batch_code, expiry_date, quantity, product_name, unit in rows:
            days_left = (expiry_date - today).days
            category: Category = "expiry"
            if days_left < 0:
                title = "Inventory batch has expired"
                priority: Priority = "critical"
                description = f"{product_name}, batch {batch_code}, expired on {expiry_date.isoformat()} with {quantity:g} {unit} remaining."
            elif days_left <= 3:
                title = "Product nearing expiry"
                priority = "high"
                description = f"{product_name}, batch {batch_code}, expires in {days_left} day(s); {quantity:g} {unit} remain."
            elif days_left <= 7:
                title = "Expiry approaching"
                priority = "medium"
                description = f"{product_name}, batch {batch_code}, expires in {days_left} day(s); {quantity:g} {unit} remain."
            else:
                title = "Upcoming expiry"
                priority = "low"
                description = f"{product_name}, batch {batch_code}, expires in {days_left} day(s); {quantity:g} {unit} remain."
            events.append(NotificationEvent(
                event_key=f"expiry:batch:{batch_id}:{expiry_date.isoformat()}",
                title=title,
                description=description[:500],
                category=category,
                priority=priority,
                occurred_at=_utc_naive(now),
            ))

    if preferences["low_stock_alerts"]:
        inventory_changes = db.execute(
            select(
                UserActivity.activity_id,
                UserActivity.action,
                UserActivity.entity_id,
                UserActivity.created_at,
            )
            .where(
                UserActivity.action.in_(("batch_created", "batch_updated", "batch_deleted")),
                UserActivity.created_at >= _utc_naive(now - timedelta(days=7)),
            )
            .order_by(UserActivity.activity_id.desc())
            .limit(MAX_GENERATED_EVENTS)
        ).all()
        change_titles = {
            "batch_created": "Inventory batch added",
            "batch_updated": "Inventory batch updated",
            "batch_deleted": "Inventory batch removed",
        }
        change_verbs = {
            "batch_created": "created",
            "batch_updated": "updated",
            "batch_deleted": "deleted",
        }
        for activity_id, action, batch_id, created_at in inventory_changes:
            batch_label = f" #{batch_id}" if batch_id is not None else ""
            events.append(NotificationEvent(
                event_key=f"inventory:activity:{activity_id}",
                title=change_titles[action],
                description=f"Inventory batch{batch_label} was {change_verbs[action]} by a store user.",
                category="inventory",
                priority="medium",
                occurred_at=_utc_naive(created_at),
            ))

        stock = func.coalesce(func.sum(InventoryBatch.quantity_remaining), 0)
        rows = db.execute(
            select(Product.product_id, Product.name, Product.unit, stock)
            .outerjoin(
                InventoryBatch,
                (InventoryBatch.product_id == Product.product_id)
                & (InventoryBatch.status == "active")
                & (InventoryBatch.quantity_remaining > 0)
                & (InventoryBatch.expiry_date >= today),
            )
            .group_by(Product.product_id, Product.name, Product.unit)
            .having(stock <= DEFAULT_REORDER_LEVEL)
            .order_by(stock, Product.name)
            .limit(MAX_GENERATED_EVENTS)
        ).all()
        for product_id, name, unit, quantity in rows:
            events.append(NotificationEvent(
                event_key=f"low-stock:product:{product_id}:{today.isoformat()}",
                title="Low stock",
                description=f"{name} has {quantity:g} {unit} available; the reorder threshold is {DEFAULT_REORDER_LEVEL:g}.",
                category="inventory",
                priority="high" if quantity <= 0 else "medium",
                occurred_at=_utc_naive(now),
            ))

    return events


def _high_demand_events(
    db: Session,
    today: date,
    now: datetime,
    preferences: dict[str, bool],
) -> list[NotificationEvent]:
    if not preferences["high_demand_alerts"]:
        return []

    stock = func.coalesce(func.sum(InventoryBatch.quantity_remaining), 0)
    rows = db.execute(
        select(
            DemandForecast.forecast_id,
            DemandForecast.product_id,
            DemandForecast.forecast_date,
            DemandForecast.predicted_demand,
            Product.name,
            Product.unit,
            stock,
        )
        .join(Product, Product.product_id == DemandForecast.product_id)
        .outerjoin(
            InventoryBatch,
            (InventoryBatch.product_id == Product.product_id)
            & (InventoryBatch.status == "active")
            & (InventoryBatch.quantity_remaining > 0)
            & (InventoryBatch.expiry_date >= today),
        )
        .where(DemandForecast.forecast_date >= today)
        .group_by(
            DemandForecast.forecast_id,
            DemandForecast.product_id,
            DemandForecast.forecast_date,
            DemandForecast.predicted_demand,
            Product.name,
            Product.unit,
        )
        .having(DemandForecast.predicted_demand > stock)
        .order_by(DemandForecast.forecast_date, DemandForecast.forecast_id.desc())
        .limit(MAX_GENERATED_EVENTS)
    ).all()
    latest_product_ids: set[int] = set()
    events: list[NotificationEvent] = []
    for forecast_id, product_id, forecast_date, predicted, name, unit, quantity in rows:
        if product_id in latest_product_ids:
            continue
        latest_product_ids.add(product_id)
        events.append(NotificationEvent(
            event_key=f"high-demand:forecast:{forecast_id}",
            title="Forecasted demand exceeds stock",
            description=f"{name} is forecast to need {predicted:g} {unit} on {forecast_date.isoformat()}, with {quantity:g} {unit} currently available.",
            category="demand",
            priority="high",
            occurred_at=_utc_naive(now),
        ))
    return events


def _import_events(db: Session, preferences: dict[str, bool], is_admin: bool) -> list[NotificationEvent]:
    if not is_admin or not preferences["system_notifications"]:
        return []
    rows = db.execute(
        select(
            UserActivity.activity_id,
            UserActivity.action,
            UserActivity.entity_type,
            UserActivity.details,
            UserActivity.created_at,
        )
        .where(UserActivity.action.in_(("data_csv_imported", "batch_csv_imported", "data_import_failed")))
        .order_by(UserActivity.activity_id.desc())
        .limit(MAX_GENERATED_EVENTS)
    ).all()
    events = []
    for activity_id, action, dataset, details, created_at in rows:
        failed = action == "data_import_failed"
        detail = details if isinstance(details, dict) else {}
        dataset_name = str(detail.get("dataset") or dataset).replace("_", " ")
        if failed:
            title = "Data import failed"
            description = f"The {dataset_name} CSV import failed. Review the Data & Backup section for details."
            priority: Priority = "high"
        else:
            title = "Data import completed"
            success_count = detail.get("successful_records", detail.get("inserted"))
            description = (
                f"The {dataset_name} CSV import completed with {success_count} successful record(s)."
                if isinstance(success_count, int)
                else f"The {dataset_name} CSV import completed."
            )
            priority = "low"
        events.append(NotificationEvent(
            event_key=f"import:activity:{activity_id}",
            title=title,
            description=description[:500],
            category="import",
            priority=priority,
            occurred_at=_utc_naive(created_at),
        ))
    return events


def _system_events(db: Session, preferences: dict[str, bool], is_admin: bool) -> list[NotificationEvent]:
    if not is_admin or not preferences["system_notifications"]:
        return []
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    failed_services: list[tuple[str, str]] = []
    try:
        db.execute(select(1)).scalar_one()
    except SQLAlchemyError as exc:
        logger.warning("Notification center database probe failed (%s).", type(exc).__name__)
        failed_services.append(("database", type(exc).__name__))
        db.rollback()

    for model_key, artifact_name in (
        ("demand_forecast", "demand_forecast.joblib"),
        ("discount_recommendation", "discount_recommendation.joblib"),
        ("expiry_risk", "expiry_risk.joblib"),
    ):
        try:
            load_model_artifact(model_key)
        except Exception as exc:
            logger.warning("Notification center model probe failed for %s (%s).", model_key, type(exc).__name__)
            failed_services.append((artifact_name, type(exc).__name__))

    return [
        NotificationEvent(
            event_key=f"system:{service}:unavailable:{now.date().isoformat()}",
            title="System service unavailable",
            description=f"{service} is currently unavailable ({error_name}).",
            category="system",
            priority="critical" if service == "database" else "high",
            occurred_at=now,
        )
        for service, error_name in failed_services
    ]


def _persist_events(db: Session, user_id: int, events: list[NotificationEvent]) -> None:
    if not events:
        return
    values = [
        {
            "user_id": user_id,
            "event_key": event.event_key,
            "title": event.title,
            "description": event.description,
            "category": event.category,
            "priority": event.priority,
            "occurred_at": event.occurred_at,
        }
        for event in events
    ]
    dialect = db.get_bind().dialect.name
    if dialect == "mysql":
        statement = mysql_insert(UserNotification).values(values)
        statement = statement.on_duplicate_key_update(event_key=statement.inserted.event_key)
    elif dialect == "sqlite":
        statement = sqlite_insert(UserNotification).values(values).on_conflict_do_nothing(
            index_elements=["user_id", "event_key"]
        )
    else:
        raise RuntimeError(f"Notification deduplication is unsupported for database dialect {dialect}.")
    db.execute(statement)


def synchronize_notifications(db: Session, user: User) -> tuple[dict[str, bool], str]:
    preferences, timezone_name = _settings_for_user(db, user.user_id)
    now = _local_now(timezone_name)
    events = _inventory_events(db, now.date(), now, preferences)
    events.extend(_high_demand_events(db, now.date(), now, preferences))
    events.extend(_import_events(db, preferences, user.role == "admin"))
    events.extend(_system_events(db, preferences, user.role == "admin"))
    if user.role != "admin":
        events = [event for event in events if event.category in MANAGER_CATEGORIES]
    _persist_events(db, user.user_id, events)
    db.commit()
    return preferences, timezone_name


def visible_categories(user: User) -> tuple[str, ...]:
    return ("expiry", "inventory", "demand", "import", "system") if user.role == "admin" else MANAGER_CATEGORIES
