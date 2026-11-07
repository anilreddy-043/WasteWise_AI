import unittest

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.security import get_current_user
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models import User, UserGeneralSettings


class GeneralSettingsApiTests(unittest.TestCase):
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
            email="general-settings@example.test",
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
        self.payload = {
            "application_name": "  Green Store  ",
            "timezone": "America/Los_Angeles",
            "date_format": "YYYY-MM-DD",
            "language": "hi",
            "items_per_page": 50,
        }

    def tearDown(self) -> None:
        app.dependency_overrides.clear()
        self.client.close()
        self.db.close()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def test_get_returns_defaults_without_creating_a_settings_row(self) -> None:
        response = self.client.get("/api/v1/settings/me/general")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {
            "application_name": "WasteWise AI",
            "timezone": "Asia/Kolkata",
            "date_format": "DD MMM YYYY",
            "language": "en",
            "items_per_page": 10,
        })
        self.assertEqual(
            self.db.scalar(select(func.count()).select_from(UserGeneralSettings)),
            0,
        )

    def test_put_persists_settings_and_repeated_updates_do_not_duplicate_rows(self) -> None:
        first = self.client.put("/api/v1/settings/me/general", json=self.payload)

        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()["application_name"], "Green Store")
        self.assertEqual(first.json()["timezone"], "America/Los_Angeles")

        updated_payload = {**self.payload, "items_per_page": 100}
        second = self.client.put("/api/v1/settings/me/general", json=updated_payload)
        loaded = self.client.get("/api/v1/settings/me/general")

        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(loaded.status_code, 200, loaded.text)
        self.assertEqual(loaded.json(), {
            "application_name": "Green Store",
            "timezone": "America/Los_Angeles",
            "date_format": "YYYY-MM-DD",
            "language": "hi",
            "items_per_page": 100,
        })
        self.assertEqual(
            self.db.scalar(select(func.count()).select_from(UserGeneralSettings)),
            1,
        )

    def test_settings_are_scoped_to_the_authenticated_user(self) -> None:
        self.client.put("/api/v1/settings/me/general", json=self.payload)
        second_user = User(
            user_id=2,
            full_name="Second User",
            email="second-general-settings@example.test",
            password_hash="unused",
            role="viewer",
            approval_status="approved",
            is_active=True,
        )
        self.db.add(second_user)
        self.db.commit()
        app.dependency_overrides[get_current_user] = lambda: second_user

        response = self.client.get("/api/v1/settings/me/general")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["application_name"], "WasteWise AI")
        self.assertEqual(self.db.get(UserGeneralSettings, self.user.user_id).application_name, "Green Store")

    def test_put_rejects_invalid_values_without_saving(self) -> None:
        invalid_payloads = [
            {**self.payload, "application_name": "   "},
            {**self.payload, "timezone": "Not/A_Timezone"},
            {**self.payload, "date_format": "DD-MM-YYYY"},
            {**self.payload, "language": "xx"},
            {**self.payload, "items_per_page": 25},
        ]

        for payload in invalid_payloads:
            with self.subTest(payload=payload):
                response = self.client.put("/api/v1/settings/me/general", json=payload)
                self.assertEqual(response.status_code, 422, response.text)

        self.assertEqual(
            self.db.scalar(select(func.count()).select_from(UserGeneralSettings)),
            0,
        )
