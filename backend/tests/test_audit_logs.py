import unittest
from datetime import datetime, timezone
from unittest.mock import patch
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.security import get_current_user
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models import User, UserActivity, UserGeneralSettings
from app.services.audit_log_service import activity_status, safe_activity_details, utc_date_bounds


class AuditLogTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.connection = self.engine.connect()
        self.transaction = self.connection.begin()
        self.db = Session(bind=self.connection, join_transaction_mode="create_savepoint")
        self.admin = self.add_user(1, "Admin", "admin")
        self.manager = self.add_user(2, "Store Manager", "store_manager")
        self.staff = self.add_user(3, "Staff", "staff")
        self.db.add(UserGeneralSettings(user_id=1, timezone="Asia/Kolkata"))
        self.db.add(UserGeneralSettings(user_id=2, timezone="Asia/Kolkata"))
        self.db.flush()
        app.dependency_overrides[get_db] = lambda: self.db
        app.dependency_overrides[get_current_user] = lambda: self.manager
        self.client = TestClient(app)

    def tearDown(self) -> None:
        app.dependency_overrides.clear()
        self.db.close()
        self.transaction.rollback()
        self.connection.close()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def add_user(self, user_id: int, name: str, role: str) -> User:
        user = User(
            user_id=user_id,
            full_name=name,
            email=f"{name.lower().replace(' ', '.')}@example.test",
            password_hash="unused",
            role=role,
            approval_status="approved",
            is_active=True,
        )
        self.db.add(user)
        self.db.flush()
        return user

    def add_activity(
        self,
        action: str,
        actor_id: int | None,
        *,
        entity: str = "product",
        entity_id: int | None = 1,
        created_at: datetime | None = None,
        details: dict | None = None,
    ) -> UserActivity:
        activity = UserActivity(
            user_id=actor_id,
            action=action,
            entity_type=entity,
            entity_id=entity_id,
            details=details,
        )
        if created_at is not None:
            activity.created_at = created_at
        self.db.add(activity)
        self.db.flush()
        return activity

    def test_manager_sees_operational_events_but_not_admin_or_security_events(self) -> None:
        self.add_activity("product_created", self.manager.user_id, details={"changed_fields": ["name"]})
        self.add_activity("pos_sale_completed", self.manager.user_id)
        self.add_activity("user_role_changed", self.admin.user_id, details={"new_role": "admin"})
        self.add_activity("password_changed", self.manager.user_id)

        response = self.client.get("/api/v1/audit-logs")

        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(
            [item["action"] for item in data["items"]],
            ["pos_sale_completed", "product_created"],
        )
        self.assertEqual(data["items"][1]["details"], {"changed_fields": ["name"]})

    def test_audit_response_has_actor_role_and_affected_record_and_filters_by_status(self) -> None:
        self.add_activity("product_created", self.manager.user_id, entity_id=41)
        self.add_activity("data_import_failed", self.admin.user_id, entity="products", entity_id=None)
        app.dependency_overrides[get_current_user] = lambda: self.admin

        response = self.client.get(
            "/api/v1/audit-logs",
            params={"status": "failed", "sort_by": "action", "sort_order": "asc"},
        )

        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["total"], 1)
        item = data["items"][0]
        self.assertEqual(item["actor_name"], "Admin")
        self.assertEqual(item["actor_role"], "admin")
        self.assertEqual(item["affected_record"], "products")
        self.assertEqual(item["status"], "failed")

    def test_audit_sort_by_actor_and_invalid_filters(self) -> None:
        self.add_activity("product_created", self.manager.user_id, entity_id=41)
        self.add_activity("product_updated", self.admin.user_id, entity_id=42)
        app.dependency_overrides[get_current_user] = lambda: self.admin

        sorted_response = self.client.get(
            "/api/v1/audit-logs",
            params={"sort_by": "actor", "sort_order": "asc"},
        )
        self.assertEqual(sorted_response.status_code, 200, sorted_response.text)
        self.assertEqual(
            [item["actor_name"] for item in sorted_response.json()["items"]],
            ["Admin", "Store Manager"],
        )

        invalid_status = self.client.get("/api/v1/audit-logs?status=unknown-value")
        invalid_sort = self.client.get("/api/v1/audit-logs?sort_by=email")
        self.assertEqual(invalid_status.status_code, 422)
        self.assertEqual(invalid_sort.status_code, 422)

    def test_audit_empty_filter_result_has_zero_total(self) -> None:
        response = self.client.get(
            "/api/v1/audit-logs",
            params={"action": "action_that_does_not_exist"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["items"], [])
        self.assertEqual(response.json()["total"], 0)
        self.assertEqual(response.json()["total_pages"], 0)

    def test_audit_database_failure_returns_service_unavailable(self) -> None:
        with patch.object(
            self.db,
            "scalar",
            side_effect=OperationalError("SELECT COUNT(*)", {}, Exception("database unavailable")),
        ):
            response = self.client.get("/api/v1/audit-logs")
        self.assertEqual(response.status_code, 503)

    def test_admin_can_view_all_and_private_details_are_redacted(self) -> None:
        self.add_activity(
            "user_role_changed",
            self.admin.user_id,
            details={
                "previous_role": "store_manager",
                "new_role": "admin",
                "password": "do-not-return",
                "email": "private@example.test",
                "jti": "token-id",
            },
        )
        app.dependency_overrides[get_current_user] = lambda: self.admin

        response = self.client.get("/api/v1/audit-logs")

        self.assertEqual(response.status_code, 200, response.text)
        item = response.json()["items"][0]
        self.assertEqual(item["details"], {"previous_role": "store_manager", "new_role": "admin"})
        self.assertNotIn("do-not-return", response.text)
        self.assertNotIn("private@example.test", response.text)
        self.assertNotIn("token-id", response.text)

    def test_product_creation_is_recorded_and_visible_as_operational_activity(self) -> None:
        response = self.client.post(
            "/api/v1/products",
            json={
                "name": "Fresh Apples",
                "category": "Fruits",
                "sku": "APPLES-AUDIT-1",
                "unit": "kg",
                "price": "4.50",
                "supplier": "Local farm",
            },
        )
        self.assertEqual(response.status_code, 201, response.text)
        event = self.db.query(UserActivity).filter_by(action="product_created").one()
        self.assertEqual(event.user_id, self.manager.user_id)
        logs = self.client.get("/api/v1/audit-logs")
        self.assertEqual(logs.status_code, 200, logs.text)
        self.assertEqual(logs.json()["items"][0]["action"], "product_created")
        self.assertEqual(
            logs.json()["items"][0]["details"]["changed_fields"],
            ["name", "category", "sku", "unit", "price", "supplier"],
        )

    def test_role_denial_search_actor_date_filters_and_pagination(self) -> None:
        self.add_activity("product_created", self.manager.user_id, entity_id=1)
        self.add_activity("product_updated", self.admin.user_id, entity_id=2)
        self.add_activity("auth_login_failed", None, entity="user", entity_id=None)

        app.dependency_overrides[get_current_user] = lambda: self.staff
        denied = self.client.get("/api/v1/audit-logs")
        self.assertEqual(denied.status_code, 403)

        app.dependency_overrides[get_current_user] = lambda: self.admin
        filtered = self.client.get(
            "/api/v1/audit-logs",
            params={"user_id": self.manager.user_id, "search": "product", "page": 1, "page_size": 1},
        )
        self.assertEqual(filtered.status_code, 200, filtered.text)
        self.assertEqual(filtered.json()["total"], 1)
        self.assertEqual(filtered.json()["items"][0]["action"], "product_created")

        page = self.client.get("/api/v1/audit-logs", params={"page": 2, "page_size": 1})
        self.assertEqual(page.status_code, 200, page.text)
        self.assertEqual(page.json()["total"], 3)
        self.assertEqual(page.json()["page"], 2)
        self.assertEqual(len(page.json()["items"]), 1)

        unknown = self.client.get("/api/v1/audit-logs", params={"unknown_actor": True})
        self.assertEqual(unknown.status_code, 200, unknown.text)
        self.assertEqual(unknown.json()["items"][0]["actor_name"], "Unknown login attempt")
        self.assertEqual(unknown.json()["items"][0]["status"], "failed")

        invalid_range = self.client.get(
            "/api/v1/audit-logs",
            params={"start_date": "2026-03-02", "end_date": "2026-03-01"},
        )
        self.assertEqual(invalid_range.status_code, 422)

    def test_date_bounds_use_timezone_and_timestamps_are_utc(self) -> None:
        start, end = utc_date_bounds(
            datetime(2026, 3, 1).date(),
            datetime(2026, 3, 1).date(),
            ZoneInfo("Asia/Kolkata"),
        )
        self.assertEqual(start, datetime(2026, 2, 28, 18, 30))
        self.assertEqual(end.date().isoformat(), "2026-03-01")

        self.add_activity(
            "product_created",
            self.manager.user_id,
            created_at=datetime(2026, 3, 1, 0, 0, tzinfo=timezone.utc).replace(tzinfo=None),
        )
        response = self.client.get("/api/v1/audit-logs", params={"start_date": "2026-03-01", "end_date": "2026-03-01"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["items"][0]["created_at"].endswith("Z"))

    def test_nested_secret_keys_are_removed_from_allowed_details(self) -> None:
        details = safe_activity_details(
            "user_role_changed",
            {
                "previous_role": "viewer",
                "new_role": "admin",
                "debug": {"password": "secret", "role": "admin"},
            },
        )
        self.assertEqual(details, {"previous_role": "viewer", "new_role": "admin"})
        self.assertEqual(activity_status("auth_login_failed"), "failed")
        self.assertEqual(activity_status("product_created"), "successful")
        self.assertEqual(activity_status("legacy_custom_event"), "unknown")


if __name__ == "__main__":
    unittest.main()
