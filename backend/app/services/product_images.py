from __future__ import annotations

from pathlib import Path
from uuid import uuid4

from app.core.config import BACKEND_DIR

PRODUCT_IMAGE_DIR = BACKEND_DIR / "uploads" / "products"
IMAGE_EXTENSIONS = {
    "image/jpeg": (".jpg", b"\xff\xd8\xff"),
    "image/png": (".png", b"\x89PNG\r\n\x1a\n"),
    "image/webp": (".webp", None),
}
MAX_PRODUCT_IMAGE_BYTES = 5 * 1024 * 1024


def product_image_path(product_id: int) -> Path | None:
    for extension in (".jpg", ".png", ".webp"):
        path = PRODUCT_IMAGE_DIR / f"{product_id}{extension}"
        if path.is_file():
            return path
    return None


def product_image_url(product_id: int) -> str | None:
    path = product_image_path(product_id)
    if path is None:
        return None
    return f"/api/v1/products/{product_id}/image?v={path.stat().st_mtime_ns}"


def validate_product_image(content_type: str, contents: bytes) -> str | None:
    image_format = IMAGE_EXTENSIONS.get(content_type)
    if image_format is None or not contents:
        return None
    extension, signature = image_format
    if signature is not None:
        return extension if contents.startswith(signature) else None
    if len(contents) < 12 or contents[:4] != b"RIFF" or contents[8:12] != b"WEBP":
        return None
    return extension


def save_product_image(product_id: int, extension: str, contents: bytes) -> Path:
    PRODUCT_IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    destination = PRODUCT_IMAGE_DIR / f"{product_id}{extension}"
    temporary = PRODUCT_IMAGE_DIR / f".{product_id}.{uuid4().hex}.tmp"
    try:
        temporary.write_bytes(contents)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    for candidate_extension in (".jpg", ".png", ".webp"):
        if candidate_extension != extension:
            (PRODUCT_IMAGE_DIR / f"{product_id}{candidate_extension}").unlink(missing_ok=True)
    return destination


def delete_product_image(product_id: int) -> None:
    for extension in (".jpg", ".png", ".webp"):
        (PRODUCT_IMAGE_DIR / f"{product_id}{extension}").unlink(missing_ok=True)
