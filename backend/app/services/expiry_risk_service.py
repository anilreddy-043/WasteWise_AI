from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP

import pandas as pd
from sqlalchemy import func, inspect, literal, select
from sqlalchemy.orm import Session

from app.core.config import BACKEND_DIR
from app.models import ExpiryRiskPrediction, InventoryBatch, Product, SaleRecord
from app.services.model_artifacts import load_model_artifact, model_version

ARTIFACT_PATH = BACKEND_DIR.parent / "ml" / "artifacts" / "expiry_risk.joblib"
MODEL_VERSION = "expiry_risk_binary_v1"
FEATURE_COLUMNS = [
    "product_id", "category", "initial_quantity", "quantity_remaining",
    "days_to_expiry", "avg_daily_sales_7d", "expected_demand_before_expiry",
    "unit_price", "unit_cost", "discount_pct", "received_age_days",
    "calendar_month", "calendar_day_of_week", "shelf_life_days",
]


@dataclass(frozen=True)
class ExpiryBatchData:
    batch_id: int
    product_id: int
    batch_code: str
    expiry_date: date
    expiry_date_source: str | None
    quantity_received: Decimal
    quantity_remaining: Decimal
    unit_cost: Decimal
    received_at: date
    status: str
    location: str | None
    supplier: str | None


def load_expiry_model():
    return load_model_artifact("expiry_risk")


def ml_risk(probability: float, expired: bool = False) -> str:
    if expired:
        return "High Risk"
    if probability >= 0.70:
        return "High Risk"
    if probability >= 0.45:
        return "Medium Risk"
    if probability >= 0.20:
        return "Low Risk"
    return "Safe"


def prepare_expiry_features(
    product: Product,
    batch: InventoryBatch | ExpiryBatchData,
    snapshot_date: date,
    db: Session | None = None,
    *,
    average_daily_sales: float | None = None,
) -> pd.DataFrame:
    if batch.expiry_date < batch.received_at:
        raise ValueError(f"Batch {batch.batch_id} has an invalid expiry date")
    days = (batch.expiry_date - snapshot_date).days
    average_sales = 0.0
    if db is not None:
        since = datetime.combine(snapshot_date - timedelta(days=6), datetime.min.time())
        rows = db.execute(
            select(SaleRecord.quantity).where(
                SaleRecord.product_id == product.product_id,
                SaleRecord.sold_at >= since,
                SaleRecord.sold_at < datetime.combine(snapshot_date + timedelta(days=1), datetime.min.time()),
            )
        ).scalars().all()
        average_sales = float(sum(rows, 0)) / 7.0
    elif average_daily_sales is not None:
        average_sales = average_daily_sales
    expected = average_sales * max(days, 0)
    row = {
        "product_id": int(product.product_id), "category": product.category,
        "initial_quantity": float(batch.quantity_received),
        "quantity_remaining": float(batch.quantity_remaining),
        "days_to_expiry": days, "avg_daily_sales_7d": average_sales,
        "expected_demand_before_expiry": expected,
        "unit_price": float(product.price), "unit_cost": float(batch.unit_cost),
        "discount_pct": 0.0, "received_age_days": (snapshot_date - batch.received_at).days,
        "calendar_month": snapshot_date.month,
        "calendar_day_of_week": snapshot_date.weekday(),
        "shelf_life_days": (batch.expiry_date - batch.received_at).days,
    }
    return pd.DataFrame([row], columns=FEATURE_COLUMNS)


def predict_expiry_batches(db: Session, batch_ids: list[int] | None = None) -> list[dict]:
    if batch_ids is not None and not batch_ids:
        return []

    batch_columns = {
        column["name"] for column in inspect(db.get_bind()).get_columns(InventoryBatch.__tablename__)
    }
    expiry_date_source = (
        InventoryBatch.expiry_date_source
        if "expiry_date_source" in batch_columns
        else literal(None)
    )
    query = select(
        InventoryBatch.batch_id,
        InventoryBatch.product_id,
        InventoryBatch.batch_code,
        InventoryBatch.expiry_date,
        expiry_date_source,
        InventoryBatch.quantity_received,
        InventoryBatch.quantity_remaining,
        InventoryBatch.unit_cost,
        InventoryBatch.received_at,
        InventoryBatch.status,
        InventoryBatch.location,
        InventoryBatch.supplier,
        Product,
    ).join(Product, Product.product_id == InventoryBatch.product_id)
    if batch_ids is not None:
        query = query.where(InventoryBatch.batch_id.in_(batch_ids))
    query = query.where(InventoryBatch.quantity_remaining > 0).order_by(InventoryBatch.expiry_date.asc(), InventoryBatch.batch_id.asc())
    rows = list(db.execute(query).all())
    batches_and_products = [
        (ExpiryBatchData(*row[:-1]), row[-1])
        for row in rows
    ]
    found = {int(batch.batch_id) for batch, _ in batches_and_products}
    missing = sorted(set(batch_ids or []) - found)
    if missing:
        raise ValueError(f"Unknown or stock-empty batch IDs: {missing}")
    if not batches_and_products:
        return []

    active_model_version = model_version("expiry_risk", MODEL_VERSION)
    snapshot = date.today()
    persistence_available = inspect(db.get_bind()).has_table(ExpiryRiskPrediction.__tablename__)
    existing_by_batch: dict[int, ExpiryRiskPrediction] = {}
    if persistence_available:
        existing_predictions = db.scalars(
            select(ExpiryRiskPrediction)
            .where(
                ExpiryRiskPrediction.batch_id.in_([batch.batch_id for batch, _ in batches_and_products]),
                ExpiryRiskPrediction.model_version == active_model_version,
                ExpiryRiskPrediction.predicted_at >= datetime.combine(snapshot, datetime.min.time()),
            )
            .order_by(ExpiryRiskPrediction.predicted_at.desc(), ExpiryRiskPrediction.prediction_id.desc())
        ).all()
        for prediction in existing_predictions:
            existing_by_batch.setdefault(prediction.batch_id, prediction)

    pending = [
        (batch, product)
        for batch, product in batches_and_products
        if batch.batch_id not in existing_by_batch
    ]
    inferred_by_batch: dict[int, tuple[int, float]] = {}
    if pending:
        product_ids = {product.product_id for _, product in pending}
        sales_start = datetime.combine(snapshot - timedelta(days=6), datetime.min.time())
        sales_end = datetime.combine(snapshot + timedelta(days=1), datetime.min.time())
        sales_totals = dict(
            db.execute(
                select(SaleRecord.product_id, func.sum(SaleRecord.quantity))
                .where(
                    SaleRecord.product_id.in_(product_ids),
                    SaleRecord.sold_at >= sales_start,
                    SaleRecord.sold_at < sales_end,
                )
                .group_by(SaleRecord.product_id)
            ).all()
        )
        feature_frames = [
            prepare_expiry_features(
                product,
                batch,
                snapshot,
                average_daily_sales=float(sales_totals.get(product.product_id, 0)) / 7.0,
            )
            for batch, product in pending
        ]
        features = pd.concat(feature_frames, ignore_index=True)
        model = load_expiry_model()
        predicted_classes = model.predict(features)
        probabilities = model.predict_proba(features)
        classes = list(model.named_steps["classifier"].classes_)
        positive_index = classes.index(1)
        new_predictions = []
        for index, (batch, _) in enumerate(pending):
            predicted_class = int(predicted_classes[index])
            probability = float(probabilities[index][positive_index])
            inferred_by_batch[batch.batch_id] = (predicted_class, probability)
            if persistence_available:
                new_predictions.append(
                    ExpiryRiskPrediction(
                        batch_id=batch.batch_id,
                        predicted_class=predicted_class,
                        risk_probability=Decimal(str(probability)).quantize(
                            Decimal("0.000001"), rounding=ROUND_HALF_UP
                        ),
                        model_version=active_model_version,
                    )
                )
        if new_predictions:
            db.add_all(new_predictions)
            db.commit()

    results = []
    for batch, product in batches_and_products:
        existing = existing_by_batch.get(batch.batch_id)
        predicted_class, probability = (
            (int(existing.predicted_class), float(existing.risk_probability))
            if existing is not None
            else inferred_by_batch[batch.batch_id]
        )
        expired = batch.expiry_date < snapshot
        results.append({
            "batch_id": int(batch.batch_id), "product_id": int(product.product_id),
            "product_name": product.name, "category": product.category,
            "batch_code": batch.batch_code, "expiry_date": batch.expiry_date,
            "expiry_date_source": batch.expiry_date_source,
            "days_to_expiry": (batch.expiry_date - snapshot).days,
            "quantity_remaining": float(batch.quantity_remaining),
            "predicted_class": predicted_class, "risk_probability": probability,
            "ml_risk": ml_risk(probability, expired), "rule_status": "expired" if expired else "expiring_soon",
            "recommendation_source": "expiry_risk_ml",
            "location": batch.location,
            "supplier": batch.supplier or product.supplier,
            "model_version": active_model_version,
        })
    return results
