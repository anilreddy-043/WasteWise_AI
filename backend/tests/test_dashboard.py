import tempfile
import unittest
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.v1.dashboard import dashboard_summary
from app.core.security import get_current_user
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models import (
    DashboardHistoricalMetric,
    DashboardImportRecord,
    DemandForecast,
    InventoryBatch,
    Product,
    Recommendation,
    SaleRecord,
    User,
    UserActivity,
    WasteRecord,
)
from app.services.dashboard_import_service import import_dashboard_csvs
from app.services.dashboard_csv_service import (
    CsvBatchSnapshot,
    CsvProduct,
    DashboardCsvData,
    load_dashboard_csv_data,
)


class DashboardTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.connection = self.engine.connect()
        self.transaction = self.connection.begin()
        self.db = Session(bind=self.connection, join_transaction_mode="create_savepoint")
        self.user = User(
            user_id=1,
            full_name="Test Manager",
            email="manager@example.test",
            password_hash="unused",
            role="store_manager",
            approval_status="approved",
            is_active=True,
        )
        self.db.add(self.user)
        self.db.flush()
        app.dependency_overrides[get_db] = lambda: self.db
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.csv_data_patch = patch(
            "app.api.v1.dashboard.load_dashboard_csv_data",
            return_value=DashboardCsvData((), (), False, False, "products.csv", "perishable_inventory.csv"),
        )
        self.csv_data_patch.start()
        self.client = TestClient(app)

    def tearDown(self) -> None:
        self.csv_data_patch.stop()
        app.dependency_overrides.clear()
        self.db.close()
        self.transaction.rollback()
        self.connection.close()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def add_product(self, product_id: int, name: str, category: str, unit: str, sku: str | None = None) -> Product:
        product = Product(
            product_id=product_id,
            name=name,
            category=category,
            sku=sku or f"SKU-{product_id}",
            unit=unit,
            price=Decimal("12.50"),
            supplier="Test supplier",
        )
        self.db.add(product)
        self.db.flush()
        return product

    def add_batch(
        self,
        batch_id: int,
        product_id: int,
        expiry_date: date,
        quantity: str = "5",
        status: str = "active",
    ) -> InventoryBatch:
        batch = InventoryBatch(
            batch_id=batch_id,
            product_id=product_id,
            batch_code=f"B-{batch_id}",
            quantity_received=Decimal(quantity),
            quantity_remaining=Decimal(quantity),
            unit_cost=Decimal("4.00"),
            received_at=date.today() - timedelta(days=5),
            expiry_date=expiry_date,
            status=status,
        )
        self.db.add(batch)
        self.db.flush()
        return batch

    def test_summary_separates_actual_records_from_imported_training_history(self) -> None:
        product = self.add_product(2, "User Milk", "Dairy", "L")
        self.add_batch(10, product.product_id, date.today() + timedelta(days=4), "8")
        imported_product = self.add_product(3, "Imported Yogurt", "Dairy", "unit", "MLDATA-1001")
        self.db.add(
            DashboardImportRecord(
                source_file="ml/data/raw/products.csv",
                source_record_key="1001",
                entity_type="product",
                entity_id=imported_product.product_id,
                import_run_id=1,
            )
        )
        self.db.add(
            DashboardHistoricalMetric(
                source_file="ml/data/raw/perishable_inventory.csv",
                source_record_key="1001:2026-10-28",
                source_run_id=1,
                product_id=imported_product.product_id,
                business_date=date.today(),
                sales_quantity=Decimal("99"),
                sales_revenue=Decimal("999.00"),
                waste_quantity=Decimal("7"),
                data_kind="training_history",
            )
        )
        self.db.add(
            SaleRecord(
                sale_id=20,
                product_id=product.product_id,
                batch_id=10,
                sold_at=datetime.combine(date.today(), datetime.min.time()),
                quantity=Decimal("2"),
                unit_price=Decimal("12.50"),
                total_amount=Decimal("25.00"),
                source="manual",
            )
        )
        self.db.add(
            WasteRecord(
                waste_id=30,
                product_id=product.product_id,
                batch_id=10,
                recorded_by=self.user.user_id,
                quantity=Decimal("1.250"),
                reason="spoilage",
                waste_cost=Decimal("5.00"),
                recorded_at=datetime.combine(date.today(), datetime.min.time()),
            )
        )
        self.db.flush()

        response = self.client.get("/api/v1/dashboard/summary", params={"start_date": date.today(), "end_date": date.today()})

        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["product_count"], 2)
        self.assertEqual(data["imported_product_count"], 1)
        self.assertEqual(data["user_product_count"], 1)
        self.assertEqual(data["available_inventory"], [{"unit": "L", "quantity": 8.0}])
        self.assertEqual(data["sales_revenue"], 25.0)
        self.assertEqual(data["waste_cost"], 5.0)
        self.assertEqual(data["waste_quantity_by_unit"], [{"unit": "L", "quantity": 1.25}])

        sales_response = self.client.get("/api/v1/dashboard/sales-demand", params={"start_date": date.today(), "end_date": date.today()})
        sales_data = sales_response.json()
        self.assertEqual(sales_data["actual_sales"][0]["quantity"], 2.0)
        self.assertEqual(sales_data["imported_history"][0]["quantity"], 99.0)
        self.assertEqual(sales_data["prediction"]["status"], "available")
        self.assertEqual(sales_data["prediction"]["source"], "historical_average_baseline")
        self.assertGreater(len(sales_data["predicted_demand"]), 0)

        waste_response = self.client.get("/api/v1/dashboard/waste-trend", params={"start_date": date.today(), "end_date": date.today(), "granularity": "day"})
        self.assertEqual(waste_response.json()["actual"][0]["quantity"], 1.25)
        self.assertEqual(waste_response.json()["actual_record_count"], 1)
        self.assertEqual(waste_response.json()["imported_history"][0]["quantity"], 7.0)
        self.assertEqual(waste_response.json()["imported_history_status"]["source"], "dashboard_historical_metrics")
        self.assertIn("separately", waste_response.json()["imported_history_status"]["message"])
        self.assertIsNone(waste_response.json()["imported_history"][0]["cost"])

    def test_waste_trend_includes_expired_inventory_as_a_separate_series(self) -> None:
        product = self.add_product(40, "Expired Lettuce", "Vegetables", "kg")
        expiry_date = date.today() - timedelta(days=1)
        self.add_batch(40, product.product_id, expiry_date, "3.5", status="expired")
        self.add_batch(41, product.product_id, expiry_date, "0", status="depleted")
        self.add_batch(42, product.product_id, date.today() + timedelta(days=1), "8")

        response = self.client.get(
            "/api/v1/dashboard/waste-trend",
            params={
                "start_date": expiry_date.isoformat(),
                "end_date": expiry_date.isoformat(),
                "granularity": "day",
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["actual"], [])
        self.assertEqual(data["actual_record_count"], 0)
        self.assertEqual(
            data["expired_inventory"],
            [{"period": expiry_date.isoformat(), "unit": "kg", "quantity": 3.5, "cost": 14.0}],
        )
        self.assertEqual(data["units"], ["kg"])

    def test_sales_demand_returns_future_saved_forecasts_separately(self) -> None:
        product = self.add_product(2, "Forecast Produce", "Produce", "kg")
        prediction_date = date.today() + timedelta(days=1)
        self.db.add(
            DemandForecast(
                forecast_id=40,
                product_id=product.product_id,
                forecast_date=prediction_date,
                predicted_demand=Decimal("4.250"),
                lower_bound=Decimal("3.000"),
                upper_bound=Decimal("5.000"),
                model_version="test-v1",
            )
        )
        self.db.flush()

        response = self.client.get(
            "/api/v1/dashboard/sales-demand",
            params={"start_date": date.today(), "end_date": date.today(), "prediction_days": 7},
        )

        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["actual_sales"], [])
        self.assertEqual(data["predicted_demand"], [{
            "date": prediction_date.isoformat(),
            "unit": "kg",
            "quantity": 4.25,
            "model_versions": ["test-v1"],
        }])
        self.assertEqual(data["prediction_start_date"], prediction_date.isoformat())
        self.assertEqual(data["prediction_end_date"], (date.today() + timedelta(days=7)).isoformat())
        self.assertEqual(data["prediction"]["status"], "available")
        disabled = self.client.get(
            "/api/v1/dashboard/sales-demand",
            params={"start_date": date.today(), "end_date": date.today(), "prediction_days": 0},
        )
        self.assertEqual(disabled.json()["predicted_demand"], [])
        self.assertIsNone(disabled.json()["prediction_start_date"])
        self.assertEqual(disabled.json()["prediction"]["message"], "Forecast window disabled by request.")

    def test_expiry_boundaries_and_empty_or_recalled_batches(self) -> None:
        product = self.add_product(2, "Produce", "Produce", "kg")
        self.add_batch(11, product.product_id, date.today() - timedelta(days=1))
        self.add_batch(12, product.product_id, date.today())
        self.add_batch(13, product.product_id, date.today() + timedelta(days=7))
        empty = self.add_batch(14, product.product_id, date.today() + timedelta(days=1), "0.001")
        empty.quantity_remaining = Decimal("0")
        self.add_batch(15, product.product_id, date.today() + timedelta(days=1), status="recalled")
        self.db.flush()

        response = self.client.get("/api/v1/dashboard/expiry-alerts", params={"within_days": 7})

        self.assertEqual(response.status_code, 200, response.text)
        alerts = response.json()
        self.assertEqual([alert["batch_id"] for alert in alerts], [11, 12, 13])
        self.assertEqual(alerts[0]["status"], "expired")
        self.assertEqual(alerts[0]["risk"], "high")
        self.assertEqual(alerts[1]["days_to_expiry"], 0)
        self.assertEqual(alerts[2]["days_to_expiry"], 7)

    def test_expiry_alerts_support_inventory_schema_without_expiry_provenance(self) -> None:
        product = self.add_product(2, "Fish", "Seafood", "kg")
        self.add_batch(11, product.product_id, date.today() + timedelta(days=2))
        self.connection.exec_driver_sql(
            "ALTER TABLE inventory_batches DROP COLUMN expiry_date_source"
        )

        with patch("app.api.v1.dashboard.predict_expiry_batches", return_value=[]):
            response = self.client.get("/api/v1/dashboard/expiry-alerts")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()[0]["batch_id"], 11)
        self.assertIsNone(response.json()[0]["expiry_date_source"])

    def test_inventory_batch_listing_supports_schema_without_expiry_provenance(self) -> None:
        product = self.add_product(2, "Fish", "Seafood", "kg")
        self.add_batch(11, product.product_id, date.today() + timedelta(days=2))
        self.connection.exec_driver_sql(
            "ALTER TABLE inventory_batches DROP COLUMN expiry_date_source"
        )

        response = self.client.get("/api/v1/inventory/batches?limit=500")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(response.json()), 1)
        self.assertEqual(response.json()[0]["batch_id"], 11)
        self.assertIsNone(response.json()[0]["expiry_date_source"])

    def test_inventory_shelf_life_defaults_work_without_settings_table(self) -> None:
        self.add_product(2, "Fish", "Seafood", "kg")
        self.connection.exec_driver_sql("DROP TABLE category_shelf_life_settings")

        settings_response = self.client.get("/api/v1/inventory/shelf-life")
        suggestion_response = self.client.get(
            "/api/v1/products/2/expiry-suggestion",
            params={"received_at": date(2026, 11, 5)},
        )

        self.assertEqual(settings_response.status_code, 200, settings_response.text)
        settings = {row["category"]: row["days"] for row in settings_response.json()}
        self.assertEqual(settings["Seafood"], 2)
        self.assertEqual(settings["Fruits"], 9)
        self.assertIsNone(settings_response.json()[0]["updated_at"])
        self.assertEqual(suggestion_response.status_code, 200, suggestion_response.text)
        self.assertEqual(suggestion_response.json()["default_shelf_life_days"], 2)
        self.assertEqual(suggestion_response.json()["expiry_date"], "2026-11-07")

    def test_expiry_summary_matches_live_and_snapshot_alert_rules(self) -> None:
        product = self.add_product(2, "Orange Juice", "Beverages", "L")
        today = date.today()
        self.add_batch(11, product.product_id, today - timedelta(days=2), "2")
        self.add_batch(12, product.product_id, today + timedelta(days=5), "3")
        self.add_batch(13, product.product_id, today + timedelta(days=6), "4")
        self.add_batch(14, product.product_id, today + timedelta(days=1), "0")
        self.add_batch(15, product.product_id, today + timedelta(days=1), "2", status="recalled")

        csv_data = DashboardCsvData(
            catalog_products=(CsvProduct("1001", "Orange Juice", "Beverages", "unit", Decimal("10")),),
            sales_history=(),
            catalog_available=True,
            history_available=False,
            catalog_source="products.csv",
            history_source="perishable_inventory.csv",
            inventory_snapshots=(
                CsvBatchSnapshot(
                    batch_id=101,
                    product_source_id="1001",
                    category="Beverages",
                    snapshot_date=today - timedelta(days=1),
                    expiry_date=today - timedelta(days=2),
                    quantity_received=Decimal("5"),
                    quantity_remaining=Decimal("1"),
                    days_to_expiry=-1,
                    unit_price=Decimal("10"),
                    unit_cost=Decimal("5"),
                    expiry_risk=True,
                ),
                CsvBatchSnapshot(
                    batch_id=102,
                    product_source_id="1001",
                    category="Beverages",
                    snapshot_date=today - timedelta(days=1),
                    expiry_date=today + timedelta(days=4),
                    quantity_received=Decimal("5"),
                    quantity_remaining=Decimal("2"),
                    days_to_expiry=5,
                    unit_price=Decimal("10"),
                    unit_cost=Decimal("5"),
                    expiry_risk=False,
                ),
                CsvBatchSnapshot(
                    batch_id=103,
                    product_source_id="1001",
                    category="Beverages",
                    snapshot_date=today,
                    expiry_date=today + timedelta(days=6),
                    quantity_received=Decimal("5"),
                    quantity_remaining=Decimal("2"),
                    days_to_expiry=6,
                    unit_price=Decimal("10"),
                    unit_cost=Decimal("5"),
                    expiry_risk=False,
                ),
            ),
        )
        with (
            patch("app.api.v1.dashboard.load_dashboard_csv_data", return_value=csv_data),
            patch("app.api.v1.dashboard.predict_expiry_batches", return_value=[]),
        ):
            summary_response = self.client.get(
                "/api/v1/dashboard/summary",
                params={
                    "start_date": today - timedelta(days=90),
                    "end_date": today - timedelta(days=1),
                    "within_days": 5,
                },
            )
            alerts_response = self.client.get(
                "/api/v1/dashboard/expiry-alerts",
                params={"within_days": 5, "limit": 20},
            )

        self.assertEqual(summary_response.status_code, 200, summary_response.text)
        self.assertEqual(alerts_response.status_code, 200, alerts_response.text)
        summary = summary_response.json()
        alerts = alerts_response.json()
        self.assertEqual(summary["expiry_window_days"], 5)
        self.assertEqual(summary["expired_batch_count"], 2)
        self.assertEqual(summary["expiring_soon_batch_count"], 2)
        self.assertEqual(summary["application_expired_batch_count"], 1)
        self.assertEqual(summary["application_expiring_soon_batch_count"], 1)
        self.assertEqual(summary["snapshot_expired_batch_count"], 1)
        self.assertEqual(summary["snapshot_expiring_soon_batch_count"], 1)
        self.assertEqual(sum(row["status"] == "expired" for row in alerts), summary["expired_batch_count"])
        self.assertEqual(
            sum(row["status"] == "expiring_soon" for row in alerts),
            summary["expiring_soon_batch_count"],
        )
        self.assertEqual(
            {(row["source"], row["batch_code"], row["days_to_expiry"]) for row in alerts},
            {
                ("application", "B-11", -2),
                ("application", "B-12", 5),
                ("inventory_snapshot", "CSV-101", -1),
                ("inventory_snapshot", "CSV-102", 5),
            },
        )

    def test_low_stock_uses_live_remaining_quantity_and_product_native_unit(self) -> None:
        kilograms = self.add_product(2, "Apples", "Fruits", "kg")
        litres = self.add_product(3, "Milk", "Dairy", "L")
        expired = self.add_product(4, "Expired Juice", "Beverages", "bottle")
        self.add_batch(21, kilograms.product_id, date.today() + timedelta(days=10), "6")
        self.add_batch(22, kilograms.product_id, date.today() + timedelta(days=12), "3")
        self.add_batch(23, litres.product_id, date.today() + timedelta(days=10), "10")
        self.add_batch(24, expired.product_id, date.today() - timedelta(days=1), "4")

        response = self.client.get("/api/v1/dashboard/low-stock", params={"reorder_level": 10, "limit": 100})

        self.assertEqual(response.status_code, 200, response.text)
        records = {row["product_name"]: row for row in response.json()}
        self.assertEqual(records["Apples"]["current_stock"], 9.0)
        self.assertEqual(records["Apples"]["unit"], "kg")
        self.assertEqual(records["Milk"]["current_stock"], 10.0)
        self.assertEqual(records["Milk"]["unit"], "L")
        self.assertEqual(records["Expired Juice"]["current_stock"], 0.0)
        self.assertEqual(records["Expired Juice"]["unit"], "bottle")
        self.assertTrue(all(row["source"] == "application" for row in records.values()))

    def test_category_distribution_uses_product_share_not_mixed_units(self) -> None:
        apple = self.add_product(2, "Apple", "Produce", "kg")
        milk = self.add_product(3, "Milk", "Dairy", "L")
        self.add_batch(21, apple.product_id, date.today() + timedelta(days=10), "3")
        self.add_batch(22, milk.product_id, date.today() + timedelta(days=10), "5")

        response = self.client.get("/api/v1/dashboard/category-distribution")

        data = response.json()
        self.assertEqual(data["measure"], "share_of_distinct_catalog_products")
        self.assertEqual(data["total_products"], 2)
        self.assertEqual({row["product_share_percent"] for row in data["categories"]}, {50.0})
        self.assertEqual(sum(row["available_quantity_by_unit"][0]["quantity"] for row in data["categories"]), 8.0)

    def test_real_csv_catalog_and_history_are_visible_but_not_operational_sales(self) -> None:
        csv_data = load_dashboard_csv_data()
        self.assertEqual(len(csv_data.catalog_products), 10)
        self.assertEqual(len(csv_data.sales_history), 1800)
        self.add_product(2, "User Edited Milk", "Dairy", "pack", "MLDATA-1001")
        self.add_product(3, "User Added Item", "Other", "each", "USER-003")
        with patch("app.api.v1.dashboard.load_dashboard_csv_data", return_value=csv_data):
            summary = self.client.get("/api/v1/dashboard/summary")
            categories = self.client.get("/api/v1/dashboard/category-distribution")
            sales = self.client.get(
                "/api/v1/dashboard/sales-demand",
                params={"start_date": "2026-04-01", "end_date": "2026-09-27"},
            )
            waste = self.client.get(
                "/api/v1/dashboard/waste-trend",
                params={"start_date": "2026-04-01", "end_date": "2026-09-27"},
            )
            expiry = self.client.get("/api/v1/dashboard/expiry-alerts", params={"within_days": 7, "limit": 5})
            recommendations = self.client.get("/api/v1/dashboard/recommendations", params={"limit": 5})
            top_products = self.client.get(
                "/api/v1/dashboard/top-products",
                params={"start_date": "2026-04-01", "end_date": "2026-09-27", "limit": 5},
            )
            low_stock = self.client.get("/api/v1/dashboard/low-stock", params={"limit": 5})
        self.assertEqual(summary.json()["product_count"], 11)
        self.assertEqual(summary.json()["imported_product_count"], 10)
        self.assertEqual(summary.json()["user_product_count"], 1)
        self.assertEqual(summary.json()["sales_revenue"], 0)
        self.assertEqual(categories.json()["total_products"], 11)
        self.assertGreater(len(categories.json()["categories"]), 1)
        self.assertEqual(sales.json()["actual_sales"], [])
        self.assertEqual(sum(row["quantity"] for row in sales.json()["imported_history"]), 36267)
        self.assertEqual(sales.json()["imported_history_status"]["source"], "ml/data/raw/perishable_inventory.csv")
        self.assertEqual(sum(row["quantity"] for row in waste.json()["imported_history"]), 2602)
        self.assertEqual(waste.json()["actual"], [])
        self.assertTrue(any(row["source"] == "inventory_snapshot" for row in expiry.json()))
        self.assertTrue(all(row["source"] == "simulated_scenario" for row in recommendations.json()))
        self.assertTrue(all(row["recommendation_id"] is None for row in recommendations.json()))
        self.assertTrue(any(row["source"] == "training_history" and row["revenue"] is None for row in top_products.json()))
        self.assertTrue(any(row["source"] == "inventory_snapshot" for row in low_stock.json()))

    def test_orphaned_import_provenance_does_not_hide_or_double_count_csv_products(self) -> None:
        self.add_product(2, "User Added Item", "Other", "each", "USER-002")
        self.db.add(
            DashboardImportRecord(
                source_file="products.csv",
                source_record_key="1001",
                entity_type="product",
                entity_id=999,
                import_run_id=1,
            )
        )
        csv_data = DashboardCsvData(
            catalog_products=(CsvProduct("1001", "Training Item", "Training Category", "unit", Decimal("9.00")),),
            sales_history=(),
            catalog_available=True,
            history_available=False,
            catalog_source="products.csv",
            history_source="perishable_inventory.csv",
        )
        with patch("app.api.v1.dashboard.load_dashboard_csv_data", return_value=csv_data):
            summary = self.client.get("/api/v1/dashboard/summary")
            categories = self.client.get("/api/v1/dashboard/category-distribution")

        self.assertEqual(summary.status_code, 200, summary.text)
        self.assertEqual(categories.status_code, 200, categories.text)
        self.assertEqual(summary.json()["product_count"], 2)
        self.assertEqual(summary.json()["user_product_count"], 1)
        self.assertEqual(summary.json()["imported_product_count"], 1)
        self.assertEqual(categories.json()["total_products"], summary.json()["product_count"])

    def test_date_range_validation_and_authenticated_access(self) -> None:
        invalid = self.client.get(
            "/api/v1/dashboard/top-products",
            params={"start_date": date.today(), "end_date": date.today() - timedelta(days=1)},
        )
        self.assertEqual(invalid.status_code, 422)
        too_wide = self.client.get(
            "/api/v1/dashboard/summary",
            params={"start_date": date.today() - timedelta(days=731), "end_date": date.today()},
        )
        self.assertEqual(too_wide.status_code, 422)
        self.user.role = "viewer"
        self.db.flush()
        viewer_response = self.client.get("/api/v1/dashboard/summary")
        self.assertEqual(viewer_response.status_code, 200)
        app.dependency_overrides.pop(get_current_user)
        unauthorized = self.client.get("/api/v1/dashboard/summary")
        self.assertEqual(unauthorized.status_code, 401)

    def test_top_products_low_stock_recommendations_and_activities_are_persisted_data(self) -> None:
        product = self.add_product(2, "Bread", "Bakery", "each")
        self.add_batch(31, product.product_id, date.today() + timedelta(days=30), "4")
        self.db.add(
            SaleRecord(
                sale_id=32,
                product_id=product.product_id,
                batch_id=31,
                sold_at=datetime.now(),
                quantity=Decimal("3"),
                unit_price=Decimal("12.50"),
                total_amount=Decimal("37.50"),
                source="manual",
            )
        )
        self.db.add(
            Recommendation(
                recommendation_id=33,
                product_id=product.product_id,
                recommendation_type="discount",
                recommended_quantity=None,
                discount_percent=Decimal("20"),
                reason="Persisted risk signal",
                status="pending",
            )
        )
        self.db.add(
            UserActivity(
                activity_id=34,
                user_id=self.user.user_id,
                action="sale_recorded",
                entity_type="sale",
                entity_id=32,
                created_at=datetime.now(),
            )
        )
        self.db.flush()

        self.assertEqual(self.client.get("/api/v1/dashboard/top-products").json()[0]["quantity_sold"], 3.0)
        self.assertEqual(self.client.get("/api/v1/dashboard/low-stock").json()[0]["current_stock"], 4.0)
        recommendation = self.client.get("/api/v1/dashboard/recommendations").json()[0]
        self.assertEqual(recommendation["suggested_price"], 10.0)
        activity = self.client.get("/api/v1/dashboard/recent-activities").json()[0]
        self.assertEqual(activity["actor_name"], "Test Manager")

    def test_database_errors_are_not_replaced_with_zero_metrics(self) -> None:
        class FailingSession:
            def scalar(self, *_args, **_kwargs):
                raise SQLAlchemyError("database unavailable")

            def execute(self, *_args, **_kwargs):
                raise SQLAlchemyError("database unavailable")

        with self.assertRaises(SQLAlchemyError):
            dashboard_summary(self.user, FailingSession())

    def test_empty_database_returns_explicit_empty_dashboard_collections(self) -> None:
        summary = self.client.get("/api/v1/dashboard/summary").json()
        sales = self.client.get("/api/v1/dashboard/sales-demand").json()
        categories = self.client.get("/api/v1/dashboard/category-distribution").json()
        waste = self.client.get("/api/v1/dashboard/waste-trend").json()
        self.assertEqual(summary["product_count"], 0)
        self.assertEqual(summary["sales_revenue"], 0)
        self.assertEqual(summary["waste_quantity_by_unit"], [])
        self.assertEqual(sales["actual_sales"], [])
        self.assertEqual(sales["imported_history"], [])
        self.assertEqual(sales["predicted_demand"], [])
        self.assertEqual(sales["prediction"]["status"], "unavailable")
        self.assertEqual(categories["categories"], [])
        self.assertEqual(waste["actual"], [])
        self.assertEqual(waste["imported_history"], [])
        for path in (
            "/api/v1/dashboard/expiry-alerts",
            "/api/v1/dashboard/recommendations",
            "/api/v1/dashboard/top-products",
            "/api/v1/dashboard/low-stock",
            "/api/v1/dashboard/recent-activities",
        ):
            self.assertEqual(self.client.get(path).json(), [])

    def test_missing_import_tables_do_not_break_actual_dashboard_metrics(self) -> None:
        product = self.add_product(2, "Current Product", "Produce", "kg")
        self.db.add(
            SaleRecord(
                sale_id=41,
                product_id=product.product_id,
                sold_at=datetime.combine(date.today(), datetime.min.time()),
                quantity=Decimal("2"),
                unit_price=Decimal("4.00"),
                total_amount=Decimal("8.00"),
                source="manual",
            )
        )
        self.db.add(
            WasteRecord(
                waste_id=42,
                product_id=product.product_id,
                quantity=Decimal("0.500"),
                reason="spoilage",
                waste_cost=Decimal("2.00"),
                recorded_at=datetime.combine(date.today(), datetime.min.time()),
            )
        )
        self.db.flush()
        with patch("app.api.v1.dashboard._import_table_available", return_value=False):
            summary = self.client.get("/api/v1/dashboard/summary")
            sales = self.client.get("/api/v1/dashboard/sales-demand")
            waste = self.client.get("/api/v1/dashboard/waste-trend")

        self.assertEqual(summary.status_code, 200, summary.text)
        self.assertEqual(summary.json()["sales_revenue"], 8.0)
        self.assertIsNone(summary.json()["imported_product_count"])
        self.assertEqual(summary.json()["imported_catalog"]["status"], "unavailable")
        self.assertEqual(sales.status_code, 200, sales.text)
        self.assertEqual(sales.json()["actual_sales"][0]["quantity"], 2.0)
        self.assertEqual(sales.json()["imported_history_status"]["status"], "unavailable")
        self.assertEqual(waste.status_code, 200, waste.text)
        self.assertEqual(waste.json()["actual"][0]["quantity"], 0.5)
        self.assertEqual(waste.json()["actual_record_count"], 1)
        self.assertEqual(waste.json()["imported_history_status"]["status"], "unavailable")

    def test_csv_import_is_idempotent_and_preserves_imported_product_edits(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            data_dir = Path(temporary_directory)
            user_product = self.add_product(2, "Milk", "Dairy", "L", "USER-MILK")
            products_path = data_dir / "products.csv"
            history_path = data_dir / "perishable_inventory.csv"
            products_path.write_text(
                "product_id,product_name,category,shelf_life_days,selling_price,unit_cost\n"
                "1001,Milk,Dairy,5,32.0,24.0\n",
                encoding="utf-8",
            )
            history_path.write_text(
                "product_id,date,category,opening_stock,units_received,units_sold,unit_price,discount_pct,days_to_expiry,temperature_c,waste_units,stockout_flag\n"
                "1001,2026-10-28,Dairy,12,0,3,32.0,0,2,4,1,0\n",
                encoding="utf-8",
            )

            first_runs = import_dashboard_csvs(self.db, data_dir)
            self.db.flush()
            imported_product = self.db.scalar(select(Product).where(Product.sku == "MLDATA-1001"))
            self.assertEqual(self.db.query(Product).filter_by(name="Milk").count(), 2)
            imported_product.name = "User Edited Milk"
            imported_product.price = Decimal("40.00")
            self.db.flush()
            second_runs = import_dashboard_csvs(self.db, data_dir)
            self.db.flush()

            self.assertEqual([run.rows_inserted for run in first_runs], [1, 1])
            self.assertEqual([run.rows_inserted for run in second_runs], [0, 0])
            self.assertEqual(imported_product.name, "User Edited Milk")
            self.assertEqual(imported_product.price, Decimal("40.00"))
            self.assertEqual(imported_product.category, "Dairy")
            self.assertEqual(imported_product.sku, "MLDATA-1001")
            self.assertNotEqual(imported_product.product_id, user_product.product_id)
            self.assertEqual(self.db.query(Product).filter_by(sku="MLDATA-1001").count(), 1)
            imported_history = self.db.scalar(select(DashboardHistoricalMetric))
            self.assertEqual(imported_history.sales_quantity, Decimal("3.000"))
            self.assertEqual(imported_history.waste_quantity, Decimal("1.000"))


if __name__ == "__main__":
    unittest.main()