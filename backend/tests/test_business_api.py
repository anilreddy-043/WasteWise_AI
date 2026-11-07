import unittest
from datetime import date, timedelta
from decimal import Decimal

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.security import get_current_user
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models import InventoryBatch, Product, User


class BusinessApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine, expire_on_commit=False)
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
        self.db.commit()
        app.dependency_overrides[get_db] = lambda: self.db
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.client = TestClient(app)

    def tearDown(self) -> None:
        app.dependency_overrides.clear()
        self.db.close()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def create_product(self) -> dict[str, object]:
        response = self.client.post(
            "/api/v1/products",
            json={
                "name": "  Fresh Milk  ",
                "category": "Dairy",
                "sku": "MILK-001",
                "unit": "L",
                "price": "4.50",
                "supplier": "Local Farm",
            },
        )
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def create_batch(self, product_id: int) -> dict[str, object]:
        response = self.client.post(
            "/api/v1/inventory/batches",
            json={
                "product_id": product_id,
                "batch_code": "LOT-001",
                "quantity_received": "10",
                "unit_cost": "3.00",
                "received_at": date.today().isoformat(),
                "expiry_date": (date.today() + timedelta(days=5)).isoformat(),
                "location": "Cold Room 1",
                "supplier": "Local Farm",
            },
        )
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(response.json()["location"], "Cold Room 1")
        self.assertEqual(response.json()["supplier"], "Local Farm")
        return response.json()

    def test_sku_suggestion_reads_all_existing_skus_and_returns_next_number(self) -> None:
        self.db.add_all([
            Product(name="Fruit One", category="Fruits", sku="FRU001", unit="Piece", price=1, supplier="Test"),
            Product(name="Fruit Four", category="Fruits", sku="FRU004", unit="Piece", price=1, supplier="Test"),
            Product(name="Fruit Six", category="Fruits", sku="fru006", unit="Piece", price=1, supplier="Test"),
            Product(name="Vegetable Four", category="Vegetables", sku="VEG004", unit="Kg", price=1, supplier="Test"),
        ])
        self.db.commit()
        count_before = self.db.scalar(select(func.count()).select_from(Product))

        fruit = self.client.get("/api/v1/products/sku-suggestion", params={"category": "Fruits"})
        vegetable = self.client.get("/api/v1/products/sku-suggestion", params={"category": "Vegetables"})
        invalid = self.client.get("/api/v1/products/sku-suggestion", params={"category": "Unlisted"})

        self.assertEqual(fruit.status_code, 200, fruit.text)
        self.assertEqual(fruit.json(), {"category": "Fruits", "prefix": "FRU", "sku": "FRU007"})
        self.assertEqual(vegetable.json()["sku"], "VEG005")
        self.assertEqual(invalid.status_code, 422)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(Product)), count_before)

    def test_sku_suggestion_supports_all_approved_category_prefixes(self) -> None:
        expected_prefixes = {
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
        for category, prefix in expected_prefixes.items():
            with self.subTest(category=category):
                response = self.client.get(
                    "/api/v1/products/sku-suggestion", params={"category": category}
                )
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["prefix"], prefix)
                self.assertEqual(response.json()["sku"], f"{prefix}001")

    def test_unique_sku_constraint_rejects_stale_simultaneous_suggestions(self) -> None:
        first_suggestion = self.client.get(
            "/api/v1/products/sku-suggestion", params={"category": "Fruits"}
        ).json()
        second_suggestion = self.client.get(
            "/api/v1/products/sku-suggestion", params={"category": "Fruits"}
        ).json()
        self.assertEqual(first_suggestion["sku"], second_suggestion["sku"])

        payload = {
            "name": "Banana",
            "category": "Fruits",
            "sku": first_suggestion["sku"],
            "unit": "Piece (pcs)",
            "price": "1.00",
            "supplier": "Test",
        }
        created = self.client.post("/api/v1/products", json=payload)
        duplicate = self.client.post("/api/v1/products", json={**payload, "name": "Another Banana"})

        self.assertEqual(created.status_code, 201, created.text)
        self.assertEqual(duplicate.status_code, 409, duplicate.text)
        self.assertEqual(duplicate.json()["detail"], "A product with this SKU already exists.")
        self.assertEqual(self.db.scalar(select(func.count()).select_from(Product)), 1)

    def test_product_update_rejects_an_sku_used_by_another_product(self) -> None:
        first = self.client.post(
            "/api/v1/products",
            json={
                "name": "First Item",
                "category": "Fruits",
                "sku": "FRU901",
                "unit": "Piece",
                "price": "1.00",
                "supplier": "Test",
            },
        ).json()
        self.client.post(
            "/api/v1/products",
            json={
                "name": "Second Item",
                "category": "Fruits",
                "sku": "FRU902",
                "unit": "Piece",
                "price": "1.00",
                "supplier": "Test",
            },
        )

        duplicate_update = self.client.put(
            f"/api/v1/products/{first['product_id']}",
            json={
                "name": "First Item",
                "category": "Fruits",
                "sku": "FRU902",
                "unit": "Piece",
                "price": "1.00",
                "supplier": "Test",
            },
        )

        self.assertEqual(duplicate_update.status_code, 409, duplicate_update.text)
        self.assertEqual(
            self.db.get(Product, first["product_id"]).sku,
            "FRU901",
        )

    def test_product_batch_sale_and_waste_operations_persist_and_reconcile_stock(self) -> None:
        product = self.create_product()
        self.assertEqual(product["name"], "Fresh Milk")
        self.assertEqual(product["sku"], "MILK-001")
        batch = self.create_batch(product["product_id"])

        sale_response = self.client.post(
            "/api/v1/sales",
            json={
                "product_id": product["product_id"],
                "batch_id": batch["batch_id"],
                "quantity": "3",
                "unit_price": "4.50",
            },
        )
        self.assertEqual(sale_response.status_code, 201, sale_response.text)
        self.assertEqual(sale_response.json()["total_amount"], "13.50")

        waste_response = self.client.post(
            "/api/v1/waste",
            json={
                "product_id": product["product_id"],
                "batch_id": batch["batch_id"],
                "quantity": "2",
                "reason": "spoilage",
                "waste_cost": "6.00",
            },
        )
        self.assertEqual(waste_response.status_code, 201, waste_response.text)

        stored_batch = self.db.get(InventoryBatch, batch["batch_id"])
        self.assertEqual(stored_batch.quantity_remaining, Decimal("5.000"))
        self.assertEqual(len(self.client.get("/api/v1/sales").json()), 1)
        self.assertEqual(len(self.client.get("/api/v1/waste").json()), 1)
        inventory = self.client.get("/api/v1/inventory/summary")
        self.assertEqual(inventory.status_code, 200, inventory.text)
        self.assertEqual(inventory.json()[0]["quantity"], 5.0)
        self.assertEqual(inventory.json()[0]["source"], "actual")
        self.assertEqual(inventory.json()[0]["sku"], "MILK-001")

        oversell = self.client.post(
            "/api/v1/sales",
            json={
                "product_id": product["product_id"],
                "batch_id": batch["batch_id"],
                "quantity": "6",
                "unit_price": "4.50",
            },
        )
        self.assertEqual(oversell.status_code, 409, oversell.text)
        self.assertEqual(stored_batch.quantity_remaining, Decimal("5.000"))

    def test_updates_are_validated_and_history_protects_linked_deletes(self) -> None:
        product = self.create_product()
        batch = self.create_batch(product["product_id"])

        update_product = self.client.put(
            f"/api/v1/products/{product['product_id']}",
            json={
                "name": "Milk",
                "category": "Dairy",
                "sku": "MILK-001",
                "unit": "L",
                "price": "4.75",
                "supplier": "Local Farm",
            },
        )
        self.assertEqual(update_product.status_code, 200, update_product.text)
        self.assertEqual(update_product.json()["price"], "4.75")

        update_batch = self.client.patch(
            f"/api/v1/inventory/batches/{batch['batch_id']}",
            json={"quantity_remaining": "8", "location": "Cold Room 2", "supplier": "Farm Two"},
        )
        self.assertEqual(update_batch.status_code, 200, update_batch.text)
        self.assertEqual(update_batch.json()["quantity_remaining"], "8.000")
        self.assertEqual(update_batch.json()["location"], "Cold Room 2")
        self.assertEqual(update_batch.json()["supplier"], "Farm Two")

        received_at = date.today() - timedelta(days=1)
        expiry_date = date.today() + timedelta(days=3)
        update_batch_dates = self.client.patch(
            f"/api/v1/inventory/batches/{batch['batch_id']}",
            json={
                "received_at": received_at.isoformat(),
                "expiry_date": expiry_date.isoformat(),
            },
        )
        self.assertEqual(update_batch_dates.status_code, 200, update_batch_dates.text)
        self.assertEqual(update_batch_dates.json()["received_at"], received_at.isoformat())
        self.assertEqual(update_batch_dates.json()["expiry_date"], expiry_date.isoformat())
        self.db.expire_all()
        stored_batch = self.db.get(InventoryBatch, batch["batch_id"])
        self.assertEqual(stored_batch.received_at, received_at)
        self.assertEqual(stored_batch.expiry_date, expiry_date)
        alerts = self.client.get("/api/v1/dashboard/expiry-alerts", params={"within_days": 7})
        self.assertEqual(alerts.status_code, 200, alerts.text)
        updated_alert = next(
            alert for alert in alerts.json()
            if alert["source"] == "application" and alert["batch_id"] == batch["batch_id"]
        )
        self.assertEqual(updated_alert["expiry_date"], expiry_date.isoformat())
        self.assertEqual(updated_alert["days_to_expiry"], 3)

        invalid_null_location = self.client.patch(
            f"/api/v1/inventory/batches/{batch['batch_id']}",
            json={"location": None},
        )
        self.assertEqual(invalid_null_location.status_code, 422, invalid_null_location.text)

        invalid_batch = self.client.patch(
            f"/api/v1/inventory/batches/{batch['batch_id']}",
            json={"quantity_received": "7"},
        )
        self.assertEqual(invalid_batch.status_code, 422, invalid_batch.text)
        self.assertEqual(
            self.db.scalar(select(InventoryBatch.quantity_received).where(
                InventoryBatch.batch_id == batch["batch_id"]
            )),
            Decimal("10.000"),
        )

        linked_sale = self.client.post(
            "/api/v1/sales",
            json={
                "product_id": product["product_id"],
                "batch_id": batch["batch_id"],
                "quantity": "1",
                "unit_price": "4.75",
            },
        )
        self.assertEqual(linked_sale.status_code, 201, linked_sale.text)
        self.assertEqual(
            self.client.delete(f"/api/v1/inventory/batches/{batch['batch_id']}").status_code,
            409,
        )
        self.assertEqual(
            self.client.delete(f"/api/v1/products/{product['product_id']}").status_code,
            409,
        )

    def test_artifact_metrics_are_reported_without_loading_model_binaries(self) -> None:
        response = self.client.get("/api/v1/model-metrics")
        self.assertEqual(response.status_code, 200, response.text)
        metrics = response.json()
        self.assertTrue(metrics)
        self.assertTrue(all(item["source"] == "artifact_metrics" for item in metrics))
        self.assertTrue(all(item["sample_size"] > 0 for item in metrics))

    def test_dataset_import_is_idempotent_without_automatically_retraining_models(self) -> None:
        self.user.role = "admin"
        self.db.commit()
        first = self.client.post("/api/v1/datasets/import")
        self.assertEqual(first.status_code, 202, first.text)
        self.assertEqual(
            first.json()["training"],
            "not_started_requires_explicit_confirmation",
        )

        first_product_count = self.db.scalar(select(func.count()).select_from(Product))
        second = self.client.post("/api/v1/datasets/import")
        self.assertEqual(second.status_code, 202, second.text)
        self.assertEqual(
            self.db.scalar(select(func.count()).select_from(Product)),
            first_product_count,
        )
        self.assertTrue(
            all(item["rows_inserted"] == 0 for item in second.json()["imports"])
        )

    def test_cors_preflight_allows_frontend_update_and_delete_methods(self) -> None:
        headers = {
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "PUT",
            "Access-Control-Request-Headers": "authorization,content-type",
        }
        response = self.client.options("/api/v1/products/1", headers=headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("PUT", response.headers["access-control-allow-methods"])
