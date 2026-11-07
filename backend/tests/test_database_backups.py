import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.security import get_current_user
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models import Product, User, UserActivity
from app.services import database_backup


class DatabaseBackupApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.backup_directory = Path(self.temporary_directory.name) / "private-backups"
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        self.assertEqual(self.engine.dialect.name, "sqlite")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine, expire_on_commit=False)
        self.admin = User(
            user_id=1,
            full_name="Test Administrator",
            email="admin@example.test",
            password_hash="unused",
            role="admin",
            approval_status="approved",
            is_active=True,
        )
        self.manager = User(
            user_id=2,
            full_name="Test Manager",
            email="manager@example.test",
            password_hash="unused",
            role="store_manager",
            approval_status="approved",
            is_active=True,
        )
        self.product = Product(
            product_id=1,
            name="Fresh Milk",
            category="Dairy",
            sku="MILK-001",
            unit="L",
            price="4.50",
            supplier="Local Farm",
        )
        self.db.add_all([self.admin, self.manager, self.product])
        self.db.commit()
        app.dependency_overrides[get_db] = lambda: self.db
        app.dependency_overrides[get_current_user] = lambda: self.admin
        self.directory_patch = patch.object(database_backup, "BACKUP_DIRECTORY", self.backup_directory)
        self.secret_patch = patch.object(database_backup, "get_auth_secret", return_value="test-secret" * 5)
        self.settings_patch = patch.object(
            database_backup,
            "get_database_settings",
            return_value=SimpleNamespace(host="sqlite-test", port=0, name="isolated-test"),
        )
        self.directory_patch.start()
        self.secret_patch.start()
        self.settings_patch.start()
        self.client = TestClient(app)

    def tearDown(self) -> None:
        app.dependency_overrides.clear()
        self.client.close()
        self.db.close()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()
        self.directory_patch.stop()
        self.secret_patch.stop()
        self.settings_patch.stop()
        self.temporary_directory.cleanup()

    def test_create_backup_and_download_is_admin_only_and_audited(self) -> None:
        response = self.client.post("/api/v1/backups")
        self.assertEqual(response.status_code, 201, response.text)
        details = response.json()
        self.assertEqual(details["status"], "completed")
        self.assertGreater(details["size_bytes"], 0)
        self.assertTrue(details["filename"].endswith(".wwbackup"))
        self.assertTrue((self.backup_directory / details["filename"]).is_file())
        self.assertEqual(
            self.db.scalar(
                select(func.count()).select_from(UserActivity).where(
                    UserActivity.action == "database_backup_created"
                )
            ),
            1,
        )

        downloaded = self.client.get(f"/api/v1/backups/{details['backup_id']}/download")
        self.assertEqual(downloaded.status_code, 200, downloaded.text)
        self.assertEqual(downloaded.content[:4], b"WWB1")
        self.assertIn("private, no-store", downloaded.headers["cache-control"])
        self.assertNotIn("test-secret", downloaded.text)

    def test_non_admin_cannot_list_create_download_or_restore(self) -> None:
        self.admin.role = "store_manager"
        self.db.commit()

        self.assertEqual(self.client.get("/api/v1/backups").status_code, 403)
        self.assertEqual(self.client.post("/api/v1/backups").status_code, 403)
        self.assertEqual(
            self.client.get(f"/api/v1/backups/{'a' * 32}/download").status_code,
            403,
        )
        self.assertEqual(
            self.client.post(
                f"/api/v1/backups/{'a' * 32}/restore",
                json={"confirm_restore": True, "confirmation_text": "RESTORE DATABASE"},
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.post(
                "/api/v1/backups/upload",
                files={"file": ("safe.wwbackup", b"nope", "application/octet-stream")},
            ).status_code,
            403,
        )

    def test_backup_history_and_download_require_authentication(self) -> None:
        app.dependency_overrides.pop(get_current_user)

        self.assertEqual(self.client.get("/api/v1/backups").status_code, 401)
        self.assertEqual(
            self.client.get(f"/api/v1/backups/{'a' * 32}/download").status_code,
            401,
        )

    def test_restore_requires_explicit_confirmation_and_restores_only_verified_backup(self) -> None:
        created = self.client.post("/api/v1/backups")
        self.assertEqual(created.status_code, 201, created.text)
        backup_id = created.json()["backup_id"]
        self.db.add(
            UserActivity(
                user_id=1,
                action="session_revoked",
                entity_type="user_session",
                details={"jti": "revoked-after-backup"},
            )
        )
        self.product.name = "Changed milk"
        self.db.add(
            Product(
                product_id=2,
                name="New Product",
                category="Fruit",
                sku="APPLE-001",
                unit="kg",
                price="2.00",
                supplier="Farm",
            )
        )
        self.db.commit()

        missing_confirmation = self.client.post(
            f"/api/v1/backups/{backup_id}/restore",
            json={"confirm_restore": False, "confirmation_text": "RESTORE DATABASE"},
        )
        self.assertEqual(missing_confirmation.status_code, 400)
        self.assertEqual(self.db.scalar(select(Product.name).where(Product.product_id == 1)), "Changed milk")

        wrong_confirmation = self.client.post(
            f"/api/v1/backups/{backup_id}/restore",
            json={"confirm_restore": True, "confirmation_text": "yes"},
        )
        self.assertEqual(wrong_confirmation.status_code, 400)
        self.assertEqual(self.db.scalar(select(Product.name).where(Product.product_id == 1)), "Changed milk")

        restored = self.client.post(
            f"/api/v1/backups/{backup_id}/restore",
            json={"confirm_restore": True, "confirmation_text": "RESTORE DATABASE"},
        )
        self.assertEqual(restored.status_code, 200, restored.text)
        self.assertEqual(restored.json()["status"], "completed")
        self.assertEqual(self.db.scalar(select(Product.name).where(Product.product_id == 1)), "Fresh Milk")
        self.assertEqual(self.db.scalar(select(func.count()).select_from(Product)), 1)
        self.assertEqual(
            self.db.scalar(
                select(func.count()).select_from(UserActivity).where(
                    UserActivity.action == "session_revoked",
                    UserActivity.details["jti"].as_string() == "revoked-after-backup",
                )
            ),
            1,
        )
        self.assertEqual(
            self.db.scalar(
                select(func.count()).select_from(UserActivity).where(
                    UserActivity.action == "database_restore_completed"
                )
            ),
            1,
        )
        history = self.client.get("/api/v1/backups")
        self.assertEqual(history.status_code, 200, history.text)
        self.assertGreaterEqual(len(history.json()), 2)

    def test_corrupt_backup_is_rejected_without_changing_records(self) -> None:
        created = self.client.post("/api/v1/backups")
        self.assertEqual(created.status_code, 201, created.text)
        backup = self.backup_directory / created.json()["filename"]
        backup.write_bytes(b"not a database backup")

        response = self.client.post(
            f"/api/v1/backups/{created.json()['backup_id']}/restore",
            json={"confirm_restore": True, "confirmation_text": "RESTORE DATABASE"},
        )
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(Product)), 1)
        self.assertEqual(self.db.scalar(select(Product.name)), "Fresh Milk")

    def test_import_only_accepts_verified_backup_files_and_ignores_upload_paths(self) -> None:
        created = self.client.post("/api/v1/backups")
        self.assertEqual(created.status_code, 201, created.text)
        details = created.json()
        backup_path = self.backup_directory / details["filename"]
        archive_bytes = backup_path.read_bytes()
        backup_path.unlink()

        traversal = self.client.post(
            "/api/v1/backups/upload",
            files={"file": ("..\\outside.wwbackup", archive_bytes, "application/octet-stream")},
        )
        self.assertEqual(traversal.status_code, 415, traversal.text)
        self.assertEqual(list(self.backup_directory.glob("*.wwbackup")), [])

        invalid = self.client.post(
            "/api/v1/backups/upload",
            files={"file": ("malformed.wwbackup", b"not encrypted backup", "application/octet-stream")},
        )
        self.assertEqual(invalid.status_code, 422, invalid.text)
        self.assertEqual(list(self.backup_directory.glob("*.wwbackup")), [])

        imported = self.client.post(
            "/api/v1/backups/upload",
            files={"file": (details["filename"], archive_bytes, "application/octet-stream")},
        )
        self.assertEqual(imported.status_code, 201, imported.text)
        self.assertEqual(imported.json()["backup_id"], details["backup_id"])
        self.assertEqual(imported.json()["status"], "available")
        self.assertTrue((self.backup_directory / imported.json()["filename"]).is_file())
        self.assertEqual(
            self.db.scalar(
                select(func.count()).select_from(UserActivity).where(
                    UserActivity.action == "database_backup_imported"
                )
            ),
            1,
        )

    def test_history_reports_missing_backup_files(self) -> None:
        created = self.client.post("/api/v1/backups")
        self.assertEqual(created.status_code, 201, created.text)
        details = created.json()
        (self.backup_directory / details["filename"]).unlink()

        history = self.client.get("/api/v1/backups")
        self.assertEqual(history.status_code, 200, history.text)
        entry = next(item for item in history.json() if item["backup_id"] == details["backup_id"])
        self.assertEqual(entry["status"], "missing")
        self.assertEqual(entry["filename"], details["filename"])

    def test_backup_identifiers_cannot_select_arbitrary_paths(self) -> None:
        response = self.client.get(f"/api/v1/backups/{'../' + 'a' * 30}/download")
        self.assertEqual(response.status_code, 404)
