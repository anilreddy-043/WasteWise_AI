import unittest
from decimal import Decimal
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.security import get_current_user, hash_password
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models import Product, User, UserActivity


class SecurityAccessControlTests(unittest.TestCase):
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
            full_name="Test Administrator",
            email="admin@example.com",
            password_hash=hash_password("AdminPass123!"),
            role="admin",
            approval_status="approved",
            is_active=True,
        )
        self.manager = User(
            user_id=2,
            full_name="Test Manager",
            email="manager@example.com",
            password_hash=hash_password("ManagerPass123!"),
            role="store_manager",
            approval_status="approved",
            is_active=True,
        )
        self.staff = User(
            user_id=3,
            full_name="Test Staff",
            email="staff@example.com",
            password_hash=hash_password("StaffPass123!"),
            role="staff",
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
        self.db.add_all([self.admin, self.manager, self.staff, self.product])
        self.db.commit()
        self.current_user = self.admin
        app.dependency_overrides[get_db] = lambda: self.db
        app.dependency_overrides[get_current_user] = lambda: self.current_user
        self.secret_patch = patch("app.core.security.get_auth_secret", return_value="isolated-test-auth-secret")
        self.secret_patch.start()
        self.client = TestClient(app)

    def tearDown(self) -> None:
        app.dependency_overrides.clear()
        self.client.close()
        self.db.close()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()
        self.secret_patch.stop()

    def test_failed_logins_are_audited_without_credentials_and_rate_limited(self) -> None:
        for _ in range(10):
            response = self.client.post(
                "/api/v1/auth/login",
                json={"email": "admin@example.com", "password": "WrongPass123!"},
            )
            self.assertEqual(response.status_code, 401, response.text)

        blocked = self.client.post(
            "/api/v1/auth/login",
            json={"email": "admin@example.com", "password": "WrongPass123!"},
        )
        self.assertEqual(blocked.status_code, 429, blocked.text)
        self.assertGreater(int(blocked.headers["retry-after"]), 0)

        activities = self.db.scalars(
            select(UserActivity).where(UserActivity.action == "auth_login_failed")
        ).all()
        self.assertEqual(len(activities), 10)
        for activity in activities:
            serialized = str(activity.details)
            self.assertNotIn("admin@example.com", serialized)
            self.assertNotIn("WrongPass123!", serialized)
            self.assertNotIn("testclient", serialized)
            self.assertTrue(activity.details["principal_key"])
            self.assertTrue(activity.details["ip_key"])

    def test_password_change_verifies_current_password_and_revokes_sessions(self) -> None:
        signed_in = self.client.post(
            "/api/v1/auth/login",
            json={"email": "admin@example.com", "password": "AdminPass123!"},
        )
        self.assertEqual(signed_in.status_code, 200, signed_in.text)
        token = signed_in.json()["access_token"]
        headers = {"Authorization": f"Bearer {token}"}

        bad_change = self.client.post(
            "/api/v1/auth/change-password",
            headers=headers,
            json={"current_password": "not-current", "new_password": "NewPass456!"},
        )
        self.assertEqual(bad_change.status_code, 400, bad_change.text)
        self.assertNotIn("password_hash", bad_change.text)

        changed = self.client.post(
            "/api/v1/auth/change-password",
            headers=headers,
            json={"current_password": "AdminPass123!", "new_password": "NewPass456!"},
        )
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertNotIn("password_hash", changed.text)
        app.dependency_overrides.pop(get_current_user)
        self.assertEqual(self.client.get("/api/v1/auth/me", headers=headers).status_code, 401)

        new_login = self.client.post(
            "/api/v1/auth/login",
            json={"email": "admin@example.com", "password": "NewPass456!"},
        )
        self.assertEqual(new_login.status_code, 200, new_login.text)
        self.assertNotIn("password_hash", new_login.text)

    def test_password_change_rejects_weak_and_unchanged_passwords(self) -> None:
        signed_in = self.client.post(
            "/api/v1/auth/login",
            json={"email": "admin@example.com", "password": "AdminPass123!"},
        )
        headers = {"Authorization": f"Bearer {signed_in.json()['access_token']}"}

        weak = self.client.post(
            "/api/v1/auth/change-password",
            headers=headers,
            json={"current_password": "AdminPass123!", "new_password": "weak"},
        )
        same = self.client.post(
            "/api/v1/auth/change-password",
            headers=headers,
            json={"current_password": "AdminPass123!", "new_password": "AdminPass123!"},
        )
        self.assertEqual(weak.status_code, 422)
        self.assertEqual(same.status_code, 422)

    def test_role_changes_are_admin_only_audited_and_revoke_target_sessions(self) -> None:
        self.db.add(
            UserActivity(
                user_id=self.manager.user_id,
                action="session_started",
                entity_type="auth_session",
                details={"jti": "manager-session"},
            )
        )
        self.db.commit()

        updated = self.client.patch(
            f"/api/v1/users/{self.manager.user_id}/role",
            json={"role": "viewer"},
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["role"], "viewer")
        self.assertTrue(
            self.db.scalar(
                select(UserActivity.activity_id).where(
                    UserActivity.user_id == self.manager.user_id,
                    UserActivity.action == "session_revoked",
                    UserActivity.details["jti"].as_string() == "manager-session",
                )
            )
        )
        audit = self.db.scalar(
            select(UserActivity).where(UserActivity.action == "user_role_changed")
        )
        self.assertEqual(audit.details["previous_role"], "store_manager")
        self.assertEqual(audit.details["new_role"], "viewer")

        self.current_user = self.manager
        forbidden = self.client.patch(
            f"/api/v1/users/{self.staff.user_id}/role",
            json={"role": "admin"},
        )
        self.assertEqual(forbidden.status_code, 403, forbidden.text)

    def test_last_active_administrator_cannot_be_demoted_or_deactivated(self) -> None:
        demoted = self.client.patch(
            f"/api/v1/users/{self.admin.user_id}/role",
            json={"role": "store_manager"},
        )
        deactivated = self.client.patch(
            f"/api/v1/users/{self.admin.user_id}/active",
            json={"is_active": False},
        )
        self.assertEqual(demoted.status_code, 409, demoted.text)
        self.assertEqual(deactivated.status_code, 409, deactivated.text)
        self.assertEqual(self.admin.role, "admin")
        self.assertTrue(self.admin.is_active)

    def test_admin_and_manager_daily_permissions_staff_read_only(self) -> None:
        product_payload = {
            "name": "Fresh Apples",
            "category": "Fruit",
            "sku": "APPLE-001",
            "unit": "kg",
            "price": "3.25",
            "supplier": "Orchard",
        }
        self.current_user = self.manager
        manager_create = self.client.post("/api/v1/products", json=product_payload)
        self.assertEqual(manager_create.status_code, 201, manager_create.text)

        self.current_user = self.staff
        staff_read = self.client.get("/api/v1/products")
        staff_write = self.client.post(
            "/api/v1/products",
            json={**product_payload, "sku": "APPLE-002"},
        )
        self.assertEqual(staff_read.status_code, 200, staff_read.text)
        self.assertEqual(staff_write.status_code, 403, staff_write.text)

        self.current_user = self.admin
        self.assertEqual(self.client.get("/api/v1/users").status_code, 200)
        self.current_user = self.manager
        self.assertEqual(self.client.get("/api/v1/users").status_code, 403)
        self.assertEqual(
            self.client.post("/api/v1/inventory/batches/import/preview", json={"csv_text": ""}).status_code,
            403,
        )

    def test_protected_endpoints_require_authentication(self) -> None:
        app.dependency_overrides.pop(get_current_user)
        self.assertEqual(self.client.get("/api/v1/users").status_code, 401)
        self.assertEqual(self.client.post("/api/v1/auth/change-password").status_code, 401)
        self.assertEqual(
            self.db.scalar(select(func.count()).select_from(User)),
            3,
        )


if __name__ == "__main__":
    unittest.main()
