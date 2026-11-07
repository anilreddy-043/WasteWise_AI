import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.security import get_current_user
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models import User
from app.services.system_health import MODEL_ARTIFACTS, collect_system_health


class SystemHealthTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine, expire_on_commit=False)
        self.admin = self._user(1, "admin")
        self.manager = self._user(2, "store_manager")
        self.staff = self._user(3, "staff")
        app.dependency_overrides[get_db] = lambda: self.db
        app.dependency_overrides[get_current_user] = lambda: self.admin
        self.client = TestClient(app)
        self.models_patch = patch(
            "app.services.system_health.load_model_artifact",
            return_value=object(),
        )
        self.models_patch.start()

    def tearDown(self) -> None:
        self.models_patch.stop()
        app.dependency_overrides.clear()
        self.client.close()
        self.db.close()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def _user(self, user_id: int, role: str) -> User:
        user = User(
            user_id=user_id,
            full_name=f"Health {role}",
            email=f"health-{role}@example.com",
            password_hash="unused",
            role=role,
            approval_status="approved",
            is_active=True,
        )
        self.db.add(user)
        self.db.commit()
        return user

    def test_admin_gets_real_healthy_database_models_uptime_and_version(self) -> None:
        response = self.client.get("/api/v1/system-health")

        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["status"], "healthy")
        self.assertEqual(data["api"]["status"], "available")
        self.assertEqual(data["frontend_backend"]["status"], "connected")
        self.assertIn("authenticated health request reached", data["frontend_backend"]["message"])
        self.assertEqual(data["database"]["status"], "available")
        self.assertEqual(
            [(model["name"], model["artifact"], model["status"]) for model in data["ml_models"]],
            [(name, filename, "available") for name, filename in MODEL_ARTIFACTS],
        )
        self.assertEqual(data["app_version"], app.version)
        self.assertGreaterEqual(data["uptime_seconds"], 0)
        self.assertIsNotNone(data["last_successful_check"])
        self.assertEqual(data["errors"], [])

    def test_store_manager_gets_operational_health_without_admin_details(self) -> None:
        app.dependency_overrides[get_current_user] = lambda: self.manager

        response = self.client.get("/api/v1/system-health")

        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["status"], "healthy")
        self.assertEqual(data["frontend_backend"]["status"], "connected")
        self.assertEqual(data["database"]["status"], "available")
        self.assertNotIn("app_version", data)
        self.assertNotIn("uptime_seconds", data)
        self.assertNotIn("errors", data)

    def test_roles_outside_admin_and_manager_are_denied(self) -> None:
        app.dependency_overrides[get_current_user] = lambda: self.staff

        response = self.client.get("/api/v1/system-health")

        self.assertEqual(response.status_code, 403)

    def test_database_failure_is_reported_as_degraded_without_connection_details(self) -> None:
        with patch.object(
            self.db,
            "execute",
            side_effect=OperationalError("SELECT 1", {}, Exception("mysql password must not appear")),
        ):
            response = self.client.get("/api/v1/system-health")

        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["status"], "degraded")
        self.assertEqual(data["database"]["status"], "unavailable")
        self.assertNotIn("mysql password", response.text)
        self.assertIn("OperationalError", data["errors"][0]["message"])

    def test_model_load_failure_is_degraded_and_identifies_only_the_model(self) -> None:
        def load_model(model_name: str) -> object:
            if model_name == "discount_recommendation":
                raise FileNotFoundError("C:/private/path/model.joblib")
            return object()

        with patch("app.services.system_health.load_model_artifact", side_effect=load_model):
            response = self.client.get("/api/v1/system-health")

        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["status"], "degraded")
        discount_model = next(model for model in data["ml_models"] if model["name"] == "discount_recommendation")
        self.assertEqual(discount_model["status"], "unavailable")
        self.assertNotIn("C:/private/path", response.text)
        self.assertEqual(data["errors"][0]["service"], "discount_recommendation")

    def test_health_service_reports_database_failure_as_degraded(self) -> None:
        with patch.object(
            self.db,
            "execute",
            side_effect=OperationalError("SELECT 1", {}, Exception("connection failed")),
        ):
            result = collect_system_health(self.db, is_admin=False, app_version="test")
        self.assertEqual(result["status"], "degraded")
        self.assertEqual(result["database"]["status"], "unavailable")


if __name__ == "__main__":
    unittest.main()
