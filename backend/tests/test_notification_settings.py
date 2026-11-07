import unittest

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.security import get_current_user
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models import User, UserNotificationSettings


class NotificationSettingsApiTests(unittest.TestCase):
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
            email="notifications@example.test",
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
        self.defaults = {
            "expiry_alerts": True,
            "low_stock_alerts": True,
            "high_demand_alerts": True,
            "daily_reports": False,
            "weekly_insights": True,
            "system_notifications": True,
        }

    def tearDown(self) -> None:
        app.dependency_overrides.clear()
        self.client.close()
        self.db.close()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def test_get_returns_defaults_without_creating_a_settings_row(self) -> None:
        response = self.client.get("/api/v1/settings/me/notifications")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), self.defaults)
        self.assertEqual(
            self.db.scalar(select(func.count()).select_from(UserNotificationSettings)),
            0,
        )

    def test_endpoints_require_authentication(self) -> None:
        app.dependency_overrides.pop(get_current_user)

        get_response = self.client.get("/api/v1/settings/me/notifications")
        put_response = self.client.put(
            "/api/v1/settings/me/notifications",
            json=self.defaults,
        )

        self.assertEqual(get_response.status_code, 401, get_response.text)
        self.assertEqual(put_response.status_code, 401, put_response.text)

    def test_put_persists_all_preferences_and_updates_the_existing_row(self) -> None:
        payload = {**self.defaults, "expiry_alerts": False, "daily_reports": True}

        first = self.client.put("/api/v1/settings/me/notifications", json=payload)
        second = self.client.put(
            "/api/v1/settings/me/notifications",
            json={**payload, "weekly_insights": False},
        )
        loaded = self.client.get("/api/v1/settings/me/notifications")

        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(loaded.status_code, 200, loaded.text)
        self.assertEqual(loaded.json(), {**payload, "weekly_insights": False})
        self.assertEqual(
            self.db.scalar(select(func.count()).select_from(UserNotificationSettings)),
            1,
        )

    def test_settings_are_scoped_to_the_authenticated_user(self) -> None:
        self.client.put(
            "/api/v1/settings/me/notifications",
            json={**self.defaults, "expiry_alerts": False},
        )
        second_user = User(
            user_id=2,
            full_name="Second User",
            email="second-notifications@example.test",
            password_hash="unused",
            role="viewer",
            approval_status="approved",
            is_active=True,
        )
        self.db.add(second_user)
        self.db.commit()
        app.dependency_overrides[get_current_user] = lambda: second_user

        response = self.client.get("/api/v1/settings/me/notifications")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), self.defaults)
        self.assertFalse(
            self.db.get(UserNotificationSettings, self.user.user_id).expiry_alerts
        )

    def test_put_rejects_non_boolean_values_without_saving(self) -> None:
        for payload in (
            {**self.defaults, "expiry_alerts": ["not", "a", "boolean"]},
            {"expiry_alerts": False},
        ):
            with self.subTest(payload=payload):
                response = self.client.put(
                    "/api/v1/settings/me/notifications",
                    json=payload,
                )

                self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(
            self.db.scalar(select(func.count()).select_from(UserNotificationSettings)),
            0,
        )
