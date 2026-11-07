from datetime import date, timedelta

from sqlalchemy import inspect, select
from sqlalchemy.orm import Session

from app.models import CategoryShelfLifeSetting

DEFAULT_SHELF_LIFE_DAYS: dict[str, int] = {
    "Seafood": 2,
    "Meat & Poultry": 3,
    "Dairy Products": 9,
    "Bakery Products": 5,
    "Vegetables": 9,
    "Fruits": 9,
    "Ready-to-Eat Foods": 4,
    "Fresh Juices": 3,
    "Frozen Foods": 228,
    "Beverages": 105,
}

_CATEGORY_ALIASES = {
    "bakery": "Bakery Products",
    "beverage": "Beverages",
    "dairy": "Dairy Products",
}


def canonical_category(category: str) -> str | None:
    normalized = category.strip().casefold()
    if normalized in _CATEGORY_ALIASES:
        return _CATEGORY_ALIASES[normalized]
    return next(
        (name for name in DEFAULT_SHELF_LIFE_DAYS if name.casefold() == normalized),
        None,
    )


def configured_shelf_life_days(db: Session, category: str) -> int | None:
    canonical = canonical_category(category)
    if canonical is None:
        return None
    default_days = DEFAULT_SHELF_LIFE_DAYS[canonical]
    if not inspect(db.get_bind()).has_table(CategoryShelfLifeSetting.__tablename__):
        return default_days
    setting = db.get(CategoryShelfLifeSetting, canonical)
    return setting.days if setting is not None else default_days


def suggest_expiry_date(db: Session, category: str, received_at: date) -> date | None:
    days = configured_shelf_life_days(db, category)
    return received_at + timedelta(days=days) if days is not None else None


def list_shelf_life_settings(db: Session) -> list[CategoryShelfLifeSetting]:
    return list(
        db.scalars(
            select(CategoryShelfLifeSetting).order_by(CategoryShelfLifeSetting.category)
        ).all()
    )
