from __future__ import annotations

from pathlib import Path
from uuid import uuid4

from app.core.config import BACKEND_DIR

STORE_LOGO_DIR = BACKEND_DIR / "uploads" / "store"
ALLOWED_STORE_LOGO_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}
MAX_STORE_LOGO_BYTES = 2 * 1024 * 1024


def store_logo_path_for_store(store_id: int) -> Path | None:
    for extension in (".jpg", ".png", ".webp"):
        path = STORE_LOGO_DIR / f"{store_id}{extension}"
        if path.is_file():
            return path
    return None


def store_logo_url_for_store(store_id: int) -> str | None:
    path = store_logo_path_for_store(store_id)
    if path is None:
        return None
    return f"/api/v1/settings/store/logo?v={path.stat().st_mtime_ns}"


def validate_store_logo(content_type: str, contents: bytes) -> str | None:
    allowed = ALLOWED_STORE_LOGO_TYPES.get(content_type)
    if allowed is None or not contents:
        return None
    if content_type == "image/jpeg":
        if not contents.startswith(b"\xff\xd8\xff"):
            return None
        return ".jpg"
    if content_type == "image/png":
        if not contents.startswith(b"\x89PNG\r\n\x1a\n"):
            return None
        return ".png"
    if content_type == "image/webp":
        if len(contents) < 12 or contents[:4] != b"RIFF" or contents[8:12] != b"WEBP":
            return None
        return ".webp"
    return None


def save_store_logo(store_id: int, extension: str, contents: bytes) -> Path:
    STORE_LOGO_DIR.mkdir(parents=True, exist_ok=True)
    destination = STORE_LOGO_DIR / f"{store_id}{extension}"
    temporary = STORE_LOGO_DIR / f".{store_id}.{uuid4().hex}.tmp"
    try:
        temporary.write_bytes(contents)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    for candidate in (".jpg", ".png", ".webp"):
        if candidate != extension:
            (STORE_LOGO_DIR / f"{store_id}{candidate}").unlink(missing_ok=True)
    return destination


def delete_store_logo(store_id: int) -> None:
    for extension in (".jpg", ".png", ".webp"):
        (STORE_LOGO_DIR / f"{store_id}{extension}").unlink(missing_ok=True)
