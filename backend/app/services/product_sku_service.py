import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Product

CATEGORY_SKU_PREFIXES = {
    "Fruits": "FRU",
    "Vegetables": "VEG",
    "Dairy Products": "DAI",
    "Bakery Products": "BAK",
    "Meat & Poultry": "MEA",
    "Seafood": "SEA",
    "Beverages": "BEV",
    "Snacks": "SNK",
    "Grains & Cereals": "GRA",
    "Pulses & Lentils": "PUL",
    "Spices & Masalas": "SPC",
    "Cooking Essentials": "COOK",
    "Frozen Foods": "FRZ",
    "Ready-to-Eat Foods": "RTE",
    "Fresh Juices": "FJU",
    "Condiments & Sauces": "CNS",
    "Personal Care": "PER",
    "Household Essentials": "HOU",
    "Other": "OTH",
}


def next_product_sku(db: Session, category: str) -> tuple[str, str]:
    prefix = CATEGORY_SKU_PREFIXES.get(category)
    if prefix is None:
        raise ValueError("Select a category from the approved category list.")

    skus = db.scalars(select(Product.sku)).all()
    pattern = re.compile(rf"^{re.escape(prefix)}(\d+)$", re.IGNORECASE)
    suffixes = (
        int(match.group(1))
        for sku in skus
        if (match := pattern.fullmatch(sku.strip())) is not None
    )
    next_number = max(suffixes, default=0) + 1
    return prefix, f"{prefix}{next_number:03d}"
