import csv
import io
import unittest
from datetime import date, datetime, timedelta
from decimal import Decimal
from unittest.mock import patch

from fastapi.testclient import TestClient
from openpyxl import load_workbook
from sqlalchemy import create_engine, delete, func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.security import get_current_user
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models import InventoryBatch, Product, SaleRecord, User, UserActivity, WasteRecord


class DataTransferApiTests(unittest.TestCase):
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
            email="transfer@example.test",
            password_hash="unused",
            role="admin",
            approval_status="approved",
            is_active=True,
        )
        self.product = Product(
            product_id=1,
            name="Fresh Milk",
            category="Dairy",
            sku="MILK-001",
            unit="L",
            price=Decimal("4.50"),
            supplier="Local Farm",
        )
        self.batch = InventoryBatch(
            batch_id=1,
            product_id=1,
            batch_code="MILK-LOT-1",
            quantity_received=Decimal("20"),
            quantity_remaining=Decimal("18"),
            unit_cost=Decimal("3.00"),
            received_at=date.today(),
            expiry_date=date.today() + timedelta(days=30),
            status="active",
            location="Cold room",
            supplier="Local Farm",
        )
        self.db.add_all([self.user, self.product, self.batch])
        self.db.commit()
        app.dependency_overrides[get_db] = lambda: self.db
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.client = TestClient(app)

    def tearDown(self) -> None:
        app.dependency_overrides.clear()
        self.client.close()
        self.db.close()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    @staticmethod
    def csv_file(headers: list[str], rows: list[list[str]], name: str) -> tuple[str, bytes, str]:
        output = io.StringIO(newline="")
        writer = csv.writer(output)
        writer.writerow(headers)
        writer.writerows(rows)
        return name, output.getvalue().encode("utf-8"), "text/csv"

    def test_imports_products_and_skips_duplicate_skus_without_overwriting(self) -> None:
        upload = self.csv_file(
            ["product_name", "category", "sku", "unit", "price", "supplier"],
            [
                ["Imported Apple", "Fruit", "APPLE-1", "kg", "2.50", "Farm"],
                ["Duplicate Milk", "Dairy", "MILK-001", "L", "8.00", "Other"],
            ],
            "products.csv",
        )

        response = self.client.post("/api/v1/data/imports/products", files={"file": upload})

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["successful_records"], 1)
        self.assertEqual(response.json()["skipped_records"], 1)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(Product)), 2)
        self.assertEqual(self.db.get(Product, 1).name, "Fresh Milk")

    def test_invalid_or_incomplete_product_file_is_atomic_and_reports_rows(self) -> None:
        upload = self.csv_file(
            ["product_name", "category", "sku", "unit", "price", "supplier"],
            [
                ["Valid Apple", "Fruit", "APPLE-1", "kg", "2.50", "Farm"],
                ["Bad Apple", "Fruit", "APPLE-2", "kg", "not-price", "Farm"],
            ],
            "products.csv",
        )
        response = self.client.post("/api/v1/data/imports/products", files={"file": upload})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["successful_records"], 0)
        self.assertEqual(response.json()["failed_records"], 1)
        self.assertEqual(response.json()["errors"][0]["row"], 3)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(Product)), 1)

        missing_columns = self.csv_file(["sku", "name"], [["X-1", "Example"]], "missing.csv")
        missing_response = self.client.post(
            "/api/v1/data/imports/products",
            files={"file": missing_columns},
        )
        self.assertEqual(missing_response.status_code, 422, missing_response.text)
        self.assertIn("missing required columns", missing_response.json()["detail"])
        failed_import = self.db.scalar(
            select(UserActivity).where(
                UserActivity.action == "data_import_failed",
                UserActivity.details["failure_reason"].as_string() == "invalid_csv",
            )
        )
        self.assertEqual(failed_import.details["failure_reason"], "invalid_csv")
        self.assertEqual(failed_import.details["dataset"], "products")

    def test_row_validation_failure_is_audited_without_storing_uploaded_values(self) -> None:
        upload = self.csv_file(
            ["product_name", "category", "sku", "unit", "price", "supplier"],
            [["Private Item Name", "Fruit", "BAD-PRICE-1", "kg", "not-price", "Private Supplier"]],
            "products.csv",
        )

        response = self.client.post("/api/v1/data/imports/products", files={"file": upload})

        self.assertEqual(response.status_code, 200, response.text)
        event = self.db.scalar(
            select(UserActivity).where(UserActivity.action == "data_import_failed")
        )
        self.assertEqual(event.details, {
            "dataset": "products",
            "failure_reason": "row_validation_failed",
            "failed_records": 1,
            "total_records": 1,
        })
        self.assertNotIn("Private Item Name", str(event.details))
        self.assertNotIn("Private Supplier", str(event.details))

    def test_import_does_not_return_validation_failure_if_audit_commit_fails(self) -> None:
        upload = self.csv_file(["name"], [["Invalid"]], "invalid.csv")
        with patch.object(self.db, "commit", side_effect=SQLAlchemyError("audit unavailable")):
            response = self.client.post("/api/v1/data/imports/products", files={"file": upload})

        self.assertEqual(response.status_code, 503, response.text)
        self.assertIn("audit event could not be saved", response.json()["detail"])

    def test_inventory_import_validates_product_ids_and_batch_duplicates(self) -> None:
        upload = self.csv_file(
            [
                "product_id", "batch_code", "quantity_received", "quantity_remaining",
                "unit_cost", "received_at", "expiry_date", "location",
            ],
            [[
                "1", "MILK-LOT-2", "12", "9", "2.75",
                date.today().isoformat(),
                (date.today() + timedelta(days=20)).isoformat(),
                "Cold room",
            ]],
            "inventory.csv",
        )
        response = self.client.post("/api/v1/data/imports/inventory", files={"file": upload})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["successful_records"], 1)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(InventoryBatch)), 2)

        invalid = self.csv_file(
            [
                "product_id", "batch_code", "quantity_received",
                "received_at", "expiry_date", "location",
            ],
            [[
                "999", "UNKNOWN-LOT", "2",
                date.today().isoformat(),
                (date.today() + timedelta(days=20)).isoformat(),
                "Cold room",
            ]],
            "invalid-inventory.csv",
        )
        invalid_response = self.client.post(
            "/api/v1/data/imports/inventory",
            files={"file": invalid},
        )
        self.assertEqual(invalid_response.status_code, 200, invalid_response.text)
        self.assertEqual(invalid_response.json()["failed_records"], 1)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(InventoryBatch)), 2)

    def test_sales_import_checks_product_batch_relationship_and_is_idempotent(self) -> None:
        headers = ["product_id", "batch_id", "sold_at", "quantity", "unit_price"]
        row = ["1", "1", "2026-11-06T12:30:00", "2.000", "4.50"]
        upload = self.csv_file(headers, [row], "sales.csv")
        first = self.client.post("/api/v1/data/imports/sales", files={"file": upload})
        replay = self.client.post("/api/v1/data/imports/sales", files={"file": upload})

        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()["successful_records"], 1)
        self.assertEqual(replay.status_code, 200, replay.text)
        self.assertEqual(replay.json()["successful_records"], 0)
        self.assertEqual(replay.json()["skipped_records"], 1)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(SaleRecord)), 1)
        self.assertEqual(self.db.scalar(select(SaleRecord.source)), "csv_import")
        self.assertEqual(self.db.get(InventoryBatch, 1).quantity_remaining, Decimal("18.000"))

        wrong_batch = self.csv_file(
            headers,
            [["1", "999", "2026-11-07T12:30:00", "1", "4.50"]],
            "wrong-batch.csv",
        )
        invalid = self.client.post("/api/v1/data/imports/sales", files={"file": wrong_batch})
        self.assertEqual(invalid.status_code, 200, invalid.text)
        self.assertEqual(invalid.json()["failed_records"], 1)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(SaleRecord)), 1)

        other_product = Product(
            product_id=2,
            name="Other Product",
            category="Other",
            sku="OTHER-1",
            unit="each",
            price=Decimal("1"),
            supplier="Other Supplier",
        )
        self.db.add(other_product)
        self.db.add(InventoryBatch(
            batch_id=2,
            product_id=2,
            batch_code="OTHER-LOT",
            quantity_received=Decimal("5"),
            quantity_remaining=Decimal("5"),
            unit_cost=Decimal("1"),
            received_at=date.today(),
            expiry_date=date.today() + timedelta(days=10),
            status="active",
            location="Shelf",
            supplier="Other Supplier",
        ))
        self.db.commit()
        mismatched_batch = self.csv_file(
            headers,
            [["1", "2", "2026-11-08T12:30:00", "1", "4.50"]],
            "mismatched-batch.csv",
        )
        mismatch_response = self.client.post(
            "/api/v1/data/imports/sales",
            files={"file": mismatched_batch},
        )
        self.assertEqual(mismatch_response.status_code, 200, mismatch_response.text)
        self.assertTrue(any("does not belong" in error for error in mismatch_response.json()["errors"][0]["errors"]))

    def test_import_upload_limits_format_and_permissions(self) -> None:
        invalid_extension = self.client.post(
            "/api/v1/data/imports/products",
            files={"file": ("products.xlsx", b"not csv", "application/octet-stream")},
        )
        self.assertEqual(invalid_extension.status_code, 415)

        too_large = self.client.post(
            "/api/v1/data/imports/products",
            files={"file": ("large.csv", b"a" * (5 * 1024 * 1024 + 1), "text/csv")},
        )
        self.assertEqual(too_large.status_code, 413)

        viewer = User(
            user_id=2,
            full_name="Viewer",
            email="viewer@example.test",
            password_hash="unused",
            role="viewer",
            approval_status="approved",
            is_active=True,
        )
        self.db.add(viewer)
        self.db.commit()
        app.dependency_overrides[get_current_user] = lambda: viewer
        upload = self.csv_file(
            ["product_name", "category", "sku", "unit", "price", "supplier"],
            [["Apple", "Fruit", "APPLE-2", "kg", "2.50", "Farm"]],
            "products.csv",
        )
        forbidden = self.client.post("/api/v1/data/imports/products", files={"file": upload})
        export = self.client.get("/api/v1/data/exports/products?format=csv")

        self.assertEqual(forbidden.status_code, 403, forbidden.text)
        self.assertEqual(export.status_code, 403, export.text)

    def test_store_manager_cannot_import_or_export_data(self) -> None:
        self.user.role = "store_manager"
        self.db.commit()
        upload = self.csv_file(
            ["product_name", "category", "sku", "unit", "price", "supplier"],
            [["Imported Apple", "Fruit", "APPLE-1", "kg", "2.50", "Farm"]],
            "products.csv",
        )

        self.assertEqual(
            self.client.post("/api/v1/data/imports/products", files={"file": upload}).status_code,
            403,
        )
        self.assertEqual(self.client.get("/api/v1/data/exports/products").status_code, 403)

    def test_csv_and_excel_exports_contain_mysql_records_and_empty_exports_have_headers(self) -> None:
        self.db.add(
            SaleRecord(
                product_id=1,
                batch_id=1,
                sold_at=datetime(2026, 11, 6, 12, 0),
                quantity=Decimal("2"),
                unit_price=Decimal("4.50"),
                total_amount=Decimal("9.00"),
                source="manual",
            )
        )
        self.db.add(WasteRecord(
            product_id=1,
            batch_id=1,
            recorded_by=1,
            quantity=Decimal("1"),
            reason="spoilage",
            waste_cost=Decimal("3"),
            notes="Test waste",
        ))
        self.db.commit()

        csv_response = self.client.get("/api/v1/data/exports/sales?format=csv")
        products_response = self.client.get("/api/v1/data/exports/products?format=csv")
        inventory_response = self.client.get("/api/v1/data/exports/inventory?format=csv")
        excel_response = self.client.get("/api/v1/data/exports/waste?format=xlsx")
        report_response = self.client.get("/api/v1/data/exports/reports?format=csv")
        self.db.execute(delete(SaleRecord))
        self.db.commit()
        empty_response = self.client.get("/api/v1/data/exports/sales?format=csv")

        self.assertEqual(csv_response.status_code, 200)
        self.assertIn("sold_at", csv_response.content.decode("utf-8-sig"))
        self.assertIn("provenance", products_response.content.decode("utf-8-sig"))
        self.assertIn("record_provenance", inventory_response.content.decode("utf-8-sig"))
        workbook = load_workbook(io.BytesIO(excel_response.content), read_only=True)
        self.assertEqual(workbook.active["A1"].value, "waste_id")
        self.assertEqual(workbook.active["C2"].value, "Fresh Milk")
        self.assertEqual(report_response.status_code, 200)
        self.assertIn("sales_revenue", report_response.content.decode("utf-8-sig"))
        self.assertEqual(len(empty_response.content.decode("utf-8-sig").splitlines()), 1)
        self.assertIn("sale_id", empty_response.content.decode("utf-8-sig"))
