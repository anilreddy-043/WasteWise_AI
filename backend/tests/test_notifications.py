import unittest
from datetime import datetime, timedelta
from decimal import Decimal
from unittest.mock import patch
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.security import get_current_user
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models import (
    DemandForecast,
    InventoryBatch,
    Product,
    User,
    UserActivity,
    UserGeneralSettings,
    UserNotification,
    UserNotificationSettings,
)
from app.services.notification_center import _settings_for_user


class NotificationCenterApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine, expire_on_commit=False)
        self.admin = User(
            user_id=1,
            full_name="Notification Admin",
            email="admin-notifications@example.test",
            password_hash="unused",
            role="admin",
            approval_status="approved",
            is_active=True,
        )
        self.manager = User(
            user_id=2,
            full_name="Notification Manager",
            email="manager-notifications@example.test",
            password_hash="unused",
            role="store_manager",
            approval_status="approved",
            is_active=True,
        )
        self.viewer = User(
            user_id=3,
            full_name="Notification Viewer",
            email="viewer-notifications@example.test",
            password_hash="unused",
            role="viewer",
            approval_status="approved",
            is_active=True,
        )
        self.product = Product(
            product_id=10,
            name="Fresh Greens",
            category="Produce",
            sku="GREEN-10",
            unit="kg",
            price=Decimal("3.50"),
            supplier="Local Farm",
        )
        self.low_product = Product(
            product_id=11,
            name="Low Stock Bread",
            category="Bakery",
            sku="BREAD-11",
            unit="loaf",
            price=Decimal("2.00"),
            supplier="Local Bakery",
        )
        self.demand_product = Product(
            product_id=12,
            name="Popular Apples",
            category="Produce",
            sku="APPLE-12",
            unit="kg",
            price=Decimal("4.00"),
            supplier="Orchard",
        )
        self.db.add_all([self.admin, self.manager, self.viewer, self.product, self.low_product, self.demand_product])
        self.db.flush()

        today = datetime.now(ZoneInfo("Asia/Kolkata")).date()
        self.expiring_batch = InventoryBatch(
            batch_id=20,
            product_id=self.product.product_id,
            batch_code="EXP-1",
            quantity_received=Decimal("8"),
            quantity_remaining=Decimal("8"),
            received_at=today - timedelta(days=5),
            expiry_date=today + timedelta(days=2),
            status="active",
        )
        self.expired_batch = InventoryBatch(
            batch_id=21,
            product_id=self.low_product.product_id,
            batch_code="EXPIRED-1",
            quantity_received=Decimal("1"),
            quantity_remaining=Decimal("1"),
            received_at=today - timedelta(days=10),
            expiry_date=today - timedelta(days=1),
            status="expired",
        )
        self.demand_batch = InventoryBatch(
            batch_id=22,
            product_id=self.demand_product.product_id,
            batch_code="APPLE-1",
            quantity_received=Decimal("2"),
            quantity_remaining=Decimal("2"),
            received_at=today - timedelta(days=1),
            expiry_date=today + timedelta(days=10),
            status="active",
        )
        self.forecast = DemandForecast(
            forecast_id=30,
            product_id=self.demand_product.product_id,
            forecast_date=today + timedelta(days=1),
            predicted_demand=Decimal("10"),
            model_version="test-model",
        )
        self.db.add_all([self.expiring_batch, self.expired_batch, self.demand_batch, self.forecast])
        self.db.commit()
        self.current_user = self.admin
        app.dependency_overrides[get_db] = lambda: self.db
        app.dependency_overrides[get_current_user] = lambda: self.current_user
        self.model_loader_patch = patch("app.services.notification_center.load_model_artifact")
        self.model_loader = self.model_loader_patch.start()
        self.client = TestClient(app)

    def tearDown(self) -> None:
        app.dependency_overrides.clear()
        self.client.close()
        self.model_loader_patch.stop()
        self.db.close()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def test_generates_real_inventory_demand_import_and_system_notifications_once(self) -> None:
        self.db.add_all([
            UserActivity(
                user_id=self.admin.user_id,
                action="batch_updated",
                entity_type="inventory_batch",
                entity_id=self.expiring_batch.batch_id,
            ),
            UserActivity(
                user_id=self.admin.user_id,
                action="data_csv_imported",
                entity_type="products",
                details={"dataset": "products", "successful_records": 3},
            ),
            UserActivity(
                user_id=self.admin.user_id,
                action="data_import_failed",
                entity_type="sales",
                details={"dataset": "sales", "failure_reason": "row_validation_failed"},
            ),
        ])
        self.db.commit()
        self.model_loader.side_effect = lambda key: (_ for _ in ()).throw(FileNotFoundError()) if key == "expiry_risk" else object()

        first = self.client.get("/api/v1/notifications")
        second = self.client.get("/api/v1/notifications")

        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.status_code, 200, second.text)
        items = first.json()["items"]
        categories = {item["category"] for item in items}
        titles = {item["title"] for item in items}
        self.assertTrue(
            {"expiry", "inventory", "demand", "import", "system"}.issubset(categories),
            f"categories={categories}, titles={titles}",
        )
        self.assertIn("Product nearing expiry", titles)
        self.assertIn("Inventory batch has expired", titles)
        self.assertIn("Low stock", titles)
        self.assertIn("Inventory batch updated", titles)
        self.assertIn("Forecasted demand exceeds stock", titles)
        self.assertIn("Data import completed", titles)
        self.assertIn("Data import failed", titles)
        self.assertIn("System service unavailable", titles)
        count = self.db.scalar(select(func.count()).select_from(UserNotification))
        self.assertEqual(count, first.json()["total"])
        self.assertEqual(second.json()["total"], count)
        self.assertTrue(all(item["is_read"] is False for item in items))
        self.assertGreater(first.json()["unread_count"], 0)
        self.assertEqual(first.json()["read_count"], 0)
        self.assertEqual(first.json()["unread_count"], first.json()["total"])

    def test_counts_category_filters_and_pagination(self) -> None:
        first_page = self.client.get("/api/v1/notifications?category=expiry&limit=1&offset=0")
        second_page = self.client.get("/api/v1/notifications?category=expiry&limit=1&offset=1")

        self.assertEqual(first_page.status_code, 200, first_page.text)
        self.assertEqual(second_page.status_code, 200, second_page.text)
        self.assertEqual(first_page.json()["total"], 3)
        self.assertEqual(first_page.json()["unread_count"], 3)
        self.assertEqual(first_page.json()["read_count"], 0)
        self.assertEqual(len(first_page.json()["items"]), 1)
        self.assertEqual(len(second_page.json()["items"]), 1)
        self.assertNotEqual(
            first_page.json()["items"][0]["notification_id"],
            second_page.json()["items"][0]["notification_id"],
        )

        invalid_category = self.client.get("/api/v1/notifications?category=other")
        invalid_status = self.client.get("/api/v1/notifications?read_status=other")
        invalid_pagination = self.client.get("/api/v1/notifications?limit=101")
        self.assertEqual(invalid_category.status_code, 422)
        self.assertEqual(invalid_status.status_code, 422)
        self.assertEqual(invalid_pagination.status_code, 422)

    def test_category_read_filters_mark_read_and_mark_all_read(self) -> None:
        response = self.client.get("/api/v1/notifications?category=expiry")
        self.assertEqual(response.status_code, 200, response.text)
        notification = response.json()["items"][0]

        marked = self.client.patch(
            f"/api/v1/notifications/{notification['notification_id']}/read",
            json={"is_read": True},
        )
        self.assertEqual(marked.status_code, 200, marked.text)
        self.assertTrue(marked.json()["is_read"])
        unread = self.client.get("/api/v1/notifications?category=expiry&read_status=unread")
        read = self.client.get("/api/v1/notifications?category=expiry&read_status=read")
        self.assertEqual(unread.json()["total"], 2)
        self.assertEqual(read.json()["total"], 1)
        self.assertEqual(read.json()["read_count"], 1)
        self.assertEqual(read.json()["unread_count"], 2)

        all_read = self.client.post("/api/v1/notifications/read-all")
        self.assertEqual(all_read.status_code, 204)
        self.assertEqual(self.client.get("/api/v1/notifications?read_status=unread").json()["unread_count"], 0)

        marked_unread = self.client.patch(
            f"/api/v1/notifications/{notification['notification_id']}/read",
            json={"is_read": False},
        )
        self.assertEqual(marked_unread.status_code, 200, marked_unread.text)
        self.assertFalse(marked_unread.json()["is_read"])

    def test_manager_sees_operational_notifications_but_not_import_or_system_events(self) -> None:
        self.db.add(UserActivity(
            user_id=self.admin.user_id,
            action="data_csv_imported",
            entity_type="products",
            details={"dataset": "products", "successful_records": 1},
        ))
        self.db.commit()
        self.current_user = self.manager

        response = self.client.get("/api/v1/notifications")

        self.assertEqual(response.status_code, 200, response.text)
        categories = {item["category"] for item in response.json()["items"]}
        self.assertTrue(categories.issubset({"expiry", "inventory", "demand"}))
        self.assertNotIn("import", categories)
        self.assertNotIn("system", categories)
        self.assertEqual(
            self.client.get("/api/v1/notifications?category=system").status_code,
            403,
        )

    def test_preferences_disable_event_generation_and_hide_existing_events(self) -> None:
        self.db.add(UserNotificationSettings(
            user_id=self.admin.user_id,
            expiry_alerts=False,
            low_stock_alerts=False,
            high_demand_alerts=False,
            daily_reports=False,
            weekly_insights=False,
            system_notifications=False,
        ))
        self.db.commit()

        response = self.client.get("/api/v1/notifications")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["items"], [])
        self.assertEqual(self.db.scalar(select(func.count()).select_from(UserNotification)), 0)

    def test_read_updates_are_scoped_to_the_authenticated_user_and_role(self) -> None:
        first = self.client.get("/api/v1/notifications?category=expiry").json()["items"][0]
        self.current_user = self.manager
        cross_user = self.client.patch(
            f"/api/v1/notifications/{first['notification_id']}/read",
            json={"is_read": True},
        )
        self.assertEqual(cross_user.status_code, 404)

        self.current_user = self.viewer
        denied_list = self.client.get("/api/v1/notifications")
        denied_mark_all = self.client.post("/api/v1/notifications/read-all")
        self.assertEqual(denied_list.status_code, 403)
        self.assertEqual(denied_mark_all.status_code, 403)

    def test_notification_endpoints_require_authentication(self) -> None:
        app.dependency_overrides.pop(get_current_user)

        response = self.client.get("/api/v1/notifications")
        update = self.client.patch("/api/v1/notifications/1/read", json={"is_read": True})

        self.assertEqual(response.status_code, 401)
        self.assertEqual(update.status_code, 401)

    def test_notification_database_failure_returns_service_unavailable(self) -> None:
        with patch.object(
            self.db,
            "execute",
            side_effect=OperationalError("SELECT ...", {}, Exception("database unavailable")),
        ):
            response = self.client.get("/api/v1/notifications")
        self.assertEqual(response.status_code, 503)

    def test_timezone_defaults_when_general_settings_table_is_not_installed(self) -> None:
        UserGeneralSettings.__table__.drop(self.engine)

        preferences, timezone_name = _settings_for_user(self.db, self.admin.user_id)

        self.assertTrue(preferences["expiry_alerts"])
        self.assertEqual(timezone_name, "Asia/Kolkata")
