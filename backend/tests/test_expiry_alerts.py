import io
import unittest
from datetime import date, timedelta
from decimal import Decimal
from zipfile import ZipFile

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.security import get_current_user, hash_password
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models import InventoryBatch, Product, User, UserActivity


class ExpiryAlertApiTests(unittest.TestCase):
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

    def add_batch(
        self,
        name: str,
        days_to_expiry: int,
        *,
        category: str = "Dairy",
        location: str = "Cold Room",
        supplier: str = "Farm Supplier",
        status: str = "active",
        quantity: str = "12",
    ) -> int:
        product = Product(
            name=name,
            category=category,
            sku=f"SKU-{name.replace(' ', '').upper()}",
            unit="kg",
            price=Decimal("3.50"),
            supplier=supplier,
        )
        self.db.add(product)
        self.db.flush()
        batch = InventoryBatch(
            product_id=product.product_id,
            batch_code=f"LOT-{product.product_id}",
            quantity_received=Decimal(quantity),
            quantity_remaining=Decimal(quantity),
            unit_cost=Decimal("2.00"),
            received_at=date.today() - timedelta(days=2),
            expiry_date=date.today() + timedelta(days=days_to_expiry),
            status=status,
            location=location,
            supplier=None,
        )
        self.db.add(batch)
        self.db.commit()
        return batch.batch_id

    def test_signed_in_session_can_load_page_data_end_to_end(self) -> None:
        self.add_batch("Authenticated Milk", 2)
        self.user.email = "manager@example.com"
        self.user.password_hash = hash_password("TestPass9!")
        self.db.commit()
        app.dependency_overrides.pop(get_current_user)

        login = self.client.post(
            "/api/v1/auth/login",
            json={"email": self.user.email, "password": "TestPass9!"},
        )
        self.assertEqual(login.status_code, 200, login.text)
        headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

        page = self.client.get("/api/v1/expiry-alerts?page=1&page_size=10", headers=headers)
        charts = self.client.get("/api/v1/expiry-alerts/charts", headers=headers)
        filters = self.client.get("/api/v1/expiry-alerts/filters", headers=headers)

        self.assertEqual(page.status_code, 200, page.text)
        self.assertEqual(page.json()["items"][0]["product_name"], "Authenticated Milk")
        self.assertEqual(page.json()["summary"]["high"], 1)
        self.assertEqual(charts.status_code, 200, charts.text)
        self.assertEqual(charts.json()["expiring_next_14_days"][0]["count"], 1)
        self.assertEqual(filters.status_code, 200, filters.text)
        self.assertEqual(filters.json()["categories"], ["Dairy"])

    def test_alert_list_and_detail_support_schema_without_expiry_provenance(self) -> None:
        batch_id = self.add_batch("Schema Compatible Milk", 2)
        self.db.execute(text("ALTER TABLE inventory_batches DROP COLUMN expiry_date_source"))
        self.db.commit()

        page = self.client.get("/api/v1/expiry-alerts?page=1&page_size=10")
        detail = self.client.get(f"/api/v1/expiry-alerts/batches/{batch_id}")

        self.assertEqual(page.status_code, 200, page.text)
        self.assertEqual(page.json()["items"][0]["batch_id"], batch_id)
        self.assertIsNone(page.json()["items"][0]["expiry_date_source"])
        self.assertEqual(detail.status_code, 200, detail.text)
        self.assertEqual(detail.json()["batch_id"], batch_id)
        self.assertIsNone(detail.json()["expiry_date_source"])

    def test_expiry_risk_summary_charts_filters_and_pagination_use_batch_dates(self) -> None:
        self.add_batch("Expired Cheese", -1)
        self.add_batch("Milk", 0)
        self.add_batch("Yogurt", 4, category="Dairy", location="Shelf 1")
        self.add_batch("Spinach", 8, category="Vegetables", supplier="Green Farm")
        self.add_batch("Bread", 15, category="Bakery", status="expired")
        self.add_batch("Sold Out", 1, quantity="0")

        page = self.client.get("/api/v1/expiry-alerts?page_size=2")
        self.assertEqual(page.status_code, 200, page.text)
        self.assertEqual(page.json()["total"], 5)
        self.assertEqual(page.json()["total_pages"], 3)
        self.assertEqual([item["risk"] for item in page.json()["items"]], ["expired", "high"])
        self.assertEqual(page.json()["summary"]["risk_counts"], {
            "expired": 1, "high": 1, "medium": 1, "low": 1, "safe": 1,
        })

        filtered = self.client.get("/api/v1/expiry-alerts", params={
            "category": "Dairy", "risk": "medium", "location": "Shelf 1", "supplier": "Farm Supplier",
        })
        self.assertEqual(filtered.status_code, 200, filtered.text)
        self.assertEqual([row["product_name"] for row in filtered.json()["items"]], ["Yogurt"])
        self.assertEqual(filtered.json()["items"][0]["suggested_action"], "Prioritize sale or meal preparation")

        summary = self.client.get("/api/v1/expiry-alerts/summary")
        self.assertEqual(summary.json()["total_batches"], 5)
        charts = self.client.get("/api/v1/expiry-alerts/charts")
        self.assertEqual(charts.status_code, 200, charts.text)
        self.assertEqual(charts.json()["expiring_next_14_days"], [
            {"range": "0-3", "count": 1},
            {"range": "4-7", "count": 1},
            {"range": "8-14", "count": 1},
        ])
        self.assertEqual(charts.json()["top_categories"][0], {"category": "Dairy", "count": 2})

        batch_id = self.db.scalar(select(InventoryBatch.batch_id).join(Product).where(Product.name == "Spinach"))
        detail = self.client.get(f"/api/v1/expiry-alerts/batches/{batch_id}")
        self.assertEqual(detail.status_code, 200, detail.text)
        self.assertEqual(detail.json()["supplier"], "Green Farm")
        self.assertEqual(detail.json()["location"], "Cold Room")
        filters = self.client.get("/api/v1/expiry-alerts/filters")
        self.assertEqual(filters.status_code, 200, filters.text)
        self.assertEqual(filters.json()["categories"], ["Bakery", "Dairy", "Vegetables"])

    def test_alert_rule_management_is_audited_and_role_restricted(self) -> None:
        payload = {
            "name": "Dairy warning",
            "days_before_expiry": 4,
            "risk_level": "medium",
            "category": "Dairy",
            "location": None,
            "supplier": None,
            "enabled": True,
        }
        created = self.client.post("/api/v1/expiry-alerts/rules", json=payload)
        self.assertEqual(created.status_code, 201, created.text)
        rule = created.json()
        updated = self.client.patch(
            f"/api/v1/expiry-alerts/rules/{rule['rule_id']}",
            json={"name": "Dairy warning updated", "enabled": False},
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertFalse(updated.json()["enabled"])
        self.assertEqual(self.client.get("/api/v1/expiry-alerts/rules").json()[0]["name"], "Dairy warning updated")

        self.assertEqual(
            self.client.delete(f"/api/v1/expiry-alerts/rules/{rule['rule_id']}").status_code,
            204,
        )
        self.assertEqual(self.client.get("/api/v1/expiry-alerts/rules").json(), [])
        self.assertEqual(
            self.db.scalar(select(func.count()).select_from(UserActivity).where(
                UserActivity.entity_type == "expiry_alert_rule",
            )),
            3,
        )

        self.user.role = "viewer"
        denied = self.client.post("/api/v1/expiry-alerts/rules", json=payload)
        self.assertEqual(denied.status_code, 403)

    def test_expiry_risk_band_boundaries_are_inclusive_as_specified(self) -> None:
        expected = {
            "Past": "expired",
            "Today": "high",
            "ThreeDays": "high",
            "FourDays": "medium",
            "SevenDays": "medium",
            "EightDays": "low",
            "FourteenDays": "low",
            "FifteenDays": "safe",
        }
        days = {
            "Past": -1,
            "Today": 0,
            "ThreeDays": 3,
            "FourDays": 4,
            "SevenDays": 7,
            "EightDays": 8,
            "FourteenDays": 14,
            "FifteenDays": 15,
        }
        for name, days_to_expiry in days.items():
            self.add_batch(name, days_to_expiry)

        response = self.client.get("/api/v1/expiry-alerts?page_size=100")
        self.assertEqual(response.status_code, 200, response.text)
        actual = {item["product_name"]: item["risk"] for item in response.json()["items"]}
        self.assertEqual(actual, expected)

    def test_csv_and_xlsx_exports_return_real_filtered_batch_rows(self) -> None:
        self.user.role = "admin"
        self.add_batch("Lettuce", 2, category="Vegetables")

        csv_response = self.client.get("/api/v1/expiry-alerts/export?format=csv")
        self.assertEqual(csv_response.status_code, 200, csv_response.text)
        self.assertIn("Lettuce", csv_response.content.decode("utf-8-sig"))

        xlsx_response = self.client.get("/api/v1/expiry-alerts/export?format=xlsx")
        self.assertEqual(xlsx_response.status_code, 200, xlsx_response.text)
        with ZipFile(io.BytesIO(xlsx_response.content)) as workbook:
            worksheet = workbook.read("xl/worksheets/sheet1.xml").decode("utf-8")
        self.assertIn("Lettuce", worksheet)

    def test_expiry_export_is_admin_only(self) -> None:
        self.assertEqual(self.client.get("/api/v1/expiry-alerts/export").status_code, 403)
        self.user.role = "admin"
        self.assertEqual(self.client.get("/api/v1/expiry-alerts/export").status_code, 200)
