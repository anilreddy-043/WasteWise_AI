import secrets
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

from app.db.session import engine, get_db, verify_database_connection
from app.main import app
from app.api.v1.router import current_user, logout, register
from app.core.security import get_current_session, require_admin, require_roles, verify_password
from app.core.security import hash_password
from app.models.user import User
from app.models.waste import UserActivity
from app.schemas import LoginRequest, RegisterRequest


def login(payload: LoginRequest, db: Session) -> dict[str, object]:
    app.dependency_overrides[get_db] = lambda: db
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/v1/auth/login",
                json=payload.model_dump(mode="json"),
            )
    finally:
        app.dependency_overrides.pop(get_db, None)
    if response.status_code == 401:
        raise HTTPException(status_code=401, detail=response.json()["detail"])
    if response.status_code != 200:
        raise AssertionError(f"Login endpoint failed: {response.status_code} {response.text}")
    return response.json()


class AuthenticationIntegrationTests(unittest.TestCase):
    test_emails: list[str] = []

    @classmethod
    def setUpClass(cls) -> None:
        verify_database_connection()
        cls.connection = engine.connect()
        cls.transaction = cls.connection.begin()
        cls.db = Session(bind=cls.connection, join_transaction_mode="create_savepoint")

    @classmethod
    def tearDownClass(cls) -> None:
        cls.db.close()
        cls.transaction.rollback()
        cls.connection.close()
        with Session(engine) as verification_db:
            retained_users = verification_db.scalars(
                select(User.email).where(User.email.in_(cls.test_emails))
            ).all()
        if retained_users:
            raise AssertionError("Authentication test left temporary accounts in MySQL.")

    def test_registration_login_roles_logout_and_revocation(self) -> None:
        self.assertEqual(self.connection.execute(text("SELECT 1")).scalar_one(), 1)

        password = "TestPass9!"
        email = f"auth-{secrets.token_hex(12)}@example.com"
        type(self).test_emails.append(email)
        registration = RegisterRequest(
            full_name="  Integration Test  ",
            email=email,
            password=password,
            role="Viewer",
            accepted_terms=True,
        )
        response = register(registration, self.db)
        user = self.db.get(User, response["user_id"])

        self.assertEqual(user.full_name, "Integration Test")
        self.assertEqual(user.role, "viewer")
        self.assertEqual(user.approval_status, "approved")
        self.assertNotEqual(user.password_hash, password)
        self.assertTrue(verify_password(password, user.password_hash))
        self.assertEqual(response["message"], "Your account has been created. You can sign in now.")

        with self.assertRaises(HTTPException) as duplicate_registration:
            register(registration, self.db)
        self.assertEqual(duplicate_registration.exception.status_code, 409)

        with self.assertRaises(ValueError):
            RegisterRequest(
                full_name="Invalid registration",
                email=f"invalid-{secrets.token_hex(12)}@example.com",
                password="weak",
                role="Viewer",
                accepted_terms=True,
            )

        with self.assertRaises(HTTPException) as invalid_login:
            login(LoginRequest(email=email, password="WrongPass9!"), self.db)
        self.assertEqual(invalid_login.exception.status_code, 401)

        token_response = login(LoginRequest(email=email, password=password), self.db)
        credentials = HTTPAuthorizationCredentials(
            scheme="Bearer",
            credentials=token_response["access_token"],
        )
        session = get_current_session(credentials=credentials, db=self.db)
        self.assertEqual(current_user(session.user), {
            "user_id": user.user_id,
            "full_name": "Integration Test",
            "email": email,
            "role": "viewer",
        })

        with self.assertRaises(HTTPException) as missing_token:
            get_current_session(credentials=None, db=self.db)
        self.assertEqual(missing_token.exception.status_code, 401)

        with self.assertRaises(HTTPException) as forbidden_admin:
            require_admin(user)
        self.assertEqual(forbidden_admin.exception.status_code, 403)

        with self.assertRaises(HTTPException) as forbidden_write:
            require_roles("admin", "store_manager", "staff")(user)
        self.assertEqual(forbidden_write.exception.status_code, 403)

        self.assertEqual(logout(session=session, db=self.db)["status"], "ok")
        with self.assertRaises(HTTPException) as revoked_token:
            get_current_session(credentials=credentials, db=self.db)
        self.assertEqual(revoked_token.exception.status_code, 401)

        activity = self.db.scalar(
            select(UserActivity).where(
                UserActivity.user_id == user.user_id,
                UserActivity.action == "session_revoked",
            )
        )
        self.assertEqual(activity.details["jti"], session.token_id)

    def test_legacy_pending_accounts_sign_in_and_admin_activation(self) -> None:
        password = "TestPass9!"
        email = f"approval-{secrets.token_hex(12)}@example.com"
        admin_email = f"approval-admin-{secrets.token_hex(12)}@example.com"
        type(self).test_emails.extend([email, admin_email])

        pending = User(
            full_name="Pending Integration",
            email=email,
            password_hash=hash_password(password),
            role="viewer",
            approval_status="pending",
            is_active=True,
        )
        admin = User(
            full_name="Admin Integration",
            email=admin_email,
            password_hash=hash_password("AdminPass9!"),
            role="admin",
            approval_status="approved",
            is_active=True,
        )
        self.db.add_all([pending, admin])
        self.db.commit()
        self.db.refresh(pending)
        self.db.refresh(admin)

        app.dependency_overrides[get_db] = lambda: self.db
        try:
            with TestClient(app) as client:
                pending_login = client.post(
                    "/api/v1/auth/login",
                    json={"email": email, "password": password},
                )
                self.assertEqual(pending_login.status_code, 200, pending_login.text)
                viewer_headers = {
                    "Authorization": f"Bearer {pending_login.json()['access_token']}",
                }
                current_user_response = client.get("/api/v1/auth/me", headers=viewer_headers)
                self.assertEqual(current_user_response.status_code, 200, current_user_response.text)
                self.assertNotIn("approval_status", current_user_response.json())

                admin_login = client.post(
                    "/api/v1/auth/login",
                    json={"email": admin_email, "password": "AdminPass9!"},
                )
                self.assertEqual(admin_login.status_code, 200)
                admin_headers = {
                    "Authorization": f"Bearer {admin_login.json()['access_token']}",
                }

                listed_users = client.get("/api/v1/users", headers=admin_headers)
                self.assertEqual(listed_users.status_code, 200, listed_users.text)
                self.assertTrue(any(item["user_id"] == pending.user_id for item in listed_users.json()))
                self.assertNotIn("approval_status", listed_users.json()[0])

                removed_approval_route = client.patch(
                    f"/api/v1/users/{pending.user_id}/approval",
                    json={"approval_status": "approved"},
                )
                self.assertEqual(removed_approval_route.status_code, 404)

                forbidden_activation = client.patch(
                    f"/api/v1/users/{pending.user_id}/active",
                    json={"is_active": False},
                    headers=viewer_headers,
                )
                self.assertEqual(forbidden_activation.status_code, 403)

                deactivated = client.patch(
                    f"/api/v1/users/{pending.user_id}/active",
                    json={"is_active": False},
                    headers=admin_headers,
                )
                self.assertEqual(deactivated.status_code, 200, deactivated.text)
                self.assertFalse(deactivated.json()["is_active"])
                inactive_login = client.post(
                    "/api/v1/auth/login",
                    json={"email": email, "password": password},
                )
                self.assertEqual(inactive_login.status_code, 403)
                self.assertIn("account is inactive", inactive_login.json()["detail"])

                self_deactivation = client.patch(
                    f"/api/v1/users/{admin.user_id}/active",
                    json={"is_active": False},
                    headers=admin_headers,
                )
                self.assertEqual(self_deactivation.status_code, 409)

                reactivated = client.patch(
                    f"/api/v1/users/{pending.user_id}/active",
                    json={"is_active": True},
                    headers=admin_headers,
                )
                self.assertEqual(reactivated.status_code, 200, reactivated.text)
                self.assertTrue(reactivated.json()["is_active"])
        finally:
            app.dependency_overrides.clear()

    def test_login_invalid_credentials_return_401(self) -> None:
        password = "TestPass9!"
        email = f"invalid-login-{secrets.token_hex(12)}@example.com"
        type(self).test_emails.append(email)
        user = User(
            full_name="Login Integration",
            email=email,
            password_hash=hash_password(password),
            role="staff",
            approval_status="approved",
            is_active=True,
        )
        self.db.add(user)
        self.db.commit()

        app.dependency_overrides[get_db] = lambda: self.db
        try:
            with TestClient(app) as client:
                wrong_password = client.post(
                    "/api/v1/auth/login",
                    json={"email": email, "password": "WrongPass9!"},
                )
                missing_account = client.post(
                    "/api/v1/auth/login",
                    json={
                        "email": f"missing-{secrets.token_hex(12)}@example.com",
                        "password": password,
                    },
                )
        finally:
            app.dependency_overrides.clear()

        self.assertEqual(wrong_password.status_code, 401, wrong_password.text)
        self.assertEqual(missing_account.status_code, 401, missing_account.text)
        self.assertEqual(wrong_password.json()["detail"], "Invalid email or password.")
        self.assertEqual(missing_account.json()["detail"], "Invalid email or password.")

    def test_login_database_error_returns_retryable_service_error(self) -> None:
        app.dependency_overrides[get_db] = lambda: self.db
        database_error = OperationalError(
            "SELECT users.user_id FROM users",
            {},
            RuntimeError("database unavailable"),
        )
        try:
            with (
                patch.object(self.db, "scalar", side_effect=database_error),
                self.assertLogs("app.api.v1.router", level="ERROR"),
                TestClient(app) as client,
            ):
                response = client.post(
                    "/api/v1/auth/login",
                    json={
                        "email": f"database-error-{secrets.token_hex(12)}@example.com",
                        "password": "TestPass9!",
                    },
                )
        finally:
            app.dependency_overrides.clear()

        self.assertEqual(response.status_code, 503, response.text)
        self.assertEqual(
            response.json()["detail"],
            "Sign-in is temporarily unavailable. Please try again.",
        )

    def test_public_registration_cannot_assign_admin(self) -> None:
        with self.assertRaises(ValueError):
            RegisterRequest(
                full_name="Not an admin",
                email=f"admin-{secrets.token_hex(12)}@example.com",
                password="TestPass9!",
                role="admin",
                accepted_terms=True,
            )


if __name__ == "__main__":
    unittest.main()
