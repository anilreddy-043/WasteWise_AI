import unittest
from datetime import date, timedelta
from decimal import Decimal
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text
from sqlalchemy.exc import OperationalError, SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.security import get_current_user
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models import InventoryBatch, Product, Recommendation, SaleRecord, SalesTransaction, User, UserActivity
from app.schemas import TransactionResponse


class SalesCheckoutTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine, expire_on_commit=False)
        self.user = User(user_id=1, full_name="Test Manager", email="pos@example.test", password_hash="unused", role="store_manager", approval_status="approved", is_active=True)
        self.product = Product(name="Mangoes", category="Fruits", sku="MANGO-001", unit="kg", price="12.50", supplier="Farm")
        self.db.add_all([self.user, self.product])
        self.db.flush()
        self.db.add_all([
            InventoryBatch(product_id=self.product.product_id, batch_code="MANGO-EARLY", quantity_received="10", quantity_remaining="10", unit_cost="8", received_at=date.today(), expiry_date=date.today() + timedelta(days=2), status="active", location="A", supplier="Farm"),
            InventoryBatch(product_id=self.product.product_id, batch_code="MANGO-LATER", quantity_received="10", quantity_remaining="10", unit_cost="8", received_at=date.today(), expiry_date=date.today() + timedelta(days=5), status="active", location="A", supplier="Farm"),
        ])
        self.db.commit()
        app.dependency_overrides[get_db] = lambda: self.db
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.client = TestClient(app)

    def tearDown(self) -> None:
        app.dependency_overrides.clear()
        self.db.close()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def test_checkout_allocates_fefo_and_idempotency(self) -> None:
        payload = {
            "items": [{"product_id": self.product.product_id, "quantity": "12", "price": "0.01"}],
            "discount": {"type": "percentage", "value": "10"},
            "payment_method": "card",
            "idempotency_key": "pos-test-key-1",
        }
        first = self.client.post("/api/v1/sales/checkout", json=payload)
        self.assertEqual(first.status_code, 201, first.text)
        self.assertEqual(first.json()["total_amount"], "135.00")
        allocations = first.json()["items"][0]["allocations"]
        self.assertEqual(len(allocations), 2)
        self.assertEqual([row["quantity_allocated"] for row in allocations], ["10.000", "2.000"])
        mirrored_sales = list(self.db.scalars(select(SaleRecord)))
        self.assertEqual(sum((sale.total_amount for sale in mirrored_sales), Decimal("0")), Decimal("135.00"))

        second = self.client.post("/api/v1/sales/checkout", json=payload)
        self.assertEqual(second.status_code, 201, second.text)
        self.assertEqual(second.json()["sale_transaction_id"], first.json()["sale_transaction_id"])
        listed = self.client.get("/api/v1/sales/transactions?limit=10")
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertEqual(len(listed.json()), 1)
        self.assertEqual(listed.json()[0]["total_amount"], "135.00")
        self.assertEqual(listed.json()[0]["items"][0]["line_total"], "135.00")
        self.assertEqual(len(listed.json()[0]["items"][0]["allocations"]), 2)
        transaction_count = self.db.scalar(select(__import__("sqlalchemy").func.count()).select_from(SalesTransaction))
        self.assertEqual(transaction_count, 1)

        batches = list(self.db.scalars(select(InventoryBatch).order_by(InventoryBatch.expiry_date)))
        self.assertEqual(str(batches[0].quantity_remaining), "0.000")
        self.assertEqual(batches[0].status, "depleted")
        self.assertEqual(str(batches[1].quantity_remaining), "8.000")

    def test_staff_and_viewer_cannot_checkout(self) -> None:
        self.user.role = "staff"
        staff_response = self.client.post("/api/v1/sales/checkout", json={
            "items": [{"product_id": self.product.product_id, "quantity": "1"}],
            "discount": {"type": "none", "value": "0"},
            "payment_method": "cash",
            "idempotency_key": "staff-checkout",
        })
        self.assertEqual(staff_response.status_code, 403, staff_response.text)

        self.user.role = "viewer"
        viewer_response = self.client.post("/api/v1/sales/checkout", json={
            "items": [{"product_id": self.product.product_id, "quantity": "1"}],
            "discount": {"type": "none", "value": "0"},
            "payment_method": "cash",
            "idempotency_key": "viewer-checkout",
        })
        self.assertEqual(viewer_response.status_code, 403, viewer_response.text)

    def test_approved_batch_discount_is_applied_automatically(self) -> None:
        batch = self.db.scalar(select(InventoryBatch).order_by(InventoryBatch.expiry_date.asc()))
        assert batch is not None
        self.db.add(Recommendation(
            product_id=self.product.product_id,
            batch_id=batch.batch_id,
            recommendation_type="discount",
            discount_percent=Decimal("10"),
            reason="Test approved discount",
            status="approved",
        ))
        self.db.commit()

        response = self.client.post("/api/v1/sales/checkout", json={
            "items": [{"product_id": self.product.product_id, "quantity": "1"}],
            "discount": {"type": "none", "value": "0"},
            "payment_method": "cash",
            "idempotency_key": "automatic-discount-test",
        })

        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(response.json()["subtotal"], "12.50")
        self.assertEqual(response.json()["discount_amount"], "1.25")
        self.assertEqual(response.json()["total_amount"], "11.25")

    def test_invalid_quantity_and_discount_are_rejected(self) -> None:
        invalid_quantity = self.client.post("/api/v1/sales/checkout", json={
            "items": [{"product_id": self.product.product_id, "quantity": "0"}],
            "discount": {"type": "none", "value": "0"},
            "payment_method": "cash",
            "idempotency_key": "invalid-quantity",
        })
        self.assertEqual(invalid_quantity.status_code, 422, invalid_quantity.text)

        invalid_discount = self.client.post("/api/v1/sales/checkout", json={
            "items": [{"product_id": self.product.product_id, "quantity": "1"}],
            "discount": {"type": "percentage", "value": "101"},
            "payment_method": "cash",
            "idempotency_key": "invalid-discount",
        })
        self.assertEqual(invalid_discount.status_code, 422, invalid_discount.text)
        self.assertEqual(
            self.db.scalar(select(__import__("sqlalchemy").func.count()).select_from(SalesTransaction)),
            0,
        )

    def test_expired_batches_are_not_allocated(self) -> None:
        for batch in self.db.scalars(select(InventoryBatch)):
            batch.expiry_date = date.today() - timedelta(days=1)
        self.db.commit()

        response = self.client.post("/api/v1/sales/checkout", json={
            "items": [{"product_id": self.product.product_id, "quantity": "1"}],
            "discount": {"type": "none", "value": "0"},
            "payment_method": "cash",
            "idempotency_key": "expired-batches",
        })
        self.assertEqual(response.status_code, 409, response.text)
        self.assertIn("Insufficient stock", response.json()["detail"])
        self.assertEqual(
            self.db.scalar(select(__import__("sqlalchemy").func.count()).select_from(SalesTransaction)),
            0,
        )
        self.assertEqual(
            sum(batch.quantity_remaining for batch in self.db.scalars(select(InventoryBatch))),
            Decimal("20.000"),
        )

    def test_checkout_supports_inventory_schema_without_expiry_date_source(self) -> None:
        self.db.execute(text("ALTER TABLE inventory_batches DROP COLUMN expiry_date_source"))
        self.db.commit()

        response = self.client.post("/api/v1/sales/checkout", json={
            "items": [{"product_id": self.product.product_id, "quantity": "1"}],
            "discount": {"type": "none", "value": "0"},
            "payment_method": "cash",
            "idempotency_key": "missing-expiry-date-source",
        })

        self.assertEqual(response.status_code, 201, response.text)
        remaining = sum(self.db.scalars(select(InventoryBatch.quantity_remaining)))
        self.assertEqual(remaining, Decimal("19.000"))

    def test_second_checkout_cannot_oversell_batch_stock(self) -> None:
        first = self.client.post("/api/v1/sales/checkout", json={
            "items": [{"product_id": self.product.product_id, "quantity": "20"}],
            "discount": {"type": "none", "value": "0"},
            "payment_method": "cash",
            "idempotency_key": "oversell-first",
        })
        self.assertEqual(first.status_code, 201, first.text)
        second = self.client.post("/api/v1/sales/checkout", json={
            "items": [{"product_id": self.product.product_id, "quantity": "1"}],
            "discount": {"type": "none", "value": "0"},
            "payment_method": "cash",
            "idempotency_key": "oversell-second",
        })
        self.assertEqual(second.status_code, 409, second.text)
        remaining = sum(batch.quantity_remaining for batch in self.db.scalars(select(InventoryBatch)))
        self.assertEqual(str(remaining), "0.000")

    def test_audit_failure_rolls_back_sale_and_inventory(self) -> None:
        original_add = self.db.add
        def reject_audit(instance) -> None:
            if isinstance(instance, UserActivity):
                raise RuntimeError("audit failure")
            return original_add(instance)

        with patch.object(self.db, "add", side_effect=reject_audit):
            response = self.client.post("/api/v1/sales/checkout", json={
                "items": [{"product_id": self.product.product_id, "quantity": "1"}],
                "discount": {"type": "none", "value": "0"},
                "payment_method": "cash",
                "idempotency_key": "rollback-audit",
            })
        self.assertEqual(response.status_code, 500)
        remaining = sum(batch.quantity_remaining for batch in self.db.scalars(select(InventoryBatch)))
        self.assertEqual(str(remaining), "20.000")
        self.assertEqual(self.db.scalar(select(__import__("sqlalchemy").func.count()).select_from(SalesTransaction)), 0)

    def test_response_failure_rolls_back_sale_and_inventory(self) -> None:
        with patch("app.services.sales_checkout_service.get_checkout_transaction", return_value={}):
            response = self.client.post("/api/v1/sales/checkout", json={
                "items": [{"product_id": self.product.product_id, "quantity": "1"}],
                "discount": {"type": "none", "value": "0"},
                "payment_method": "cash",
                "idempotency_key": "rollback-response",
            })
        self.assertEqual(response.status_code, 500)
        remaining = sum(batch.quantity_remaining for batch in self.db.scalars(select(InventoryBatch)))
        self.assertEqual(str(remaining), "20.000")
        transaction_count = self.db.scalar(select(__import__("sqlalchemy").func.count()).select_from(SalesTransaction))
        self.assertEqual(transaction_count, 0)

    def test_idempotency_lookup_failure_rolls_back(self) -> None:
        with (
            patch.object(self.db, "scalar", side_effect=SQLAlchemyError("lookup failed")),
            patch.object(self.db, "rollback", wraps=self.db.rollback) as rollback,
        ):
            response = self.client.post("/api/v1/sales/checkout", json={
                "items": [{"product_id": self.product.product_id, "quantity": "1"}],
                "discount": {"type": "none", "value": "0"},
                "payment_method": "cash",
                "idempotency_key": "lookup-failure",
            })
        self.assertEqual(response.status_code, 500)
        rollback.assert_called_once()
        self.assertEqual(self.db.scalar(select(__import__("sqlalchemy").func.count()).select_from(SalesTransaction)), 0)
        remaining = sum(batch.quantity_remaining for batch in self.db.scalars(select(InventoryBatch)))
        self.assertEqual(str(remaining), "20.000")

    def test_missing_inventory_batch_column_rolls_back_checkout(self) -> None:
        original_scalars = self.db.scalars

        def fail_inventory_batch_select(statement, *args, **kwargs):
            if "FROM inventory_batches" in str(statement):
                raise OperationalError(
                    str(statement),
                    {},
                    RuntimeError("(1054, \"Unknown column 'inventory_batches.location' in 'field list'\")"),
                )
            return original_scalars(statement, *args, **kwargs)

        with (
            patch.object(self.db, "scalars", side_effect=fail_inventory_batch_select),
            patch.object(self.db, "rollback", wraps=self.db.rollback) as rollback,
            self.assertLogs("app.services.sales_checkout_service", level="ERROR") as logs,
        ):
            response = self.client.post("/api/v1/sales/checkout", json={
                "items": [{"product_id": self.product.product_id, "quantity": "1"}],
                "discount": {"type": "none", "value": "0"},
                "payment_method": "cash",
                "idempotency_key": "missing-inventory-column",
            })
        self.assertEqual(response.status_code, 500)
        self.assertNotIn("inventory_batches.location", response.text)
        self.assertTrue(any("Unknown column 'inventory_batches.location'" in entry for entry in logs.output))
        rollback.assert_called_once()
        self.assertEqual(self.db.scalar(select(__import__("sqlalchemy").func.count()).select_from(SalesTransaction)), 0)
        remaining = sum(batch.quantity_remaining for batch in self.db.scalars(select(InventoryBatch)))
        self.assertEqual(str(remaining), "20.000")

    def test_checkout_response_matches_response_schema_before_success(self) -> None:
        response = self.client.post("/api/v1/sales/checkout", json={
            "items": [{"product_id": self.product.product_id, "quantity": "1"}],
            "discount": {"type": "none", "value": "0"},
            "payment_method": "cash",
            "idempotency_key": "schema-validation",
        })
        self.assertEqual(response.status_code, 201, response.text)
        TransactionResponse.model_validate(response.json())
        self.assertEqual(
            self.db.scalar(select(__import__("sqlalchemy").func.count()).select_from(SalesTransaction)),
            1,
        )

    def test_inventory_batch_listing_logs_failure_without_exposing_details(self) -> None:
        error = OperationalError(
            "SELECT inventory_batches.location FROM inventory_batches",
            {},
            RuntimeError("(1054, \"Unknown column 'inventory_batches.location' in 'field list'\")"),
        )
        with (
            patch.object(self.db, "scalars", side_effect=error),
            self.assertLogs("app.api.v1.router", level="ERROR") as logs,
        ):
            response = self.client.get("/api/v1/inventory/batches")
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["detail"], "Inventory batches could not be loaded.")
        self.assertNotIn("inventory_batches.location", response.text)
        self.assertTrue(any("Unknown column 'inventory_batches.location'" in entry for entry in logs.output))

    def test_inventory_batch_response_validation_failure_is_logged_and_hidden(self) -> None:
        with patch("app.api.v1.router.BatchResponse.model_validate", side_effect=RuntimeError("schema detail")):
            response = self.client.get("/api/v1/inventory/batches")
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["detail"], "Inventory batches could not be loaded.")
        self.assertNotIn("schema detail", response.text)

    def test_inventory_batch_listing_returns_schema_valid_batches(self) -> None:
        response = self.client.get("/api/v1/inventory/batches")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(response.json()), 2)
        self.assertEqual(response.json()[0]["batch_id"], self.db.scalar(
            select(InventoryBatch.batch_id)
            .order_by(InventoryBatch.expiry_date, InventoryBatch.batch_id)
            .limit(1)
        ))

    def test_checkout_rejects_duplicate_products(self) -> None:
        response = self.client.post("/api/v1/sales/checkout", json={
            "items": [
                {"product_id": self.product.product_id, "quantity": "1"},
                {"product_id": self.product.product_id, "quantity": "2"},
            ],
            "discount": {"type": "none", "value": "0"},
            "payment_method": "cash",
            "idempotency_key": "pos-test-key-duplicate",
        })
        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
