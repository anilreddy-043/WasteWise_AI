import unittest
from datetime import date, timedelta
from decimal import Decimal

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.security import get_current_user
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models import CategoryShelfLifeSetting, InventoryBatch, Product, User
from app.services.expiry_dates import DEFAULT_SHELF_LIFE_DAYS


class ExpiryDateManagementTests(unittest.TestCase):
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
            email="expiry-manager@example.test",
            password_hash="unused",
            role="store_manager",
            approval_status="approved",
            is_active=True,
        )
        self.db.add(self.user)
        self.db.add_all(
            CategoryShelfLifeSetting(category=category, days=days)
            for category, days in DEFAULT_SHELF_LIFE_DAYS.items()
        )
        self.db.commit()
        app.dependency_overrides[get_db] = lambda: self.db
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.client = TestClient(app)
        self.received_at = date(2026, 11, 5)

    def tearDown(self) -> None:
        app.dependency_overrides.clear()
        self.db.close()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def create_product(self, category: str = "Seafood") -> Product:
        product = Product(
            name=f"Test {category}",
            category=category,
            sku=f"TEST-{len(self.db.scalars(select(Product)).all()) + 1}",
            unit="kg",
            price=Decimal("10.00"),
            supplier="Test Supplier",
        )
        self.db.add(product)
        self.db.commit()
        self.db.refresh(product)
        return product

    def post_batch(
        self,
        product: Product,
        batch_code: str,
        **overrides: object,
    ):
        payload: dict[str, object] = {
            "product_id": product.product_id,
            "batch_code": batch_code,
            "quantity_received": "10",
            "received_at": self.received_at.isoformat(),
            "location": "Test Store",
        }
        payload.update(overrides)
        return self.client.post("/api/v1/inventory/batches", json=payload)

    def test_category_defaults_calculate_every_supported_shelf_life(self) -> None:
        for index, (category, days) in enumerate(DEFAULT_SHELF_LIFE_DAYS.items()):
            with self.subTest(category=category):
                product = self.create_product(category)
                response = self.post_batch(
                    product,
                    f"EST-{index}",
                    expiry_date_source="estimated",
                )
                self.assertEqual(response.status_code, 201, response.text)
                self.assertEqual(
                    response.json()["expiry_date"],
                    (self.received_at + timedelta(days=days)).isoformat(),
                )
                self.assertEqual(response.json()["expiry_date_source"], "estimated")

    def test_estimated_expiry_recalculates_when_received_date_changes(self) -> None:
        product = self.create_product("Seafood")
        created = self.post_batch(product, "RECEIPT-CHANGE", expiry_date_source="estimated").json()
        new_received = self.received_at + timedelta(days=4)
        updated = self.client.patch(
            f"/api/v1/inventory/batches/{created['batch_id']}",
            json={
                "received_at": new_received.isoformat(),
                "expiry_date": created["expiry_date"],
                "expiry_date_source": "estimated",
            },
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["expiry_date"], (new_received + timedelta(days=2)).isoformat())

    def test_batch_update_supports_legacy_schema_without_expiry_provenance(self) -> None:
        product = self.create_product("Seafood")
        created = self.post_batch(
            product,
            "LEGACY-UPDATE",
            expiry_date=(self.received_at + timedelta(days=8)).isoformat(),
            expiry_date_source="manufacturer_verified",
        )
        self.assertEqual(created.status_code, 201, created.text)
        batch_id = created.json()["batch_id"]
        self.db.execute(text("ALTER TABLE inventory_batches DROP COLUMN expiry_date_source"))
        self.db.commit()

        updated = self.client.patch(
            f"/api/v1/inventory/batches/{batch_id}",
            json={
                "quantity_remaining": 7,
                "received_at": self.received_at.isoformat(),
                "expiry_date": (self.received_at + timedelta(days=8)).isoformat(),
                "expiry_date_source": None,
                "location": "Test Store",
                "supplier": "Test Supplier",
            },
        )

        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["quantity_remaining"], "7.000")
        self.assertIsNone(updated.json()["expiry_date_source"])
        self.assertEqual(
            self.db.scalar(
                select(InventoryBatch.quantity_remaining).where(InventoryBatch.batch_id == batch_id)
            ),
            Decimal("7.000"),
        )

    def test_batch_create_supports_legacy_schema_without_expiry_provenance(self) -> None:
        self.db.execute(text("ALTER TABLE inventory_batches DROP COLUMN expiry_date_source"))
        self.db.commit()
        product = self.create_product("Seafood")

        created = self.post_batch(
            product,
            "LEGACY-CREATE",
            expiry_date=(self.received_at + timedelta(days=8)).isoformat(),
            expiry_date_source="manufacturer_verified",
        )

        self.assertEqual(created.status_code, 201, created.text)
        self.assertIsNone(created.json()["expiry_date_source"])
        self.assertEqual(
            self.db.scalar(
                select(InventoryBatch.quantity_received).where(
                    InventoryBatch.batch_id == created.json()["batch_id"]
                )
            ),
            Decimal("10.000"),
        )

    def test_verified_expiry_date_is_not_replaced_by_a_default(self) -> None:
        product = self.create_product("Seafood")
        actual_expiry = self.received_at + timedelta(days=11)
        created = self.post_batch(
            product,
            "MANUFACTURER-DATE",
            expiry_date=actual_expiry.isoformat(),
            expiry_date_source="manufacturer_verified",
        )
        self.assertEqual(created.status_code, 201, created.text)
        self.assertEqual(created.json()["expiry_date"], actual_expiry.isoformat())
        self.assertEqual(created.json()["expiry_date_source"], "manufacturer_verified")
        updated_receipt = self.received_at - timedelta(days=1)
        updated = self.client.patch(
            f"/api/v1/inventory/batches/{created.json()['batch_id']}",
            json={"received_at": updated_receipt.isoformat(), "expiry_date_source": "manufacturer_verified"},
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["expiry_date"], actual_expiry.isoformat())
        self.assertEqual(updated.json()["expiry_date_source"], "manufacturer_verified")

    def test_csv_import_preserves_expiry_and_duplicate_batch_is_invalid(self) -> None:
        self.user.role = "admin"
        product = self.create_product("Dairy Products")
        imported_date = self.received_at + timedelta(days=20)
        csv_text = (
            "product_name,sku,category,unit,price,batch_code,quantity_received,received_at,expiry_date,location,supplier\n"
            f"{product.name},{product.sku},{product.category},{product.unit},{product.price},CSV-EXACT,5,{self.received_at.isoformat()},{imported_date.isoformat()},Test Store,{product.supplier}\n"
        )
        response = self.client.post(
            "/api/v1/inventory/batches/import/confirm",
            json={"csv_text": csv_text, "import_id": "expiry-import", "create_missing_products": False},
        )
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(response.json()["inserted"], 1)
        batch = self.db.scalar(
            select(InventoryBatch).where(InventoryBatch.batch_code == "CSV-EXACT")
        )
        self.assertIsNotNone(batch)
        self.assertEqual(batch.expiry_date, imported_date)
        self.assertEqual(batch.expiry_date_source, "imported")
        self.assertEqual(batch.quantity_received, Decimal("5.000"))

        duplicate_csv = csv_text + (
            f"{product.name},{product.sku},{product.category},{product.unit},{product.price},CSV-EXACT,8,"
            f"{self.received_at.isoformat()},{imported_date.isoformat()},Test Store,{product.supplier}\n"
        )
        duplicate = self.client.post(
            "/api/v1/inventory/batches/import/preview",
            json={"csv_text": duplicate_csv},
        )
        self.assertEqual(duplicate.status_code, 200, duplicate.text)
        self.assertEqual(duplicate.json()["invalid_count"], 2)

    def test_csv_without_expiry_is_rejected(self) -> None:
        self.user.role = "admin"
        product = self.create_product("Dairy Products")
        csv_text = (
            "product_name,sku,category,unit,price,batch_code,quantity_received,received_at,location,supplier\n"
            f"{product.name},{product.sku},{product.category},{product.unit},{product.price},CSV-NO-DATE,5,{self.received_at.isoformat()},Test Store,{product.supplier}\n"
        )
        response = self.client.post("/api/v1/inventory/batches/import/preview", json={"csv_text": csv_text})
        self.assertEqual(response.status_code, 422, response.text)
        self.assertIn("expiry_date", response.json()["detail"])

    def test_manual_expiry_override_is_persisted_with_provenance(self) -> None:
        product = self.create_product("Fruits")
        actual_date = self.received_at + timedelta(days=17)
        created = self.post_batch(
            product,
            "MANUAL-OVERRIDE",
            expiry_date=actual_date.isoformat(),
            expiry_date_source="manual_verified",
        )
        self.assertEqual(created.status_code, 201, created.text)
        persisted = self.db.get(InventoryBatch, created.json()["batch_id"])
        self.assertEqual(persisted.expiry_date, actual_date)
        self.assertEqual(persisted.expiry_date_source, "manual_verified")

    def test_expiry_before_received_date_is_rejected(self) -> None:
        product = self.create_product("Fruits")
        response = self.post_batch(
            product,
            "INVALID-DATE",
            expiry_date=(self.received_at - timedelta(days=1)).isoformat(),
            expiry_date_source="manufacturer_verified",
        )
        self.assertEqual(response.status_code, 422)
        self.assertIsNone(self.db.scalar(select(InventoryBatch.batch_id).where(
            InventoryBatch.batch_code == "INVALID-DATE"
        )))

    def test_unknown_category_requires_an_actual_expiry_date(self) -> None:
        product = self.create_product("Unmapped Produce")
        response = self.post_batch(product, "NO-DEFAULT", expiry_date_source="estimated")
        self.assertEqual(response.status_code, 422)
        self.assertIn("No shelf-life default", response.json()["detail"])

    def test_expiry_alerts_and_risk_endpoint_share_stored_batch_date(self) -> None:
        product = self.create_product("Seafood")
        actual_expiry = date.today() + timedelta(days=2)
        created = self.post_batch(
            product,
            "CONSISTENCY",
            expiry_date=actual_expiry.isoformat(),
            expiry_date_source="manufacturer_verified",
        )
        self.assertEqual(created.status_code, 201, created.text)
        batch_id = created.json()["batch_id"]
        alerts = self.client.get("/api/v1/expiry-alerts", params={"search": "CONSISTENCY"})
        risks = self.client.post("/api/v1/risk/expiry/predict", json={"batch_ids": [batch_id]})
        dashboard = self.client.get("/api/v1/dashboard/expiry-alerts", params={"within_days": 14})
        self.assertEqual(alerts.status_code, 200, alerts.text)
        self.assertEqual(risks.status_code, 200, risks.text)
        self.assertEqual(dashboard.status_code, 200, dashboard.text)
        alert = alerts.json()["items"][0]
        prediction = risks.json()[0]
        dashboard_batch = next(item for item in dashboard.json() if item["batch_id"] == batch_id)
        self.assertEqual(alert["expiry_date"], actual_expiry.isoformat())
        self.assertEqual(prediction["expiry_date"], actual_expiry.isoformat())
        self.assertEqual(dashboard_batch["expiry_date"], actual_expiry.isoformat())
        self.assertEqual(alert["expiry_date_source"], "manufacturer_verified")
        self.assertEqual(prediction["expiry_date_source"], "manufacturer_verified")
        self.assertEqual(dashboard_batch["expiry_date_source"], "manufacturer_verified")

    def test_legacy_batches_are_not_modified_by_default_calculation(self) -> None:
        product = self.create_product("Fruits")
        suspicious_expiry = self.received_at + timedelta(days=365)
        batch = InventoryBatch(
            product_id=product.product_id,
            batch_code="LEGACY-365",
            quantity_received=Decimal("4"),
            quantity_remaining=Decimal("4"),
            unit_cost=Decimal("1"),
            received_at=self.received_at,
            expiry_date=suspicious_expiry,
            expiry_date_source=None,
            location="Test Store",
        )
        self.db.add(batch)
        self.db.commit()
        original_dates = (batch.received_at, batch.expiry_date, batch.expiry_date_source)

        self.client.get("/api/v1/inventory/batches")
        self.client.get("/api/v1/expiry-alerts")
        self.client.post(
            "/api/v1/inventory/batches",
            json={
                "product_id": product.product_id,
                "batch_code": "UNRELATED-NEW",
                "quantity_received": "1",
                "received_at": self.received_at.isoformat(),
                "expiry_date_source": "estimated",
            },
        )
        self.db.refresh(batch)
        self.assertEqual((batch.received_at, batch.expiry_date, batch.expiry_date_source), original_dates)

    def test_shelf_life_changes_require_admin_role(self) -> None:
        denied = self.client.put(
            "/api/v1/inventory/shelf-life/Seafood",
            json={"days": 4},
        )
        self.assertEqual(denied.status_code, 403)
        self.user.role = "admin"
        self.db.commit()
        updated = self.client.put(
            "/api/v1/inventory/shelf-life/Seafood",
            json={"days": 4},
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["days"], 4)


if __name__ == "__main__":
    unittest.main()
