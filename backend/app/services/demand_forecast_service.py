from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP
from typing import Iterable

import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import BACKEND_DIR
from app.models import DemandForecast, InventoryBatch, Product, SaleRecord
from app.services.model_artifacts import load_model_artifact, model_version

ARTIFACT_PATH = BACKEND_DIR.parent / "ml" / "artifacts" / "demand_forecast.joblib"
MODEL_VERSION = "demand_forecast_one_day_v1"
FEATURE_COLUMNS = [
    "product_id", "category", "opening_stock", "units_received", "unit_price",
    "discount_pct", "days_to_expiry", "sales_lag_1", "sales_lag_7",
    "sales_mean_previous_7d", "calendar_month", "calendar_day_of_week",
    "calendar_day_of_month", "calendar_day_of_year",
]


def load_demand_model():
    return load_model_artifact("demand_forecast")


def _sales_history(db: Session, product_id: int, before: date, days: int = 30) -> list[float]:
    start = before - timedelta(days=days - 1)
    rows = db.execute(
        select(SaleRecord.sold_at, SaleRecord.quantity)
        .where(SaleRecord.product_id == product_id, SaleRecord.sold_at < before)
        .order_by(SaleRecord.sold_at.desc())
        .limit(days * 10)
    ).all()
    daily: dict[date, float] = {}
    for sold_at, quantity in rows:
        sold_date = sold_at.date() if isinstance(sold_at, datetime) else sold_at
        if start <= sold_date <= before - timedelta(days=1):
            daily[sold_date] = daily.get(sold_date, 0.0) + float(quantity)
    return [daily.get(before - timedelta(days=offset), 0.0) for offset in range(1, days + 1)]


def prepare_feature_row(
    product: Product,
    forecast_date: date,
    history: Iterable[float],
    opening_stock: float,
    units_received: float,
    unit_price: float,
    days_to_expiry: int,
) -> pd.DataFrame:
    values = list(history)
    lag_1 = values[0] if values else 0.0
    lag_7 = values[6] if len(values) >= 7 else lag_1
    recent = values[:7]
    mean_7 = sum(recent) / len(recent) if recent else lag_1
    row = {
        "product_id": int(product.product_id),
        "category": product.category,
        "opening_stock": max(0.0, opening_stock),
        "units_received": max(0.0, units_received),
        "unit_price": max(0.0, unit_price),
        "discount_pct": 0.0,
        "days_to_expiry": max(-1, days_to_expiry),
        "sales_lag_1": lag_1,
        "sales_lag_7": lag_7,
        "sales_mean_previous_7d": mean_7,
        "calendar_month": forecast_date.month,
        "calendar_day_of_week": forecast_date.weekday(),
        "calendar_day_of_month": forecast_date.day,
        "calendar_day_of_year": forecast_date.timetuple().tm_yday,
    }
    return pd.DataFrame([row], columns=FEATURE_COLUMNS)


def generate_forecasts(db: Session, product_ids: list[int] | None, start_date: date, horizon: int) -> list[DemandForecast]:
    if horizon < 1 or horizon > 90:
        raise ValueError("Forecast horizon must be between 1 and 90 days")
    if start_date < date.today():
        raise ValueError("Forecast start date cannot be in the past")

    products_query = select(Product)
    if product_ids:
        products_query = products_query.where(Product.product_id.in_(product_ids))
    products = list(db.scalars(products_query.order_by(Product.product_id)).all())
    found = {int(product.product_id) for product in products}
    missing = sorted(set(product_ids or []) - found)
    if missing:
        raise ValueError(f"Unknown product IDs: {missing}")
    if not products:
        raise ValueError("No products available for forecasting")

    model = load_demand_model()
    active_model_version = model_version("demand_forecast", MODEL_VERSION)
    created: list[DemandForecast] = []
    for product in products:
        batch_rows = db.execute(
            select(InventoryBatch.quantity_remaining, InventoryBatch.quantity_received, InventoryBatch.expiry_date)
            .where(InventoryBatch.product_id == product.product_id, InventoryBatch.status == "active")
            .order_by(InventoryBatch.expiry_date.asc())
        ).all()
        stock = sum(float(row[0]) for row in batch_rows) if batch_rows else 0.0
        received = sum(float(row[1]) for row in batch_rows) if batch_rows else 0.0
        days_to_expiry = min((row[2] - start_date).days for row in batch_rows) if batch_rows else 365
        history = _sales_history(db, int(product.product_id), start_date, 30)

        for offset in range(horizon):
            forecast_date = start_date + timedelta(days=offset)
            existing = db.scalar(select(DemandForecast).where(
                DemandForecast.product_id == product.product_id,
                DemandForecast.forecast_date == forecast_date,
                DemandForecast.model_version == active_model_version,
            ))
            if existing is not None:
                created.append(existing)
                continue
            features = prepare_feature_row(
                product, forecast_date, history, stock, received,
                float(product.price), days_to_expiry - offset,
            )
            raw_prediction = float(model.predict(features)[0])
            prediction = max(0.0, raw_prediction)
            record = DemandForecast(
                product_id=product.product_id,
                forecast_date=forecast_date,
                predicted_demand=Decimal(str(prediction)).quantize(Decimal("0.001"), rounding=ROUND_HALF_UP),
                model_version=active_model_version,
            )
            db.add(record)
            created.append(record)
            history = [prediction] + history[:-1]
            stock = max(0.0, stock - prediction)
    db.commit()
    return created
