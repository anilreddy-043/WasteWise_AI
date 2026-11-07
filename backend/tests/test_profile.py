import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.security import get_current_user
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models import User, UserActivity
from app.services.audit_log_service import activity_status


class UserProfileApiTests(unittest.TestCase):
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
            full_name="Profile Manager",
            email="manager@example.test",
            password_hash="do-not-return-this-hash",
            role="store_manager",
            approval_status="approved",
            is_active=True,
        )
        self.db.add(self.user)
        self.db.commit()
        app.dependency_overrides[get_db] = lambda: self.db
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.temp_dir = tempfile.TemporaryDirectory()
        self.image_directory_patcher = patch(
            "app.services.profile_images.PROFILE_IMAGE_DIR",
            Path(self.temp_dir.name),
        )
        self.image_directory_patcher.start()
        self.client = TestClient(app)

    def tearDown(self) -> None:
        app.dependency_overrides.clear()
        self.client.close()
        self.image_directory_patcher.stop()
        self.temp_dir.cleanup()
        self.db.close()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def test_profile_returns_saved_account_details_without_secrets(self) -> None:
        response = self.client.get("/api/v1/profile")

        self.assertEqual(response.status_code, 200, response.text)
        profile = response.json()
        self.assertEqual(profile["full_name"], "Profile Manager")
        self.assertEqual(profile["email"], "manager@example.test")
        self.assertEqual(profile["role"], "store_manager")
        self.assertEqual(profile["approval_status"], "approved")
        self.assertTrue(profile["is_active"])
        self.assertTrue(profile["created_at"])
        self.assertIsNone(profile["profile_image_url"])
        self.assertNotIn("password_hash", response.text)
        self.assertNotIn("do-not-return-this-hash", response.text)

    def test_profile_update_changes_only_full_name_and_is_audited(self) -> None:
        response = self.client.patch("/api/v1/profile", json={"full_name": "  Updated Name  "})

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["full_name"], "Updated Name")
        self.assertEqual(response.json()["role"], "store_manager")
        self.assertEqual(response.json()["email"], "manager@example.test")
        activity = self.db.scalar(select(UserActivity).where(UserActivity.action == "profile_updated"))
        self.assertIsNotNone(activity)
        self.assertEqual(activity.user_id, self.user.user_id)
        self.assertEqual(activity.details, {"changed_fields": ["full_name"]})
        self.assertEqual(activity_status(activity.action), "successful")

    def test_profile_update_rejects_empty_names_and_privileged_fields(self) -> None:
        empty_name = self.client.patch("/api/v1/profile", json={"full_name": "   "})
        role_change = self.client.patch(
            "/api/v1/profile",
            json={"full_name": "Profile Manager", "role": "admin"},
        )
        email_change = self.client.patch(
            "/api/v1/profile",
            json={"full_name": "Profile Manager", "email": "new@example.test"},
        )

        self.assertEqual(empty_name.status_code, 422)
        self.assertEqual(role_change.status_code, 422)
        self.assertEqual(email_change.status_code, 422)
        self.assertEqual(self.user.role, "store_manager")
        self.assertEqual(self.user.email, "manager@example.test")
        self.assertEqual(
            self.db.scalar(select(UserActivity).where(UserActivity.action == "profile_updated")),
            None,
        )

    def test_profile_image_upload_is_private_and_can_be_removed(self) -> None:
        image_bytes = b"\x89PNG\r\n\x1a\n" + b"profile-test"
        uploaded = self.client.post(
            "/api/v1/profile/image",
            files={"file": ("profile.png", image_bytes, "image/png")},
        )

        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        image_url = uploaded.json()["profile_image_url"]
        self.assertIn("/api/v1/profile/image?v=", image_url)
        profile = self.client.get("/api/v1/profile").json()
        self.assertEqual(profile["profile_image_url"], image_url)
        image = self.client.get(image_url)
        self.assertEqual(image.status_code, 200, image.text)
        self.assertEqual(image.content, image_bytes)
        self.assertEqual(image.headers["cache-control"], "private, no-store")

        image_update = self.db.scalar(select(UserActivity).where(UserActivity.action == "profile_image_updated"))
        self.assertEqual(image_update.user_id, 1)
        self.assertEqual(activity_status(image_update.action), "successful")
        removed = self.client.delete("/api/v1/profile/image")
        self.assertEqual(removed.status_code, 204)
        self.assertIsNone(self.client.get("/api/v1/profile").json()["profile_image_url"])
        image_removal = self.db.scalar(select(UserActivity).where(UserActivity.action == "profile_image_removed"))
        self.assertEqual(image_removal.user_id, 1)
        self.assertEqual(activity_status(image_removal.action), "successful")
        self.assertEqual(self.client.get(image_url).status_code, 404)

    def test_profile_image_upload_rejects_invalid_format_and_oversize(self) -> None:
        unsupported = self.client.post(
            "/api/v1/profile/image",
            files={"file": ("profile.svg", b"<svg/>", "image/svg+xml")},
        )
        invalid_signature = self.client.post(
            "/api/v1/profile/image",
            files={"file": ("profile.png", b"not a png", "image/png")},
        )
        oversized = self.client.post(
            "/api/v1/profile/image",
            files={"file": ("profile.png", b"\x89PNG\r\n\x1a\n" + b"x" * (5 * 1024 * 1024), "image/png")},
        )

        self.assertEqual(unsupported.status_code, 415)
        self.assertEqual(invalid_signature.status_code, 422)
        self.assertEqual(oversized.status_code, 413)
        self.assertFalse(any(Path(self.temp_dir.name).iterdir()))

    def test_profile_endpoints_require_authentication(self) -> None:
        app.dependency_overrides.pop(get_current_user)

        profile = self.client.get("/api/v1/profile")
        update = self.client.patch("/api/v1/profile", json={"full_name": "Unauthorized"})
        upload = self.client.post(
            "/api/v1/profile/image",
            files={"file": ("profile.png", b"\x89PNG\r\n\x1a\n", "image/png")},
        )
        image = self.client.get("/api/v1/profile/image")

        self.assertEqual(profile.status_code, 401)
        self.assertEqual(update.status_code, 401)
        self.assertEqual(upload.status_code, 401)
        self.assertEqual(image.status_code, 401)
