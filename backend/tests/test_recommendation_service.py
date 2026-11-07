from datetime import date, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models.inventory import InventoryBatch
from app.models.prediction import DemandForecast
from app.models.product import Product
from app.models.prediction import Recommendation

from app.services.recommendation_service import (
    candidate_discounts,
    discounted_price,
    estimated_gross_margin,
    expiry_risk,
    generate_operational_recommendations,
    recommend_discount,
)


def test_candidate_discounts_are_within_limits():
    assert candidate_discounts() == (Decimal("5"), Decimal("10"), Decimal("15"), Decimal("20"))


def test_selling_price_is_calculated():
    assert discounted_price(Decimal("100"), Decimal("15")) == Decimal("85.00")


def test_expiry_risk_boundaries():
    assert expiry_risk(-1) == "expired"
    assert expiry_risk(3) == "high"
    assert expiry_risk(7) == "medium"
    assert expiry_risk(14) == "low"
    assert expiry_risk(15) == "safe"


def test_rule_discount_uses_expiry_and_stock():
    assert recommend_discount(1, Decimal("10")) == Decimal("20")
    assert recommend_discount(5, Decimal("10")) == Decimal("10")


def test_expired_and_out_of_stock_are_rejected():
    with pytest.raises(ValueError, match="Expired"):
        recommend_discount(-1, Decimal("10"))
    with pytest.raises(ValueError, match="Out-of-stock"):
        recommend_discount(5, Decimal("0"))


def test_gross_margin_requires_cost():
    assert estimated_gross_margin(Decimal("100"), None, Decimal("10"), Decimal("10")) is None
    assert estimated_gross_margin(Decimal("100"), Decimal("50"), Decimal("10"), Decimal("10")) == Decimal("400.00")


@pytest.mark.parametrize("recommendation_type", ["restock", "discount", "transfer", "donate", "reorder", "remove"])
def test_supported_recommendation_types_persist_with_batch_and_applied_at(recommendation_type):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    try:
        with Session(engine) as db:
            product = Product(
                product_id=900,
                name="Migration compatibility product",
                category="Test",
                sku=f"MIG-{recommendation_type}",
                unit="unit",
                price=Decimal("10.00"),
                supplier="Test supplier",
            )
            db.add(product)
            db.flush()
            batch = InventoryBatch(
                batch_id=901,
                product_id=product.product_id,
                batch_code=f"BATCH-{recommendation_type}",
                quantity_received=Decimal("10.000"),
                quantity_remaining=Decimal("10.000"),
                unit_cost=Decimal("5.00"),
                received_at=date.today(),
                expiry_date=date.today(),
                status="active",
                location="Test",
            )
            db.add(batch)
            db.flush()
            applied_at = datetime(2026, 11, 2, 12, 0, 0)
            recommendation = Recommendation(
                product_id=product.product_id,
                batch_id=batch.batch_id,
                recommendation_type=recommendation_type,
                recommended_quantity=Decimal("2.000"),
                discount_percent=Decimal("10.00") if recommendation_type == "discount" else None,
                reason="Migration compatibility test; no operational action is performed.",
                status="applied",
                applied_by=None,
                applied_at=applied_at,
            )
            db.add(recommendation)
            db.commit()

            saved = db.get(Recommendation, recommendation.recommendation_id)
            assert saved is not None
            assert saved.recommendation_type == recommendation_type
            assert saved.batch_id == batch.batch_id
            assert saved.applied_at == applied_at
    finally:
        Base.metadata.drop_all(engine)
        engine.dispose()


def test_operational_recommendations_support_inventory_schema_without_expiry_provenance():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    try:
        with Session(engine) as db:
            product = Product(
                product_id=902,
                name="Schema compatibility product",
                category="Bakery Products",
                sku="SCHEMA-902",
                unit="each",
                price=Decimal("10.00"),
                supplier="Test supplier",
            )
            db.add(product)
            db.flush()
            db.add(InventoryBatch(
                batch_id=903,
                product_id=product.product_id,
                batch_code="SCHEMA-LOT",
                quantity_received=Decimal("10.000"),
                quantity_remaining=Decimal("10.000"),
                unit_cost=Decimal("5.00"),
                received_at=date.today(),
                expiry_date=date.today(),
                status="active",
                location="Test",
            ))
            db.commit()
            db.connection().exec_driver_sql(
                "ALTER TABLE inventory_batches DROP COLUMN expiry_date_source"
            )

            recommendations = generate_operational_recommendations(db, limit=5)

            assert recommendations
            assert recommendations[0]["expiry_date_source"] is None
            assert recommendations[0]["product_name"] == "Schema compatibility product"
    finally:
        Base.metadata.drop_all(engine)
        engine.dispose()


def test_operational_recommendations_aggregate_forecasts_in_one_query():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    forecast_query_count = 0

    def count_forecast_queries(conn, cursor, statement, parameters, context, executemany):
        nonlocal forecast_query_count
        if "from demand_forecasts" in statement.lower():
            forecast_query_count += 1

    try:
        with Session(engine) as db:
            products = [
                Product(
                    product_id=product_id,
                    name=f"Forecast Product {product_id}",
                    category="Test",
                    sku=f"FORECAST-{product_id}",
                    unit="each",
                    price=Decimal("10.00"),
                    supplier="Test supplier",
                )
                for product_id in (904, 905)
            ]
            db.add_all(products)
            db.flush()
            today = date.today()
            db.add_all([
                DemandForecast(
                    product_id=904,
                    forecast_date=today + timedelta(days=day),
                    predicted_demand=Decimal(str(quantity)),
                    lower_bound=Decimal("0"),
                    upper_bound=Decimal(str(quantity + 1)),
                    model_version="test-v1",
                )
                for day, quantity in ((1, 3), (2, 4))
            ] + [
                DemandForecast(
                    product_id=905,
                    forecast_date=today + timedelta(days=1),
                    predicted_demand=Decimal("2"),
                    lower_bound=Decimal("0"),
                    upper_bound=Decimal("3"),
                    model_version="test-v1",
                )
            ])
            db.commit()
            event.listen(engine, "before_cursor_execute", count_forecast_queries)
            try:
                recommendations = generate_operational_recommendations(db)
            finally:
                event.remove(engine, "before_cursor_execute", count_forecast_queries)

            by_product = {row["product_id"]: row for row in recommendations}
            assert by_product[904]["predicted_demand"] == 7.0
            assert by_product[905]["predicted_demand"] == 2.0
            assert forecast_query_count == 1
    finally:
        Base.metadata.drop_all(engine)
        engine.dispose()
