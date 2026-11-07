from datetime import date, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine, event, inspect, select, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db.base import Base
from app.models import InventoryBatch, Product, SaleRecord
from app.services.expiry_risk_service import (
    FEATURE_COLUMNS,
    load_expiry_model,
    ml_risk,
    predict_expiry_batches,
    prepare_expiry_features,
)


def test_expiry_artifact_loads_with_expected_features():
    model = load_expiry_model()
    assert list(model.feature_names_in_) == FEATURE_COLUMNS


def test_expiry_probability_maps_to_risk_levels():
    assert ml_risk(0.9) == "High Risk"
    assert ml_risk(0.5) == "Medium Risk"
    assert ml_risk(0.3) == "Low Risk"
    assert ml_risk(0.1) == "Safe"
    assert ml_risk(0.1, expired=True) == "High Risk"


def test_feature_preparation_has_exact_columns():
    product = Product(product_id=1, name="Milk", category="Dairy", sku="MILK", unit="each", price=10, supplier="Test")
    batch = InventoryBatch(batch_id=1, product_id=1, batch_code="B1", quantity_received=20, quantity_remaining=8, unit_cost=5, received_at=date(2026, 10, 1), expiry_date=date(2026, 11, 5), status="active")
    features = prepare_expiry_features(product, batch, date(2026, 10, 31))
    assert list(features.columns) == FEATURE_COLUMNS
    assert features.iloc[0]["days_to_expiry"] == 5


def test_invalid_expiry_date_is_rejected():
    product = Product(product_id=1, name="Milk", category="Dairy", sku="MILK", unit="each", price=10, supplier="Test")
    batch = InventoryBatch(batch_id=1, product_id=1, batch_code="B1", quantity_received=20, quantity_remaining=8, unit_cost=5, received_at=date(2026, 11, 1), expiry_date=date(2026, 10, 31), status="active")
    with pytest.raises(ValueError, match="invalid expiry date"):
        prepare_expiry_features(product, batch, date(2026, 10, 31))


def test_prediction_supports_inventory_schema_without_expiry_provenance():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    model = SimpleNamespace(
        predict=lambda features: [1],
        predict_proba=lambda features: [[0.1, 0.9]],
        named_steps={"classifier": SimpleNamespace(classes_=[0, 1])},
    )
    try:
        with Session(engine) as db:
            product = Product(
                product_id=1,
                name="Fish",
                category="Seafood",
                sku="FISH-1",
                unit="kg",
                price=Decimal("10"),
                supplier="Test supplier",
            )
            db.add(product)
            db.flush()
            db.add(
                InventoryBatch(
                    batch_id=1,
                    product_id=product.product_id,
                    batch_code="FISH-B1",
                    quantity_received=Decimal("5"),
                    quantity_remaining=Decimal("3"),
                    unit_cost=Decimal("4"),
                    received_at=date.today() - timedelta(days=1),
                    expiry_date=date.today() + timedelta(days=1),
                    status="active",
                )
            )
            db.flush()
            db.execute(text("ALTER TABLE inventory_batches DROP COLUMN expiry_date_source"))
            db.commit()
            assert "expiry_date_source" not in {
                column["name"] for column in inspect(engine).get_columns("inventory_batches")
            }
            assert db.scalar(select(InventoryBatch.batch_id)) == 1
            assert db.execute(
                select(InventoryBatch.batch_id, InventoryBatch.quantity_remaining)
                .join(Product, Product.product_id == InventoryBatch.product_id)
                .where(InventoryBatch.batch_id == 1, InventoryBatch.quantity_remaining > 0)
            ).all()

            with (
                patch("app.services.expiry_risk_service.load_expiry_model", return_value=model),
                patch("app.services.expiry_risk_service.model_version", return_value="test-v1"),
            ):
                predictions = predict_expiry_batches(db, [1])

        assert predictions[0]["expiry_date_source"] is None
        assert predictions[0]["batch_id"] == 1
    finally:
        Base.metadata.drop_all(engine)
        engine.dispose()


def test_predictions_batch_sales_queries_and_reuse_saved_daily_results():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    today = date.today()
    features_seen = []
    model = SimpleNamespace(
        predict=lambda features: features_seen.append(features.copy()) or [1] * len(features),
        predict_proba=lambda features: [[0.1, 0.9] for _ in range(len(features))],
        named_steps={"classifier": SimpleNamespace(classes_=[0, 1])},
    )
    sales_query_count = 0

    def count_sales_queries(conn, cursor, statement, parameters, context, executemany):
        nonlocal sales_query_count
        if "from sales_records" in statement.lower():
            sales_query_count += 1

    event.listen(engine, "before_cursor_execute", count_sales_queries)
    try:
        with Session(engine) as db:
            db.add(Product(
                product_id=1,
                name="Milk",
                category="Dairy",
                sku="MILK-1",
                unit="liter",
                price=Decimal("10"),
                supplier="Test supplier",
            ))
            db.flush()
            db.add_all([
                InventoryBatch(
                    batch_id=batch_id,
                    product_id=1,
                    batch_code=f"MILK-{batch_id}",
                    quantity_received=Decimal("10"),
                    quantity_remaining=Decimal("8"),
                    unit_cost=Decimal("5"),
                    received_at=today - timedelta(days=1),
                    expiry_date=today + timedelta(days=batch_id),
                    status="active",
                )
                for batch_id in (1, 2)
            ])
            db.add(SaleRecord(
                sale_id=1,
                product_id=1,
                batch_id=1,
                sold_at=datetime.combine(today, datetime.min.time()),
                quantity=Decimal("5"),
                unit_price=Decimal("10"),
                total_amount=Decimal("50"),
            ))
            db.commit()

            with (
                patch("app.services.expiry_risk_service.load_expiry_model", return_value=model),
                patch("app.services.expiry_risk_service.model_version", return_value="test-v1"),
            ):
                first = predict_expiry_batches(db, [1, 2])

            assert len(first) == 2
            assert len(features_seen) == 1
            assert features_seen[0]["avg_daily_sales_7d"].tolist() == [5 / 7, 5 / 7]
            assert sales_query_count == 1

            with (
                patch("app.services.expiry_risk_service.load_expiry_model", side_effect=AssertionError("model reloaded")),
                patch("app.services.expiry_risk_service.model_version", return_value="test-v1"),
            ):
                second = predict_expiry_batches(db, [1, 2])

            assert [row["risk_probability"] for row in second] == [row["risk_probability"] for row in first]
            assert len(features_seen) == 1
    finally:
        event.remove(engine, "before_cursor_execute", count_sales_queries)
        Base.metadata.drop_all(engine)
        engine.dispose()


def test_empty_batch_list_skips_prediction_work():
    engine = create_engine("sqlite://")
    try:
        with Session(engine) as db, patch(
            "app.services.expiry_risk_service.load_expiry_model",
            side_effect=AssertionError("empty input must not load a model"),
        ):
            assert predict_expiry_batches(db, []) == []
    finally:
        engine.dispose()
