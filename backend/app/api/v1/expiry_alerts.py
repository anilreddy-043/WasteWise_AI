import csv
import io
import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from fastapi.responses import StreamingResponse
from openpyxl import Workbook
from sqlalchemy import case, func, inspect, literal, or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_admin, require_roles
from app.db.session import get_db
from app.models import InventoryBatch, Product, User, UserActivity
from app.schemas.expiry_alerts import (
    ExpiryAlertItem,
    ExpiryAlertPage,
    ExpiryAlertRule,
    ExpiryAlertRuleCreate,
    ExpiryAlertRuleUpdate,
    ExpiryAlertSummary,
    ExpiryRisk,
)

router = APIRouter(prefix="/expiry-alerts", tags=["expiry-alerts"])
logger = logging.getLogger(__name__)
_RISK_ORDER: tuple[ExpiryRisk, ...] = ("expired", "high", "medium", "low", "safe")
_EXPORT_COLUMNS = (
    "Product", "SKU", "Batch ID", "Batch", "Category", "Expiry Date", "Expiry Date Basis", "Days Left",
    "Quantity", "Unit", "Risk", "Suggested Action", "Location", "Supplier",
)


@dataclass(frozen=True)
class ExpiryAlertBatchData:
    batch_id: int
    product_id: int
    batch_code: str
    expiry_date: date
    expiry_date_source: str | None
    received_at: date
    quantity_remaining: Decimal
    status: str
    location: str
    supplier: str | None


def _risk_for_days(days: int) -> ExpiryRisk:
    if days < 0:
        return "expired"
    if days <= 3:
        return "high"
    if days <= 7:
        return "medium"
    if days <= 14:
        return "low"
    return "safe"


def _suggested_action(risk: ExpiryRisk) -> str:
    return {
        "expired": "Remove from sale and verify disposal",
        "high": "Review batch immediately; consider markdown",
        "medium": "Prioritize sale or meal preparation",
        "low": "Monitor stock rotation",
        "safe": "No action needed",
    }[risk]


def _risk_date_filter(risk: ExpiryRisk, today: date):
    expiry_date = InventoryBatch.expiry_date
    if risk == "expired":
        return expiry_date < today
    if risk == "high":
        return expiry_date.between(today, today + timedelta(days=3))
    if risk == "medium":
        return expiry_date.between(today + timedelta(days=4), today + timedelta(days=7))
    if risk == "low":
        return expiry_date.between(today + timedelta(days=8), today + timedelta(days=14))
    return expiry_date > today + timedelta(days=14)


def _batch_columns(db: Session):
    batch_columns = {
        column["name"] for column in inspect(db.get_bind()).get_columns(InventoryBatch.__tablename__)
    }
    return (
        InventoryBatch.batch_id,
        InventoryBatch.product_id,
        InventoryBatch.batch_code,
        InventoryBatch.expiry_date,
        InventoryBatch.expiry_date_source
        if "expiry_date_source" in batch_columns
        else literal(None).label("expiry_date_source"),
        InventoryBatch.received_at,
        InventoryBatch.quantity_remaining,
        InventoryBatch.status,
        InventoryBatch.location,
        InventoryBatch.supplier,
    )


def _base_query(db: Session):
    return (
        select(*_batch_columns(db), Product)
        .join(Product, Product.product_id == InventoryBatch.product_id)
        .where(
            InventoryBatch.quantity_remaining > 0,
            InventoryBatch.status.in_(("active", "expired")),
        )
    )


def _filter_conditions(
    *,
    today: date,
    search: str | None = None,
    category: str | None = None,
    risk: ExpiryRisk | None = None,
    location: str | None = None,
    supplier: str | None = None,
    batch_ids: list[int] | None = None,
) -> list[object]:
    conditions: list[object] = [
        InventoryBatch.quantity_remaining > 0,
        InventoryBatch.status.in_(("active", "expired")),
    ]
    supplier_value = func.coalesce(InventoryBatch.supplier, Product.supplier)
    if search and search.strip():
        needle = f"%{search.strip()}%"
        conditions.append(or_(
            Product.name.ilike(needle),
            Product.sku.ilike(needle),
            Product.category.ilike(needle),
            InventoryBatch.batch_code.ilike(needle),
            InventoryBatch.location.ilike(needle),
            supplier_value.ilike(needle),
        ))
    if category:
        conditions.append(Product.category == category)
    if risk:
        conditions.append(_risk_date_filter(risk, today))
    if location:
        conditions.append(InventoryBatch.location == location)
    if supplier:
        conditions.append(supplier_value == supplier)
    if batch_ids:
        conditions.append(InventoryBatch.batch_id.in_(batch_ids))
    return conditions


def _filtered_query(
    db: Session,
    *,
    today: date,
    search: str | None = None,
    category: str | None = None,
    risk: ExpiryRisk | None = None,
    location: str | None = None,
    supplier: str | None = None,
    batch_ids: list[int] | None = None,
):
    return (
        select(*_batch_columns(db), Product)
        .join(Product, Product.product_id == InventoryBatch.product_id)
        .where(*_filter_conditions(
            today=today, search=search, category=category, risk=risk,
            location=location, supplier=supplier, batch_ids=batch_ids,
        ))
    )


def _item(batch: InventoryBatch | ExpiryAlertBatchData, product: Product, today: date) -> ExpiryAlertItem:
    days = (batch.expiry_date - today).days
    risk = _risk_for_days(days)
    return ExpiryAlertItem(
        batch_id=batch.batch_id,
        product_id=product.product_id,
        product_name=product.name,
        sku=product.sku,
        category=product.category,
        batch_code=batch.batch_code,
        expiry_date=batch.expiry_date,
        expiry_date_source=batch.expiry_date_source,
        received_at=batch.received_at,
        days_to_expiry=days,
        quantity_remaining=float(batch.quantity_remaining),
        unit=product.unit,
        status="expired" if days < 0 else "active",
        risk=risk,
        suggested_action=_suggested_action(risk),
        location=batch.location,
        supplier=batch.supplier or product.supplier,
    )


def _summary_from_query(
    db: Session,
    *,
    today: date,
    search: str | None = None,
    category: str | None = None,
    risk: ExpiryRisk | None = None,
    location: str | None = None,
    supplier: str | None = None,
) -> ExpiryAlertSummary:
    expiry_date = InventoryBatch.expiry_date
    risk_conditions = (
        expiry_date < today,
        expiry_date.between(today, today + timedelta(days=3)),
        expiry_date.between(today + timedelta(days=4), today + timedelta(days=7)),
        expiry_date.between(today + timedelta(days=8), today + timedelta(days=14)),
        expiry_date > today + timedelta(days=14),
    )
    statement = (
        select(
            func.count(InventoryBatch.batch_id),
            *(
                func.coalesce(func.sum(case((condition, 1), else_=0)), 0)
                for condition in risk_conditions
            ),
        )
        .select_from(InventoryBatch)
        .join(Product, Product.product_id == InventoryBatch.product_id)
        .where(*_filter_conditions(
            today=today, search=search, category=category, risk=risk,
            location=location, supplier=supplier,
        ))
    )
    row = db.execute(statement).one()
    risk_counts = {risk_name: int(row[index + 1] or 0) for index, risk_name in enumerate(_RISK_ORDER)}
    return ExpiryAlertSummary(
        total_batches=int(row[0] or 0),
        expired=risk_counts["expired"],
        high=risk_counts["high"],
        medium=risk_counts["medium"],
        low=risk_counts["low"],
        safe=risk_counts["safe"],
        risk_counts=risk_counts,
    )


def _query_items(
    db: Session,
    *,
    today: date,
    search: str | None = None,
    category: str | None = None,
    risk: ExpiryRisk | None = None,
    location: str | None = None,
    supplier: str | None = None,
    batch_ids: list[int] | None = None,
) -> list[ExpiryAlertItem]:
    rows = db.execute(_filtered_query(
        db,
        today=today, search=search, category=category, risk=risk, location=location,
        supplier=supplier, batch_ids=batch_ids,
    ).order_by(InventoryBatch.expiry_date, InventoryBatch.batch_id)).all()
    return [_item(ExpiryAlertBatchData(*row[:-1]), row[-1], today) for row in rows]


def _chart_data(
    db: Session,
    *,
    today: date,
    search: str | None = None,
    category: str | None = None,
    risk: ExpiryRisk | None = None,
    location: str | None = None,
    supplier: str | None = None,
) -> dict[str, object]:
    summary = _summary_from_query(
        db, today=today, search=search, category=category, risk=risk,
        location=location, supplier=supplier,
    )
    bin_counts = {
        "0-3": summary.high,
        "4-7": summary.medium,
        "8-14": summary.low,
    }
    categories = db.execute(
        select(Product.category, func.count(InventoryBatch.batch_id))
        .select_from(InventoryBatch)
        .join(Product, Product.product_id == InventoryBatch.product_id)
        .where(
            *_filter_conditions(
                today=today, search=search, category=category, risk=risk,
                location=location, supplier=supplier,
            ),
            InventoryBatch.expiry_date.between(today, today + timedelta(days=14)),
        )
        .group_by(Product.category)
        .order_by(func.count(InventoryBatch.batch_id).desc(), Product.category)
        .limit(6)
    ).all()
    return {
        "risk_distribution": [
            {"risk": risk, "count": summary.risk_counts[risk]}
            for risk in _RISK_ORDER
        ],
        "expiring_next_14_days": [
            {"range": days, "count": count}
            for days, count in bin_counts.items()
        ],
        "top_categories": [
            {"category": category, "count": count}
            for category, count in categories
        ],
    }


def _validate_filter_values(
    category: str | None,
    location: str | None,
    supplier: str | None,
) -> None:
    if any(value is not None and not value.strip() for value in (category, location, supplier)):
        raise HTTPException(status_code=422, detail="Category, location, and supplier filters cannot be blank.")


def _read_items(
    db: Session,
    *,
    today: date,
    search: str | None = None,
    category: str | None = None,
    risk: ExpiryRisk | None = None,
    location: str | None = None,
    supplier: str | None = None,
    batch_ids: list[int] | None = None,
) -> list[ExpiryAlertItem]:
    _validate_filter_values(category, location, supplier)
    return _query_items(
        db, today=today, search=search, category=category, risk=risk, location=location,
        supplier=supplier, batch_ids=batch_ids,
    )


def _filters(db: Session) -> dict[str, list[str]]:
    where = (
        InventoryBatch.quantity_remaining > 0,
        InventoryBatch.status.in_(("active", "expired")),
    )
    join_on = Product.product_id == InventoryBatch.product_id
    return {
        "categories": list(db.scalars(
            select(Product.category).join(InventoryBatch, join_on).where(*where).distinct().order_by(Product.category)
        ).all()),
        "locations": list(db.scalars(
            select(InventoryBatch.location).join(Product, join_on).where(*where).distinct().order_by(InventoryBatch.location)
        ).all()),
        "suppliers": list(db.scalars(
            select(func.coalesce(InventoryBatch.supplier, Product.supplier))
            .join(Product, join_on).where(*where)
            .distinct().order_by(func.coalesce(InventoryBatch.supplier, Product.supplier))
        ).all()),
    }


def _load_rules(db: Session) -> list[ExpiryAlertRule]:
    events = db.scalars(
        select(UserActivity)
        .where(
            UserActivity.entity_type == "expiry_alert_rule",
            UserActivity.action.in_((
                "expiry_alert_rule_created",
                "expiry_alert_rule_updated",
                "expiry_alert_rule_deleted",
            )),
        )
        .order_by(UserActivity.activity_id)
    ).all()
    latest: dict[int, UserActivity] = {}
    for event in events:
        if event.entity_id is not None:
            latest[event.entity_id] = event
    rules: list[ExpiryAlertRule] = []
    for rule_id, event in latest.items():
        details = event.details or {}
        if event.action == "expiry_alert_rule_deleted":
            continue
        rules.append(ExpiryAlertRule(
            rule_id=rule_id,
            name=details["name"],
            days_before_expiry=details["days_before_expiry"],
            risk_level=details.get("risk_level"),
            category=details.get("category"),
            location=details.get("location"),
            supplier=details.get("supplier"),
            enabled=details.get("enabled", True),
            created_by=details["created_by"],
            created_at=datetime.fromisoformat(details["created_at"]),
            updated_at=datetime.fromisoformat(details["updated_at"]),
        ))
    return sorted(rules, key=lambda rule: (rule.created_at, rule.rule_id), reverse=True)


def _append_rule_event(
    db: Session,
    user: User,
    *,
    action: Literal["created", "updated", "deleted"],
    rule_id: int | None,
    values: dict[str, object],
) -> UserActivity:
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    details = {**values, "updated_at": now.isoformat()}
    if action == "created":
        details["created_at"] = now.isoformat()
    event = UserActivity(
        user_id=user.user_id,
        action=f"expiry_alert_rule_{action}",
        entity_type="expiry_alert_rule",
        entity_id=rule_id,
        details=details,
        created_at=now,
    )
    db.add(event)
    db.flush()
    if rule_id is None:
        rule_id = event.activity_id
        event.entity_id = rule_id
    db.commit()
    db.refresh(event)
    return event


def _rule_from_event(rule_id: int, event: UserActivity) -> ExpiryAlertRule:
    details = event.details or {}
    return ExpiryAlertRule(
        rule_id=rule_id,
        name=details["name"],
        days_before_expiry=details["days_before_expiry"],
        risk_level=details.get("risk_level"),
        category=details.get("category"),
        location=details.get("location"),
        supplier=details.get("supplier"),
        enabled=details.get("enabled", True),
        created_by=details["created_by"],
        created_at=datetime.fromisoformat(details["created_at"]),
        updated_at=datetime.fromisoformat(details["updated_at"]),
    )


@router.get("", response_model=ExpiryAlertPage)
def list_expiry_alerts(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    search: str | None = Query(default=None, max_length=160),
    category: str | None = Query(default=None, max_length=80),
    risk: ExpiryRisk | None = None,
    location: str | None = Query(default=None, max_length=120),
    supplier: str | None = Query(default=None, max_length=160),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=10, ge=1, le=100),
) -> ExpiryAlertPage:
    today = date.today()
    start = (page - 1) * page_size
    rows = db.execute(_filtered_query(
        db,
        today=today, search=search, category=category, risk=risk, location=location, supplier=supplier,
    ).order_by(InventoryBatch.expiry_date, InventoryBatch.batch_id).offset(start).limit(page_size)).all()
    items = [_item(ExpiryAlertBatchData(*row[:-1]), row[-1], today) for row in rows]
    summary = _summary_from_query(
        db, today=today, search=search, category=category, risk=risk, location=location, supplier=supplier,
    )
    total = summary.total_batches
    return ExpiryAlertPage(
        items=items[start:start + page_size],
        total=total,
        page=page,
        page_size=page_size,
        total_pages=(total + page_size - 1) // page_size,
        summary=summary,
    )


@router.get("/summary", response_model=ExpiryAlertSummary)
def expiry_alert_summary(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ExpiryAlertSummary:
    return _summary_from_query(db, today=date.today())


@router.get("/charts")
def expiry_alert_charts(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    category: str | None = Query(default=None, max_length=80),
    risk: ExpiryRisk | None = None,
    location: str | None = Query(default=None, max_length=120),
    supplier: str | None = Query(default=None, max_length=160),
    search: str | None = Query(default=None, max_length=160),
) -> dict[str, object]:
    return _chart_data(
        db, today=date.today(), search=search, category=category, risk=risk, location=location, supplier=supplier,
    )


@router.get("/filters")
def expiry_alert_filters(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, list[str]]:
    return _filters(db)


@router.get("/batches/{batch_id}", response_model=ExpiryAlertItem)
def expiry_alert_batch_detail(
    batch_id: int,
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ExpiryAlertItem:
    row = db.execute(
        _base_query(db).where(InventoryBatch.batch_id == batch_id)
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Inventory batch not found or has no remaining stock.")
    return _item(ExpiryAlertBatchData(*row[:-1]), row[-1], date.today())


@router.get("/export")
def export_expiry_alerts(
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
    format: Literal["csv", "xlsx"] = "csv",
    search: str | None = Query(default=None, max_length=160),
    category: str | None = Query(default=None, max_length=80),
    risk: ExpiryRisk | None = None,
    location: str | None = Query(default=None, max_length=120),
    supplier: str | None = Query(default=None, max_length=160),
    batch_ids: list[int] | None = Query(default=None),
) -> StreamingResponse:
    items = _read_items(
        db, today=date.today(), search=search, category=category, risk=risk, location=location,
        supplier=supplier, batch_ids=batch_ids,
    )
    rows = [[
        item.product_name, item.sku, item.batch_id, item.batch_code, item.category, item.expiry_date.isoformat(),
        item.expiry_date_source or "unverified",
        item.days_to_expiry, item.quantity_remaining, item.unit, item.risk, item.suggested_action, item.location,
        item.supplier,
    ] for item in items]
    output = io.BytesIO()
    if format == "xlsx":
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = "Expiry Alerts"
        sheet.append(list(_EXPORT_COLUMNS))
        for row in rows:
            sheet.append(row)
            for cell, value in zip(sheet[sheet.max_row], row):
                if isinstance(value, str):
                    cell.data_type = "s"
        workbook.save(output)
        media_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        filename = "wastewise-expiry-alerts.xlsx"
    else:
        text_output = io.StringIO(newline="")
        writer = csv.writer(text_output)
        writer.writerow(_EXPORT_COLUMNS)
        for row in rows:
            writer.writerow([
                f"'{value}" if isinstance(value, str) and value.startswith(("=", "+", "-", "@")) else value
                for value in row
            ])
        output.write(text_output.getvalue().encode("utf-8-sig"))
        media_type = "text/csv; charset=utf-8"
        filename = "wastewise-expiry-alerts.csv"
    output.seek(0)
    db.add(
        UserActivity(
            user_id=user.user_id,
            action="data_exported",
            entity_type="expiry_alerts",
            details={"dataset": "expiry_alerts", "format": format, "record_count": len(rows)},
        )
    )
    try:
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("Could not record the expiry alert export activity.")
        raise HTTPException(status_code=503, detail="The export could not be audited and was not completed.") from exc
    return StreamingResponse(
        output,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/rules", response_model=list[ExpiryAlertRule])
def list_expiry_alert_rules(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ExpiryAlertRule]:
    return _load_rules(db)


@router.post("/rules", response_model=ExpiryAlertRule, status_code=status.HTTP_201_CREATED)
def create_expiry_alert_rule(
    payload: ExpiryAlertRuleCreate,
    user: User = Depends(require_roles("admin", "store_manager")),
    db: Session = Depends(get_db),
) -> ExpiryAlertRule:
    values = payload.model_dump()
    values["name"] = values["name"].strip()
    if not values["name"]:
        raise HTTPException(status_code=422, detail="Rule name cannot be blank.")
    values["created_by"] = user.user_id
    event = _append_rule_event(db, user, action="created", rule_id=None, values=values)
    return _rule_from_event(event.entity_id, event)


@router.patch("/rules/{rule_id}", response_model=ExpiryAlertRule)
def update_expiry_alert_rule(
    rule_id: int,
    payload: ExpiryAlertRuleUpdate,
    user: User = Depends(require_roles("admin", "store_manager")),
    db: Session = Depends(get_db),
) -> ExpiryAlertRule:
    current = next((rule for rule in _load_rules(db) if rule.rule_id == rule_id), None)
    if current is None:
        raise HTTPException(status_code=404, detail="Expiry alert rule not found.")
    values = current.model_dump(mode="json")
    values.update(payload.model_dump(exclude_unset=True))
    values["name"] = values["name"].strip()
    if not values["name"]:
        raise HTTPException(status_code=422, detail="Rule name cannot be blank.")
    values["created_by"] = current.created_by
    values["created_at"] = current.created_at.isoformat()
    event = _append_rule_event(db, user, action="updated", rule_id=rule_id, values=values)
    return _rule_from_event(rule_id, event)


@router.delete("/rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_expiry_alert_rule(
    rule_id: int,
    user: User = Depends(require_roles("admin", "store_manager")),
    db: Session = Depends(get_db),
) -> Response:
    current = next((rule for rule in _load_rules(db) if rule.rule_id == rule_id), None)
    if current is None:
        raise HTTPException(status_code=404, detail="Expiry alert rule not found.")
    values = current.model_dump(mode="json")
    values["enabled"] = False
    values["created_by"] = current.created_by
    values["created_at"] = current.created_at.isoformat()
    _append_rule_event(db, user, action="deleted", rule_id=rule_id, values=values)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
