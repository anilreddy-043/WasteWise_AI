from __future__ import annotations

from pathlib import Path
from uuid import uuid4

from app.core.config import BACKEND_DIR

PROFILE_IMAGE_DIR = BACKEND_DIR / "uploads" / "profiles"
PROFILE_IMAGE_EXTENSIONS = (".jpg", ".png", ".webp")


def profile_image_path(user_id: int) -> Path | None:
    for extension in PROFILE_IMAGE_EXTENSIONS:
        path = PROFILE_IMAGE_DIR / f"{user_id}{extension}"
        if path.is_file():
            return path
    return None


def profile_image_url(user_id: int) -> str | None:
    path = profile_image_path(user_id)
    if path is None:
        return None
    return f"/api/v1/profile/image?v={path.stat().st_mtime_ns}"


def save_profile_image(user_id: int, extension: str, contents: bytes) -> Path:
    if extension not in PROFILE_IMAGE_EXTENSIONS:
        raise ValueError("Unsupported profile image extension.")

    PROFILE_IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    destination = PROFILE_IMAGE_DIR / f"{user_id}{extension}"
    temporary = PROFILE_IMAGE_DIR / f".{user_id}.{uuid4().hex}.tmp"
    try:
        temporary.write_bytes(contents)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)

    for candidate_extension in PROFILE_IMAGE_EXTENSIONS:
        if candidate_extension != extension:
            (PROFILE_IMAGE_DIR / f"{user_id}{candidate_extension}").unlink(missing_ok=True)
    return destination


def delete_profile_image(user_id: int) -> None:
    for extension in PROFILE_IMAGE_EXTENSIONS:
        (PROFILE_IMAGE_DIR / f"{user_id}{extension}").unlink(missing_ok=True)
