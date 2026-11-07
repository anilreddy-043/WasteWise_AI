import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from unittest.mock import patch
from importlib import import_module

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.security import get_current_user
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models import StoreInformation, User


api_router = import_module("app.api.v1.router")


class StoreInformationApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        database_path = Path(self.temp_dir.name) / "store-information.sqlite"
        self.engine = create_engine(
            f"sqlite:///{database_path}",
            connect_args={"check_same_thread": False, "timeout": 20},
        )
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine, expire_on_commit=False)
        self.manager = User(
            user_id=1,
            full_name="Store Manager",
            email="store-manager@example.test",
            password_hash="unused",
            role="store_manager",
            approval_status="approved",
            is_active=True,
        )
        self.admin = User(
            user_id=2,
            full_name="Store Admin",
            email="admin@example.test",
            password_hash="unused",
            role="admin",
            approval_status="approved",
            is_active=True,
        )
        self.staff = User(
            user_id=3,
            full_name="Staff User",
            email="staff@example.test",
            password_hash="unused",
            role="staff",
            approval_status="approved",
            is_active=True,
        )
        self.db.add_all([self.manager, self.admin, self.staff])
        self.db.commit()
        self.current_user = self.manager

        def override_get_db():
            with Session(self.engine, expire_on_commit=False) as session:
                yield session

        app.dependency_overrides[get_db] = override_get_db
        app.dependency_overrides[get_current_user] = lambda: self.current_user
        self.client = TestClient(app)

    def tearDown(self) -> None:
        app.dependency_overrides.clear()
        self.client.close()
        self.db.close()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()
        self.temp_dir.cleanup()

    def test_get_returns_empty_defaults_when_shared_store_row_does_not_exist(self) -> None:
        response = self.client.get("/api/v1/settings/store")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {
            "store_id": 1,
            "store_name": "",
            "store_address": "",
            "contact_number": "",
            "email": "",
            "logo_path": None,
            "logo_url": None,
            "created_at": None,
            "updated_at": None,
        })

    def test_admin_and_manager_read_and_update_the_same_store_information(self) -> None:
        payload = {
            "store_name": "Green Basket",
            "store_address": "102 Market Street, Hyderabad",
            "contact_number": "+91 98765 43210",
            "email": "hello@greenbasket.example",
        }

        manager_update = self.client.put("/api/v1/settings/store", json=payload)
        self.current_user = self.admin
        admin_read = self.client.get("/api/v1/settings/store")
        admin_update = self.client.put(
            "/api/v1/settings/store",
            json={**payload, "store_name": "Green Basket Updated"},
        )
        self.current_user = self.manager
        manager_read = self.client.get("/api/v1/settings/store")

        self.assertEqual(manager_update.status_code, 200, manager_update.text)
        self.assertEqual(admin_read.status_code, 200, admin_read.text)
        self.assertEqual(admin_read.json()["store_name"], "Green Basket")
        self.assertEqual(admin_update.status_code, 200, admin_update.text)
        self.assertEqual(manager_read.status_code, 200, manager_read.text)
        self.assertEqual(manager_read.json()["store_name"], "Green Basket Updated")
        self.assertEqual(manager_read.json()["email"], "hello@greenbasket.example")
        self.assertEqual(self.db.scalar(select(func.count()).select_from(StoreInformation)), 1)

    def test_logo_uploaded_by_admin_is_retrievable_by_manager(self) -> None:
        self.current_user = self.admin
        payload = {
            "store_name": "Fresh Cart",
            "store_address": "18 Garden Road",
            "contact_number": "+91 99800 11222",
            "email": "fresh@cart.example",
        }
        self.client.put("/api/v1/settings/store", json=payload)
        png_bytes = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
        logo_root = Path(self.temp_dir.name) / "backend"

        def save_logo(store_id: int, extension: str, contents: bytes) -> Path:
            path = logo_root / "uploads" / "store" / f"{store_id}{extension}"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(contents)
            return path

        with (
            patch.object(api_router, "save_store_logo", side_effect=save_logo),
            patch.object(api_router, "BACKEND_DIR", logo_root),
        ):
            uploaded = self.client.post(
                "/api/v1/settings/store/logo",
                files={"file": ("logo.png", png_bytes, "image/png")},
            )
            self.assertEqual(uploaded.status_code, 200, uploaded.text)
            self.current_user = self.manager
            store_details = self.client.get("/api/v1/settings/store")
            logo = self.client.get("/api/v1/settings/store/logo")

        self.assertEqual(store_details.status_code, 200, store_details.text)
        self.assertEqual(store_details.json()["logo_path"], "uploads/store/1.png")
        self.assertEqual(logo.status_code, 200, logo.text)
        self.assertEqual(logo.content, png_bytes)
        self.assertIsNotNone(self.db.scalar(select(StoreInformation.logo_path).where(StoreInformation.store_id == 1)))

    def test_other_roles_cannot_read_or_change_store_information(self) -> None:
        self.current_user = self.staff
        self.assertEqual(self.client.get("/api/v1/settings/store").status_code, 403)
        self.assertEqual(self.client.get("/api/v1/settings/store/logo").status_code, 403)
        response = self.client.put(
            "/api/v1/settings/store",
            json={
                "store_name": "Unauthorized",
                "store_address": "Address",
                "contact_number": "+91 99800 11222",
                "email": "valid@example.com",
            },
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.db.scalar(select(func.count()).select_from(StoreInformation)), 0)

    def test_concurrent_first_updates_create_only_one_shared_store_row(self) -> None:
        barrier = Barrier(2)

        def update_store(name: str):
            with TestClient(app) as client:
                barrier.wait(timeout=10)
                return client.put(
                    "/api/v1/settings/store",
                    json={
                        "store_name": name,
                        "store_address": "Concurrent Address",
                        "contact_number": "+91 99800 11222",
                        "email": "concurrent@example.com",
                    },
                )

        with ThreadPoolExecutor(max_workers=2) as executor:
            responses = list(executor.map(update_store, ("Store A", "Store B")))

        self.assertTrue(all(response.status_code == 200 for response in responses), [r.text for r in responses])
        self.assertEqual(self.db.scalar(select(func.count()).select_from(StoreInformation)), 1)
        self.assertIn(self.db.get(StoreInformation, 1).store_name, {"Store A", "Store B"})

    def test_database_constraint_rejects_another_store_id(self) -> None:
        self.db.add(StoreInformation(store_id=2))
        with self.assertRaises(IntegrityError):
            self.db.commit()
        self.db.rollback()
        self.assertEqual(self.db.scalar(select(func.count()).select_from(StoreInformation)), 0)

    def test_put_rejects_invalid_store_contact_and_email(self) -> None:
        invalid_payloads = [
            {"store_name": "Valid", "store_address": "Valid", "contact_number": "abc", "email": "valid@example.com"},
            {"store_name": "Valid", "store_address": "Valid", "contact_number": "+91 99800 11222", "email": "invalid-email"},
            {"store_name": "   ", "store_address": "Valid", "contact_number": "+91 99800 11222", "email": "valid@example.com"},
        ]

        for payload in invalid_payloads:
            with self.subTest(payload=payload):
                response = self.client.put("/api/v1/settings/store", json=payload)
                self.assertEqual(response.status_code, 422, response.text)

        self.assertEqual(self.db.scalar(select(func.count()).select_from(StoreInformation)), 0)
