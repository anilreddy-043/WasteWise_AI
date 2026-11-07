import logging
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.security import require_roles
from app.db.session import get_db
from app.models import User, UserNotification
from app.schemas.notifications import NotificationItem, NotificationPage, NotificationReadUpdate
from app.services.notification_center import synchronize_notifications, visible_categories

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/notifications", tags=["notifications"])


def _read_at() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _enabled_categories(user: User, preferences: dict[str, bool]) -> tuple[str, ...]:
    categories = []
    if preferences["expiry_alerts"]:
        categories.append("expiry")
    if preferences["low_stock_alerts"]:
        categories.append("inventory")
    if preferences["high_demand_alerts"]:
        categories.append("demand")
    if user.role == "admin" and preferences["system_notifications"]:
        categories.extend(("import", "system"))
    return tuple(category for category in visible_categories(user) if category in categories)


@router.get("", response_model=NotificationPage)
def list_notifications(
    category: Literal["expiry", "inventory", "demand", "import", "system"] | None = None,
    read_status: Literal["all", "read", "unread"] = Query(default="all"),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(require_roles("admin", "store_manager")),
    db: Session = Depends(get_db),
) -> NotificationPage:
    try:
        preferences, _ = synchronize_notifications(db, user)
        allowed = visible_categories(user)
        if category is not None and category not in allowed:
            raise HTTPException(status_code=403, detail="Your role cannot view this notification category.")

        enabled_categories = _enabled_categories(user, preferences)
        categories = (category,) if category in enabled_categories else () if category else enabled_categories
        category_conditions = [UserNotification.user_id == user.user_id]
        if not categories:
            category_conditions.append(UserNotification.notification_id == -1)
        else:
            category_conditions.append(UserNotification.category.in_(categories))
        conditions = list(category_conditions)
        if read_status == "read":
            conditions.append(UserNotification.read_at.is_not(None))
        elif read_status == "unread":
            conditions.append(UserNotification.read_at.is_(None))

        total = db.scalar(select(func.count()).select_from(UserNotification).where(*conditions)) or 0
        unread_count = db.scalar(
            select(func.count()).select_from(UserNotification).where(
                *category_conditions,
                UserNotification.read_at.is_(None),
            )
        ) or 0
        read_count = db.scalar(
            select(func.count()).select_from(UserNotification).where(
                *category_conditions,
                UserNotification.read_at.is_not(None),
            )
        ) or 0
        rows = db.scalars(
            select(UserNotification)
            .where(*conditions)
            .order_by(UserNotification.occurred_at.desc(), UserNotification.notification_id.desc())
            .offset(offset)
            .limit(limit)
        ).all()
        return NotificationPage(
            items=[
                NotificationItem(
                    notification_id=item.notification_id,
                    title=item.title,
                    description=item.description,
                    category=item.category,
                    priority=item.priority,
                    occurred_at=item.occurred_at.replace(tzinfo=timezone.utc),
                    is_read=item.read_at is not None,
                )
                for item in rows
            ],
            total=total,
            unread_count=unread_count,
            read_count=read_count,
        )
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("Notification center could not load notifications for user %s.", user.user_id)
        raise HTTPException(status_code=503, detail="Notifications are temporarily unavailable.") from exc


@router.patch("/{notification_id}/read", response_model=NotificationItem)
def update_notification_read_status(
    notification_id: int,
    payload: NotificationReadUpdate,
    user: User = Depends(require_roles("admin", "store_manager")),
    db: Session = Depends(get_db),
) -> NotificationItem:
    try:
        preferences, _ = synchronize_notifications(db, user)
        enabled = _enabled_categories(user, preferences)
        notification = db.scalar(
            select(UserNotification).where(
                UserNotification.notification_id == notification_id,
                UserNotification.user_id == user.user_id,
                UserNotification.category.in_(enabled),
            )
        )
        if notification is None:
            raise HTTPException(status_code=404, detail="Notification was not found.")
        notification.read_at = _read_at() if payload.is_read else None
        db.commit()
        return NotificationItem(
            notification_id=notification.notification_id,
            title=notification.title,
            description=notification.description,
            category=notification.category,
            priority=notification.priority,
            occurred_at=notification.occurred_at.replace(tzinfo=timezone.utc),
            is_read=notification.read_at is not None,
        )
    except HTTPException:
        raise
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("Notification read state could not be updated for user %s.", user.user_id)
        raise HTTPException(status_code=503, detail="Notification status could not be updated.") from exc


@router.post("/read-all", status_code=204)
def mark_all_notifications_read(
    user: User = Depends(require_roles("admin", "store_manager")),
    db: Session = Depends(get_db),
) -> None:
    try:
        preferences, _ = synchronize_notifications(db, user)
        enabled = _enabled_categories(user, preferences)
        db.query(UserNotification).filter(
            UserNotification.user_id == user.user_id,
            UserNotification.category.in_(enabled),
            UserNotification.read_at.is_(None),
        ).update({UserNotification.read_at: _read_at()}, synchronize_session=False)
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("Notification read state could not be updated for user %s.", user.user_id)
        raise HTTPException(status_code=503, detail="Notification status could not be updated.") from exc
