import unittest
from datetime import date, timedelta
from unittest.mock import patch
from decimal import Decimal

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.security import get_current_user
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models import InventoryBatch, Product, Recommendation, User, UserActivity


class RecommendationExecutionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine, expire_on_commit=False)
        self.manager = User(user_id=1, full_name="Store Manager", email="manager@example.test", password_hash="unused", role="store_manager", approval_status="approved", is_active=True)
        self.staff = User(user_id=2, full_name="Staff User", email="staff@example.test", password_hash="unused", role="staff", approval_status="approved", is_active=True)
        self.db.add_all([self.manager, self.staff])
        self.product = Product(product_id=1, name="Rice", category="Pantry", sku="RICE-TEST", unit="kg", price=Decimal("50"), supplier="Test Supplier")
        self.db.add(self.product)
        self.db.commit()
        app.dependency_overrides[get_db] = lambda: self.db
        app.dependency_overrides[get_current_user] = lambda: self.manager
        self.client = TestClient(app)

    def tearDown(self) -> None:
        app.dependency_overrides.clear()
        self.db.close()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def approve(self):
        return self.client.post("/api/v1/recommendations/apply-generated", json={
            "product_id": 1, "recommendation_type": "restock", "recommended_quantity": 25
        })

    def test_approval_purchase_and_receipt_change_inventory_only_at_receipt(self):
        before = self.db.scalar(select(func.count()).select_from(InventoryBatch))
        approved = self.approve()
        self.assertEqual(approved.status_code, 200, approved.text)
        recommendation_id = approved.json()["recommendation_id"]
        self.assertEqual(approved.json()["status"], "approved")
        self.assertEqual(self.db.scalar(select(func.count()).select_from(InventoryBatch)), before)

        purchased = self.client.post(f"/api/v1/recommendations/{recommendation_id}/record-purchase")
        self.assertEqual(purchased.status_code, 200, purchased.text)
        self.assertEqual(purchased.json()["status"], "ordered")
        self.assertEqual(self.db.scalar(select(func.count()).select_from(InventoryBatch)), before)

        received = self.client.post(f"/api/v1/recommendations/{recommendation_id}/receive", json={
            "batch_code": "RICE-RECEIPT-1", "quantity_received": "25", "unit_cost": "40",
            "received_at": date.today().isoformat(), "expiry_date": (date.today() + timedelta(days=30)).isoformat(),
            "location": "Dry Store", "supplier": "Supplier One"
        })
        self.assertEqual(received.status_code, 200, received.text)
        recommendation = self.db.get(Recommendation, recommendation_id)
        batch = self.db.get(InventoryBatch, received.json()["batch_id"])
        self.assertEqual(recommendation.status, "received")
        self.assertEqual(batch.quantity_remaining, Decimal("25.000"))
        self.assertIn("recommendation_stock_received", [row.action for row in self.db.scalars(select(UserActivity)).all()])

    def test_duplicate_receipt_is_rejected(self):
        recommendation_id = self.approve().json()["recommendation_id"]
        payload = {"batch_code": "RICE-RECEIPT-2", "quantity_received": "25", "received_at": date.today().isoformat(),
                   "expiry_date": (date.today() + timedelta(days=30)).isoformat(), "location": "Dry Store"}
        first = self.client.post(f"/api/v1/recommendations/{recommendation_id}/receive", json=payload)
        self.assertEqual(first.status_code, 200, first.text)
        duplicate = self.client.post(f"/api/v1/recommendations/{recommendation_id}/receive", json=payload)
        self.assertEqual(duplicate.status_code, 409)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(InventoryBatch)), 1)

    def test_mangoes_lifecycle_and_validation(self):
        mango = Product(name="Mangoes", category="Fruits", sku="MANGO-AUDIT", unit="kg", price=Decimal("120"), supplier="Audit Supplier")
        self.db.add(mango)
        self.db.flush()
        existing = InventoryBatch(product_id=mango.product_id, batch_code="MANGO-35", quantity_received=Decimal("35"),
                                  quantity_remaining=Decimal("35"), unit_cost=Decimal("80"), received_at=date.today() - timedelta(days=1),
                                  expiry_date=date.today() + timedelta(days=10), status="active", location="Cold Room", supplier="Existing Supplier")
        self.db.add(existing)
        self.db.commit()
        batch_count = self.db.scalar(select(func.count()).select_from(InventoryBatch).where(InventoryBatch.product_id == mango.product_id))

        approved = self.client.post("/api/v1/recommendations/apply-generated", json={"product_id": mango.product_id, "recommendation_type": "restock", "recommended_quantity": "30.632"})
        self.assertEqual(approved.status_code, 200, approved.text)
        recommendation_id = approved.json()["recommendation_id"]
        self.assertEqual(self.db.scalar(select(func.count()).select_from(InventoryBatch).where(InventoryBatch.product_id == mango.product_id)), batch_count)

        ordered = self.client.post(f"/api/v1/recommendations/{recommendation_id}/record-purchase")
        self.assertEqual(ordered.status_code, 200, ordered.text)
        self.assertEqual(ordered.json()["status"], "ordered")
        self.assertEqual(self.db.scalar(select(func.count()).select_from(InventoryBatch).where(InventoryBatch.product_id == mango.product_id)), batch_count)

        receipt = {"batch_code": "MANGO-NEW-30.632", "quantity_received": "30.632", "unit_cost": "80", "received_at": date.today().isoformat(),
                   "expiry_date": (date.today() + timedelta(days=10)).isoformat(), "location": "Cold Room", "supplier": "Audit Supplier"}
        for invalid in (
            {**receipt, "quantity_received": "0"},
            {**receipt, "expiry_date": (date.today() - timedelta(days=1)).isoformat()},
        ):
            response = self.client.post(f"/api/v1/recommendations/{recommendation_id}/receive", json=invalid)
            self.assertEqual(response.status_code, 422)

        received = self.client.post(f"/api/v1/recommendations/{recommendation_id}/receive", json=receipt)
        self.assertEqual(received.status_code, 200, received.text)
        new_batch = self.db.get(InventoryBatch, received.json()["batch_id"])
        unchanged = self.db.get(InventoryBatch, existing.batch_id)
        self.assertEqual(new_batch.quantity_received, Decimal("30.632"))
        self.assertEqual(new_batch.quantity_remaining, Decimal("30.632"))
        self.assertEqual(unchanged.quantity_remaining, Decimal("35.000"))
        self.assertEqual(unchanged.quantity_received, Decimal("35.000"))
        self.assertEqual(new_batch.supplier, "Audit Supplier")
        duplicate = self.client.post(f"/api/v1/recommendations/{recommendation_id}/receive", json=receipt)
        self.assertEqual(duplicate.status_code, 409)
        actions = [row.action for row in self.db.scalars(select(UserActivity).where(UserActivity.entity_id == recommendation_id)).all()]
        self.assertIn("recommendation_approved", actions)
        self.assertIn("recommendation_purchase_recorded", actions)
        self.assertIn("recommendation_stock_received", actions)

    def test_receipt_audit_failure_rolls_back_batch(self):
        recommendation_id = self.approve().json()["recommendation_id"]
        batch_count = self.db.scalar(select(func.count()).select_from(InventoryBatch))
        with patch("app.api.v1.router._record_activity", side_effect=RuntimeError("audit unavailable")):
            response = self.client.post(f"/api/v1/recommendations/{recommendation_id}/receive", json={
                "batch_code": "ROLLBACK-TEST", "quantity_received": "1", "received_at": date.today().isoformat(),
                "expiry_date": (date.today() + timedelta(days=1)).isoformat(), "supplier": "Audit Supplier"
            })
        self.assertEqual(response.status_code, 500)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(InventoryBatch)), batch_count)
        recommendation = self.db.get(Recommendation, recommendation_id)
        self.assertEqual(recommendation.status, "approved")

    def test_staff_cannot_approve_replenishment(self):
        app.dependency_overrides[get_current_user] = lambda: self.staff
        response = self.approve()
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(Recommendation)), 0)


if __name__ == "__main__":
    unittest.main()
