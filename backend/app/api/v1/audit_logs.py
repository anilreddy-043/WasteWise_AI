import logging
from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.security import require_roles
from app.db.session import get_db
from app.models import User, UserActivity
from app.services.audit_log_service import (
    activity_query,
    activity_status,
    activity_status_order,
    activity_timestamp_utc,
    build_activity_filters,
    get_user_timezone,
    safe_activity_details,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/audit-logs", tags=["audit-logs"])


def _timezone_or_http_error(db: Session, user_id: int):
    try:
        return get_user_timezone(db, user_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except SQLAlchemyError as exc:
        logger.exception("Audit log timezone could not be loaded.")
        raise HTTPException(status_code=503, detail="Audit logs are temporarily unavailable.") from exc


@router.get("/filters")
def get_audit_log_filters(
    user: User = Depends(require_roles("admin", "store_manager")),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    try:
        timezone_info = _timezone_or_http_error(db, user.user_id)
        conditions = build_activity_filters(user=user, timezone_info=timezone_info)
        actions = db.scalars(
            select(UserActivity.action)
            .where(*conditions)
            .distinct()
            .order_by(UserActivity.action)
        ).all()
        actors = db.execute(
            select(User.user_id, User.full_name)
            .join(UserActivity, User.user_id == UserActivity.user_id)
            .where(
                *conditions,
            )
            .distinct()
            .order_by(User.full_name, User.user_id)
        ).all()
        has_unknown_actor = db.scalar(
            select(UserActivity.activity_id)
            .where(
                *conditions,
                UserActivity.user_id.is_(None),
            )
            .limit(1)
        ) is not None
        return {
            "actions": actions,
            "actors": [{"user_id": actor_id, "full_name": name} for actor_id, name in actors],
            "has_unknown_actor": has_unknown_actor,
            "timezone": str(timezone_info),
        }
    except SQLAlchemyError as exc:
        logger.exception("Audit log filter options could not be loaded.")
        raise HTTPException(status_code=503, detail="Audit log filters are temporarily unavailable.") from exc


@router.get("")
def list_audit_logs(
    action: str | None = Query(default=None, min_length=1, max_length=80),
    user_id: int | None = Query(default=None, ge=1),
    unknown_actor: bool = False,
    start_date: date | None = None,
    end_date: date | None = None,
    search: str | None = Query(default=None, max_length=120),
    status: Literal["successful", "failed", "unknown"] | None = None,
    sort_by: Literal["timestamp", "action", "actor", "affected_record", "status"] = "timestamp",
    sort_order: Literal["asc", "desc"] = "desc",
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
    user: User = Depends(require_roles("admin", "store_manager")),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    if user_id is not None and unknown_actor:
        raise HTTPException(status_code=422, detail="Choose a named user or unknown actor, not both.")
    try:
        timezone_info = _timezone_or_http_error(db, user.user_id)
        conditions = build_activity_filters(
            user=user,
            timezone_info=timezone_info,
            action=action,
            user_id=user_id,
            unknown_actor=unknown_actor,
            start_date=start_date,
            end_date=end_date,
            search=search,
            status=status,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    try:
        count_query = select(func.count(UserActivity.activity_id)).select_from(UserActivity).outerjoin(
            User, User.user_id == UserActivity.user_id
        )
        if conditions:
            count_query = count_query.where(*conditions)
        total = int(db.scalar(count_query) or 0)
        sort_expressions = {
            "timestamp": UserActivity.created_at,
            "action": UserActivity.action,
            "actor": User.full_name,
            "affected_record": (UserActivity.entity_type, UserActivity.entity_id),
            "status": activity_status_order(),
        }
        sort_value = sort_expressions[sort_by]
        sort_values = sort_value if isinstance(sort_value, tuple) else (sort_value,)
        ordering = [
            expression.asc() if sort_order == "asc" else expression.desc()
            for expression in sort_values
        ]
        rows = db.execute(
            activity_query(conditions)
            .order_by(*ordering, UserActivity.activity_id.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        ).all()
    except SQLAlchemyError as exc:
        logger.exception("Audit log entries could not be loaded.")
        raise HTTPException(status_code=503, detail="Audit logs are temporarily unavailable.") from exc

    items = []
    for activity, actor_name, actor_role in rows:
        items.append({
            "activity_id": activity.activity_id,
            "user_id": activity.user_id,
            "actor_name": actor_name or ("Unknown login attempt" if activity.user_id is None else "Deleted user"),
            "actor_role": actor_role or "unknown",
            "action": activity.action,
            "entity_type": activity.entity_type,
            "entity_id": activity.entity_id,
            "affected_record": (
                f"{activity.entity_type} (ID: {activity.entity_id})"
                if activity.entity_id is not None
                else activity.entity_type
            ),
            "created_at": activity_timestamp_utc(activity.created_at),
            "status": activity_status(activity.action),
            "details": safe_activity_details(activity.action, activity.details),
        })
    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": (total + page_size - 1) // page_size,
        "timezone": str(timezone_info),
    }
