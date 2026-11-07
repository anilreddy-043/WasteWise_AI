import csv
import io
import unittest
from datetime import date, timedelta
from decimal import Decimal

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.security import get_current_user
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models import InventoryBatch, Product, User


class BatchCsvImportApiTests(unittest.TestCase):
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
            full_name="Test Administrator",
            email="admin@example.test",
            password_hash="unused",
            role="admin",
            approval_status="approved",
            is_active=True,
        )
        self.db.add(self.user)
        self.product = Product(
            name="Fresh Milk",
            category="Dairy",
            sku="MILK-001",
            unit="L",
            price=Decimal("4.50"),
            supplier="Local Farm",
        )
        self.db.add(self.product)
        self.db.commit()
        app.dependency_overrides[get_db] = lambda: self.db
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.client = TestClient(app)

    def tearDown(self) -> None:
        app.dependency_overrides.clear()
        self.db.close()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def csv_text(self, rows: list[dict[str, str]]) -> str:
        columns = [
            "product_name", "sku", "category", "unit", "price", "batch_code",
            "quantity_received", "quantity_remaining", "unit_cost", "received_at",
            "expiry_date", "location", "supplier",
        ]
        output = io.StringIO(newline="")
        writer = csv.DictWriter(output, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rows)
        return output.getvalue()

    def row(self, **overrides: str) -> dict[str, str]:
        today = date.today()
        record = {
            "product_name": "Fresh Milk",
            "sku": "MILK-001",
            "category": "Dairy",
            "unit": "L",
            "price": "4.50",
            "batch_code": "LOT-001",
            "quantity_received": "12.5",
            "quantity_remaining": "10",
            "unit_cost": "3.25",
            "received_at": today.isoformat(),
            "expiry_date": (today + timedelta(days=30)).isoformat(),
            "location": "Cold Room",
            "supplier": "Local Farm",
        }
        record.update(overrides)
        return record

    def test_batch_csv_import_is_admin_only(self) -> None:
        self.user.role = "store_manager"
        response = self.client.post(
            "/api/v1/inventory/batches/import/preview",
            json={"csv_text": self.csv_text([self.row()])},
        )
        self.assertEqual(response.status_code, 403, response.text)

    def test_preview_matches_by_sku_and_name_fallback_and_validates_duplicates(self) -> None:
        preview = self.client.post(
            "/api/v1/inventory/batches/import/preview",
            json={"csv_text": self.csv_text([self.row(batch_code="SKU-LOT"), self.row(sku="", batch_code="NAME-LOT")])},
        )
        self.assertEqual(preview.status_code, 200, preview.text)
        self.assertEqual(preview.json()["valid_count"], 2)
        self.assertEqual(preview.json()["rows"][0]["product_status"], "matched_by_sku")
        self.assertEqual(preview.json()["rows"][1]["product_status"], "matched_by_name")

        duplicates = self.client.post(
            "/api/v1/inventory/batches/import/preview",
            json={"csv_text": self.csv_text([self.row(), self.row()])},
        )
        self.assertEqual(duplicates.status_code, 200, duplicates.text)
        self.assertEqual(duplicates.json()["invalid_count"], 2)
        self.assertTrue(all(any("Duplicate batch number" in error for error in row["errors"]) for row in duplicates.json()["rows"]))

        invalid_values = self.client.post(
            "/api/v1/inventory/batches/import/preview",
            json={"csv_text": self.csv_text([self.row(quantity_received="-2", received_at="not-a-date")])},
        )
        self.assertEqual(invalid_values.status_code, 200, invalid_values.text)
        self.assertEqual(invalid_values.json()["invalid_count"], 1)
        self.assertTrue(any("nonnegative" in error for error in invalid_values.json()["rows"][0]["errors"]))
        self.assertTrue(any("YYYY-MM-DD" in error for error in invalid_values.json()["rows"][0]["errors"]))

    def test_import_supports_legacy_schema_without_expiry_source_column(self) -> None:
        self.db.execute(text("ALTER TABLE inventory_batches DROP COLUMN expiry_date_source"))
        self.db.commit()
        response = self.client.post(
            "/api/v1/inventory/batches/import/confirm",
            json={
                "csv_text": self.csv_text([self.row(batch_code="LEGACY-LOT")]),
                "import_id": "legacy-schema-import",
                "create_missing_products": False,
            },
        )
        self.assertEqual(response.status_code, 201, response.text)
        self.assertIsNone(response.json()["batches"][0]["expiry_date_source"])
        count = self.db.scalar(text("SELECT COUNT(*) FROM inventory_batches WHERE batch_code = 'LEGACY-LOT'"))
        self.assertEqual(count, 1)

    def test_confirm_import_updates_inventory_and_rejects_replay(self) -> None:
        csv_text = self.csv_text([self.row()])
        payload = {
            "csv_text": csv_text,
            "import_id": "import-unique-001",
            "create_missing_products": False,
        }
        imported = self.client.post("/api/v1/inventory/batches/import/confirm", json=payload)
        self.assertEqual(imported.status_code, 201, imported.text)
        self.assertEqual(imported.json()["inserted"], 1)
        batch = self.db.scalar(select(InventoryBatch).where(InventoryBatch.batch_code == "LOT-001"))
        self.assertIsNotNone(batch)
        self.assertEqual(batch.product_id, self.product.product_id)
        self.assertEqual(batch.quantity_received, Decimal("12.500"))
        self.assertEqual(batch.quantity_remaining, Decimal("10.000"))
        self.assertEqual(batch.location, "Cold Room")
        self.assertEqual(batch.supplier, "Local Farm")
        summary = self.client.get("/api/v1/inventory/summary")
        self.assertEqual(summary.status_code, 200, summary.text)
        self.assertEqual(Decimal(str(summary.json()[0]["quantity"])), Decimal("10.000"))

        replay = self.client.post("/api/v1/inventory/batches/import/confirm", json=payload)
        self.assertEqual(replay.status_code, 422, replay.text)
        history = self.client.get("/api/v1/inventory/batches/imports")
        self.assertEqual(history.status_code, 200, history.text)
        self.assertEqual(history.json()[0]["import_id"], "import-unique-001")

    def test_missing_product_requires_explicit_confirmation_and_is_created_once(self) -> None:
        rows = [
            self.row(
                product_name="New Yogurt", sku="YOG-001", category="Dairy", unit="Cup",
                price="2.00", supplier="New Supplier", batch_code="YOG-LOT-1",
            ),
            self.row(
                product_name="New Yogurt", sku="YOG-001", category="Dairy", unit="Cup",
                price="2.00", supplier="New Supplier", batch_code="YOG-LOT-2",
            ),
        ]
        csv_text = self.csv_text(rows)
        no_confirmation = self.client.post(
            "/api/v1/inventory/batches/import/confirm",
            json={"csv_text": csv_text, "import_id": "new-product-import", "create_missing_products": False},
        )
        self.assertEqual(no_confirmation.status_code, 422)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(Product)), 1)

        imported = self.client.post(
            "/api/v1/inventory/batches/import/confirm",
            json={"csv_text": csv_text, "import_id": "new-product-import", "create_missing_products": True},
        )
        self.assertEqual(imported.status_code, 201, imported.text)
        self.assertEqual(imported.json()["products_created"], 1)
        product = self.db.get(Product, imported.json()["batches"][0]["product_id"])
        self.assertIsNotNone(
            product,
            f"Import response: {imported.json()}, products: "
            f"{[(row.product_id, row.name, row.sku) for row in self.db.scalars(select(Product)).all()]}",
        )
        self.assertEqual(product.sku, "YOG-001")
        self.assertEqual(self.db.scalar(select(func.count()).select_from(InventoryBatch).where(
            InventoryBatch.product_id == product.product_id
        )), 2)

    def test_database_failure_rolls_back_all_products_batches_and_history(self) -> None:
        self.db.execute(text(
            "CREATE TRIGGER fail_second_batch BEFORE INSERT ON inventory_batches "
            "WHEN NEW.batch_code = 'FAIL-LOT' BEGIN SELECT RAISE(ABORT, 'forced test failure'); END"
        ))
        self.db.commit()
        rows = [
            self.row(
                product_name="Rollback Product", sku="ROLL-001", category="Dairy", unit="L",
                price="1.00", supplier="Rollback Supplier", batch_code="OK-LOT",
            ),
            self.row(
                product_name="Rollback Product", sku="ROLL-001", category="Dairy", unit="L",
                price="1.00", supplier="Rollback Supplier", batch_code="FAIL-LOT",
            ),
        ]
        response = self.client.post(
            "/api/v1/inventory/batches/import/confirm",
            json={"csv_text": self.csv_text(rows), "import_id": "rollback-import", "create_missing_products": True},
        )
        self.assertEqual(response.status_code, 409, response.text)
        self.assertIsNone(self.db.scalar(select(Product).where(Product.sku == "ROLL-001")))
        self.assertEqual(self.db.scalar(select(func.count()).select_from(InventoryBatch)), 0)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(
            Base.metadata.tables["user_activity"]
        )), 0)

    def test_staff_cannot_preview_or_confirm_imports(self) -> None:
        self.user.role = "staff"
        self.db.commit()
        csv_text = self.csv_text([self.row()])
        preview = self.client.post("/api/v1/inventory/batches/import/preview", json={"csv_text": csv_text})
        confirm = self.client.post(
            "/api/v1/inventory/batches/import/confirm",
            json={"csv_text": csv_text, "import_id": "staff-import", "create_missing_products": False},
        )
        self.assertEqual(preview.status_code, 403)
        self.assertEqual(confirm.status_code, 403)


if __name__ == "__main__":
    unittest.main()
