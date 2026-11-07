import tempfile
import unittest
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.security import get_current_user
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models import Product, User


class ProductImageApiTests(unittest.TestCase):
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
            full_name="Image Manager",
            email="image-manager@example.test",
            password_hash="unused",
            role="store_manager",
            approval_status="approved",
            is_active=True,
        )
        self.product = Product(
            product_id=1,
            name="Image Test Product",
            category="Other",
            sku="IMAGE-001",
            unit="Piece",
            price=Decimal("3.00"),
            supplier="Test Supplier",
        )
        self.db.add_all([self.user, self.product])
        self.db.commit()
        app.dependency_overrides[get_db] = lambda: self.db
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.temp_dir = tempfile.TemporaryDirectory()
        self.image_directory_patcher = patch(
            "app.services.product_images.PRODUCT_IMAGE_DIR",
            Path(self.temp_dir.name),
        )
        self.image_directory_patcher.start()
        self.client = TestClient(app)

    def tearDown(self) -> None:
        app.dependency_overrides.clear()
        self.image_directory_patcher.stop()
        self.temp_dir.cleanup()
        self.db.close()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def test_product_image_upload_is_returned_to_pos_and_can_be_removed(self) -> None:
        image_bytes = b"\x89PNG\r\n\x1a\n" + b"test image bytes"
        uploaded = self.client.post(
            "/api/v1/products/1/image",
            content=image_bytes,
            headers={"Content-Type": "image/png"},
        )
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        image_url = uploaded.json()["image_url"]
        self.assertIn("/api/v1/products/1/image?v=", image_url)

        products = self.client.get("/api/v1/products")
        self.assertEqual(products.status_code, 200, products.text)
        self.assertEqual(products.json()[0]["image_url"], image_url)
        image = self.client.get(image_url)
        self.assertEqual(image.status_code, 200, image.text)
        self.assertEqual(image.content, image_bytes)
        self.assertEqual(image.headers["content-type"], "image/png")

        removed = self.client.delete("/api/v1/products/1/image")
        self.assertEqual(removed.status_code, 204)
        products_after_removal = self.client.get("/api/v1/products")
        self.assertIsNone(products_after_removal.json()[0]["image_url"])
        self.assertEqual(self.client.get(image_url).status_code, 404)

    def test_upload_rejects_unsupported_and_invalid_image_data(self) -> None:
        unsupported = self.client.post(
            "/api/v1/products/1/image",
            content=b"<svg/>",
            headers={"Content-Type": "image/svg+xml"},
        )
        self.assertEqual(unsupported.status_code, 415)

        invalid = self.client.post(
            "/api/v1/products/1/image",
            content=b"not a png",
            headers={"Content-Type": "image/png"},
        )
        self.assertEqual(invalid.status_code, 422)

    def test_upload_rejects_images_over_five_megabytes(self) -> None:
        oversized = b"\x89PNG\r\n\x1a\n" + b"x" * (5 * 1024 * 1024)
        response = self.client.post(
            "/api/v1/products/1/image",
            content=oversized,
            headers={"Content-Type": "image/png"},
        )
        self.assertEqual(response.status_code, 413)
