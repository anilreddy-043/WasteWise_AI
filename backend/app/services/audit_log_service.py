from __future__ import annotations

from datetime import date, datetime, time, timezone
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import String, and_, case, func, or_, select
from sqlalchemy.sql.elements import ColumnElement
from sqlalchemy.orm import Session

from app.models import User, UserActivity, UserGeneralSettings

MANAGER_VISIBLE_ACTIONS = (
    "product_created",
    "product_updated",
    "product_deleted",
    "product_image_updated",
    "batch_created",
    "batch_updated",
    "batch_deleted",
    "sale_recorded",
    "pos_sale_completed",
    "waste_recorded",
    "store_information_updated",
    "store_logo_updated",
)
MANAGER_VISIBLE_PREFIXES = ("recommendation_", "expiry_alert_rule_")
FAILED_ACTIONS = frozenset({
    "auth_login_failed",
    "auth_login_denied",
    "password_change_failed",
    "data_import_failed",
    "database_backup_failed",
    "database_backup_import_failed",
    "database_restore_failed",
})
SUCCESSFUL_ACTIONS = frozenset({
    "terms_accepted",
    "user_registered",
    "user_activated",
    "user_deactivated",
    "user_role_changed",
    "session_started",
    "session_revoked",
    "password_changed",
    "profile_updated",
    "profile_image_updated",
    "profile_image_removed",
    "product_created",
    "product_updated",
    "product_deleted",
    "product_image_updated",
    "product_imported",
    "batch_created",
    "batch_updated",
    "batch_deleted",
    "batch_imported",
    "batch_csv_imported",
    "data_csv_imported",
    "data_exported",
    "store_information_updated",
    "store_logo_updated",
    "general_settings_updated",
    "notification_settings_updated",
    "shelf_life_updated",
    "sale_recorded",
    "pos_sale_completed",
    "waste_recorded",
    "database_backup_created",
    "database_backup_imported",
    "database_restore_completed",
})

_DETAIL_FIELDS: dict[str, tuple[str, ...]] = {
    "auth_login_denied": ("reason",),
    "session_revoked": ("reason",),
    "password_changed": ("revoked_sessions",),
    "password_change_failed": ("reason",),
    "user_role_changed": ("previous_role", "new_role", "revoked_sessions"),
    "product_updated": ("changed_fields",),
    "product_created": ("changed_fields",),
    "batch_updated": ("changed_fields",),
    "batch_created": ("quantity_received", "quantity_remaining"),
    "data_csv_imported": (
        "total_records",
        "successful_records",
        "skipped_records",
        "provenance",
    ),
    "batch_csv_imported": ("total_records", "successful_records", "skipped_records"),
    "database_backup_created": ("backup_id", "filename", "size_bytes", "row_count", "status"),
    "database_backup_imported": ("backup_id", "filename", "size_bytes", "row_count", "status"),
    "database_restore_completed": ("backup_id", "row_count"),
    "data_exported": ("dataset", "format", "record_count"),
    "data_import_failed": ("dataset", "failure_reason", "failed_records", "total_records"),
    "store_information_updated": ("changed_fields",),
    "profile_updated": ("changed_fields",),
    "store_logo_updated": (),
    "general_settings_updated": ("changed_fields",),
    "notification_settings_updated": ("changed_fields",),
    "shelf_life_updated": ("category", "days"),
    "waste_recorded": ("quantity", "reason"),
    "pos_sale_completed": ("transaction_number", "payment_method", "item_count", "total_amount"),
    "sale_recorded": ("quantity", "total_amount"),
}
_SENSITIVE_KEYS = frozenset({
    "password",
    "password_hash",
    "token",
    "access_token",
    "refresh_token",
    "secret",
    "credential",
    "credentials",
    "database_url",
    "connection_string",
    "jti",
    "principal_key",
    "ip_key",
    "ip",
    "email",
})


def manager_activity_clause() -> ColumnElement[bool]:
    return or_(
        UserActivity.action.in_(MANAGER_VISIBLE_ACTIONS),
        *(UserActivity.action.like(f"{prefix}%") for prefix in MANAGER_VISIBLE_PREFIXES),
    )


def activity_scope(user: User) -> ColumnElement[bool] | None:
    if user.role == "admin":
        return None
    if user.role == "store_manager":
        return manager_activity_clause()
    return UserActivity.activity_id == -1


def get_user_timezone(db: Session, user_id: int) -> ZoneInfo:
    settings = db.get(UserGeneralSettings, user_id)
    if settings is None:
        return ZoneInfo("Asia/Kolkata")
    try:
        return ZoneInfo(settings.timezone)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError("Your configured timezone is invalid. Update General Settings before viewing audit logs.") from exc


def utc_date_bounds(
    start_date: date | None,
    end_date: date | None,
    timezone_info: ZoneInfo,
) -> tuple[datetime | None, datetime | None]:
    if start_date is not None and end_date is not None and start_date > end_date:
        raise ValueError("Start date must be on or before end date.")
    start = None
    end = None
    if start_date is not None:
        start = datetime.combine(start_date, time.min, timezone_info).astimezone(timezone.utc).replace(tzinfo=None)
    if end_date is not None:
        end = datetime.combine(end_date, time.max, timezone_info).astimezone(timezone.utc).replace(tzinfo=None)
    return start, end


def safe_activity_details(action: str, details: Any) -> dict[str, object]:
    if not isinstance(details, dict):
        return {}
    allowed = _DETAIL_FIELDS.get(action, ())
    safe: dict[str, object] = {}
    for key in allowed:
        if key.casefold() in _SENSITIVE_KEYS or key not in details:
            continue
        value = _sanitize_value(details[key], depth=0)
        if value is not None:
            safe[key] = value
    return safe


def _sanitize_value(value: Any, *, depth: int) -> object | None:
    if depth > 2:
        return None
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value[:240]
    if isinstance(value, list):
        return [
            item
            for entry in value[:30]
            if (item := _sanitize_value(entry, depth=depth + 1)) is not None
        ]
    if isinstance(value, dict):
        return {
            str(key)[:80]: item
            for key, entry in list(value.items())[:30]
            if str(key).casefold() not in _SENSITIVE_KEYS
            and (item := _sanitize_value(entry, depth=depth + 1)) is not None
        }
    return None


def audit_search_clause(search: str) -> ColumnElement[bool]:
    term = f"%{search.strip()}%"
    return or_(
        UserActivity.action.ilike(term),
        UserActivity.entity_type.ilike(term),
        User.full_name.ilike(term),
        User.role.ilike(term),
        UserActivity.entity_id.cast(String).ilike(term),
    )


def activity_status_clause(status: str) -> ColumnElement[bool]:
    is_failed = or_(
        UserActivity.action.in_(FAILED_ACTIONS),
        func.substr(UserActivity.action, -7) == "_failed",
        func.substr(UserActivity.action, -7) == "_denied",
    )
    is_successful = or_(
        UserActivity.action.in_(SUCCESSFUL_ACTIONS),
        UserActivity.action.like("recommendation\\_%", escape="\\"),
        UserActivity.action.like("expiry_alert_rule\\_%", escape="\\"),
    )
    if status == "failed":
        return is_failed
    if status == "successful":
        return is_successful
    return and_(~is_failed, ~is_successful)


def activity_status_order():
    is_failed = or_(
        UserActivity.action.in_(FAILED_ACTIONS),
        func.substr(UserActivity.action, -7) == "_failed",
        func.substr(UserActivity.action, -7) == "_denied",
    )
    is_successful = or_(
        UserActivity.action.in_(SUCCESSFUL_ACTIONS),
        UserActivity.action.like("recommendation\\_%", escape="\\"),
        UserActivity.action.like("expiry_alert_rule\\_%", escape="\\"),
    )
    return case(
        (is_failed, 1),
        (is_successful, 0),
        else_=2,
    )


def build_activity_filters(
    *,
    user: User,
    timezone_info: ZoneInfo,
    action: str | None = None,
    user_id: int | None = None,
    unknown_actor: bool = False,
    start_date: date | None = None,
    end_date: date | None = None,
    search: str | None = None,
    status: str | None = None,
) -> list[ColumnElement[bool]]:
    conditions: list[ColumnElement[bool]] = []
    scope = activity_scope(user)
    if scope is not None:
        conditions.append(scope)
    if action:
        conditions.append(UserActivity.action == action)
    if user_id is not None:
        conditions.append(UserActivity.user_id == user_id)
    if unknown_actor:
        conditions.append(UserActivity.user_id.is_(None))
    start, end = utc_date_bounds(start_date, end_date, timezone_info)
    if start is not None:
        conditions.append(UserActivity.created_at >= start)
    if end is not None:
        conditions.append(UserActivity.created_at <= end)
    if search and search.strip():
        conditions.append(audit_search_clause(search))
    if status:
        conditions.append(activity_status_clause(status))
    return conditions


def activity_query(conditions: list[ColumnElement[bool]]):
    query = select(UserActivity, User.full_name, User.role).outerjoin(User, User.user_id == UserActivity.user_id)
    if conditions:
        query = query.where(and_(*conditions))
    return query


def activity_status(action: str) -> str:
    if action in FAILED_ACTIONS or action.endswith(("_failed", "_denied")):
        return "failed"
    if action in SUCCESSFUL_ACTIONS or action.startswith(("recommendation_", "expiry_alert_rule_")):
        return "successful"
    return "unknown"


def activity_timestamp_utc(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    else:
        value = value.astimezone(timezone.utc)
    return value.isoformat().replace("+00:00", "Z")
