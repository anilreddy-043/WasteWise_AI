from __future__ import annotations

import hashlib
import json
import threading
from functools import lru_cache
from pathlib import Path
from typing import Any

import joblib

from app.core.config import BACKEND_DIR

PROJECT_ROOT = BACKEND_DIR.parent
ARTIFACT_DIR = PROJECT_ROOT / "ml" / "artifacts"
REGISTRY_PATH = ARTIFACT_DIR / "active_models.json"
_MODEL_LOAD_LOCK = threading.RLock()


def artifact_path(model_name: str) -> Path:
    if REGISTRY_PATH.is_file():
        with REGISTRY_PATH.open(encoding="utf-8") as source:
            registry = json.load(source)
        metadata = registry.get(model_name)
        if metadata is not None:
            relative_path = metadata.get("model_path")
            if not isinstance(relative_path, str):
                raise ValueError(f"Invalid active model path for {model_name!r}.")
            candidate = (ARTIFACT_DIR / relative_path).resolve()
            try:
                candidate.relative_to(ARTIFACT_DIR.resolve())
            except ValueError as exc:
                raise ValueError(f"Active model path for {model_name!r} is outside the artifact directory.") from exc
            if not candidate.is_file():
                raise FileNotFoundError(f"Active model artifact is missing: {candidate}")
            return candidate

    candidate = ARTIFACT_DIR / f"{model_name}.joblib"
    if not candidate.is_file():
        raise FileNotFoundError(f"Model artifact not found: {candidate}")
    return candidate


@lru_cache(maxsize=8)
def _load_model_artifact_cached(path: str, modified_ns: int, file_size: int) -> Any:
    stat = Path(path).stat()
    if (stat.st_mtime_ns, stat.st_size) != (modified_ns, file_size):
        return _load_model_artifact_cached(path, stat.st_mtime_ns, stat.st_size)
    return joblib.load(path)


def load_model_artifact(model_name: str) -> Any:
    path = artifact_path(model_name)
    stat = path.stat()
    with _MODEL_LOAD_LOCK:
        return _load_model_artifact_cached(str(path), stat.st_mtime_ns, stat.st_size)


def model_version(model_name: str, fallback: str | None = None) -> str:
    if REGISTRY_PATH.is_file():
        with REGISTRY_PATH.open(encoding="utf-8") as source:
            metadata = json.load(source).get(model_name)
        if metadata is not None:
            version = metadata.get("model_version")
            if isinstance(version, str) and version:
                return version
    if fallback:
        return fallback
    path = artifact_path(model_name)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return f"sha256:{digest[:56]}"
