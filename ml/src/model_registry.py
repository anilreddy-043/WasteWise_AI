"""Versioned model publication with benchmark gates and reversible promotion."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import joblib

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_ARTIFACT_DIR = PROJECT_ROOT / "ml" / "artifacts"
REGISTRY_FILE = "active_models.json"


def _read_registry(artifact_dir: Path) -> dict[str, dict[str, Any]]:
    path = artifact_dir / REGISTRY_FILE
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as source:
        value = json.load(source)
    if not isinstance(value, dict):
        raise ValueError(f"Invalid model registry: {path}")
    return value


def _write_json_atomically(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            json.dump(value, temporary, indent=2, sort_keys=True)
            temporary.write("\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()


def _candidate_beats_reference(model_name: str, metrics: dict[str, Any]) -> bool:
    test_metrics = metrics.get("test")
    if not isinstance(test_metrics, dict):
        return False

    sample_size = int(metrics.get("test_rows", 0))
    if model_name == "demand_forecast":
        baseline = metrics.get("seven_day_mean_baseline")
        return (
            sample_size >= 30
            and isinstance(baseline, dict)
            and test_metrics.get("mae", float("inf")) < baseline.get("mae", float("-inf"))
            and test_metrics.get("rmse", float("inf")) < baseline.get("rmse", float("-inf"))
        )
    if model_name == "food_waste":
        baseline = metrics.get("zero_waste_baseline")
        return (
            sample_size >= 30
            and isinstance(baseline, dict)
            and test_metrics.get("mae", float("inf")) < baseline.get("mae", float("-inf"))
            and test_metrics.get("rmse", float("inf")) < baseline.get("rmse", float("-inf"))
        )
    if model_name == "discount_recommendation":
        baseline = metrics.get("training_mean_baseline")
        return (
            sample_size >= 30
            and isinstance(baseline, dict)
            and test_metrics.get("mae", float("inf")) < baseline.get("mae", float("-inf"))
            and test_metrics.get("rmse", float("inf")) < baseline.get("rmse", float("-inf"))
        )
    if model_name == "expiry_risk":
        return (
            sample_size >= 30
            and test_metrics.get("balanced_accuracy", 0) > 0.5
            and test_metrics.get("roc_auc", 0) > 0.5
        )
    return False


def _candidate_beats_incumbent(model_name: str, candidate: dict[str, Any], incumbent: dict[str, Any]) -> bool:
    candidate_test = candidate.get("test")
    incumbent_test = incumbent.get("test")
    if not isinstance(candidate_test, dict) or not isinstance(incumbent_test, dict):
        return False
    if model_name == "expiry_risk":
        candidate_balanced = candidate_test.get("balanced_accuracy", 0)
        candidate_auc = candidate_test.get("roc_auc", 0)
        incumbent_balanced = incumbent_test.get("balanced_accuracy", float("inf"))
        incumbent_auc = incumbent_test.get("roc_auc", float("inf"))
        return (
            candidate_balanced >= incumbent_balanced
            and candidate_auc >= incumbent_auc
            and (candidate_balanced > incumbent_balanced or candidate_auc > incumbent_auc)
        )
    candidate_mae = candidate_test.get("mae", float("inf"))
    candidate_rmse = candidate_test.get("rmse", float("inf"))
    incumbent_mae = incumbent_test.get("mae", float("-inf"))
    incumbent_rmse = incumbent_test.get("rmse", float("-inf"))
    return candidate_mae < incumbent_mae and candidate_rmse < incumbent_rmse


def publish_candidate(
    model: Any,
    model_name: str,
    metrics: dict[str, Any],
    artifact_dir: Path | str | None = None,
    dataset_fingerprint: str | None = None,
) -> dict[str, Any]:
    """Keep every evaluated candidate and atomically promote only benchmark winners."""
    root = Path(artifact_dir) if artifact_dir is not None else DEFAULT_ARTIFACT_DIR
    version_dir = root / "versions" / model_name
    version_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.NamedTemporaryFile(
        dir=version_dir,
        prefix=f".{model_name}.",
        suffix=".joblib.tmp",
        delete=False,
    ) as temporary:
        temporary_model_path = Path(temporary.name)
    try:
        joblib.dump(model, temporary_model_path)
        digest = hashlib.sha256(temporary_model_path.read_bytes()).hexdigest()
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        version = f"{timestamp}-{digest[:8]}"
        version_path = version_dir / version
        version_path.mkdir()
        model_path = version_path / "model.joblib"
        os.replace(temporary_model_path, model_path)

        promotable = _candidate_beats_reference(model_name, metrics)
        registry = _read_registry(root)
        previous = registry.get(model_name)
        incumbent_metrics = previous.get("metrics") if previous else None
        if incumbent_metrics is None:
            baseline_path = root / f"{model_name}_metrics.json"
            if baseline_path.is_file():
                with baseline_path.open(encoding="utf-8") as source:
                    incumbent_metrics = json.load(source)
        if incumbent_metrics is not None:
            promotable = promotable and _candidate_beats_incumbent(
                model_name, metrics, incumbent_metrics
            )
        candidate_metadata = {
            "model_name": model_name,
            "model_version": version,
            "model_path": model_path.relative_to(root).as_posix(),
            "model_sha256": digest,
            "dataset_fingerprint": dataset_fingerprint,
            "evaluated_at": datetime.now(timezone.utc).isoformat(),
            "promotion_status": "promoted" if promotable else "evaluated_not_promoted",
            "metrics": metrics,
        }
        _write_json_atomically(version_path / "metrics.json", candidate_metadata)

        if promotable:
            history = list(previous.get("previous_versions", [])) if previous else []
            if previous:
                history.insert(0, previous["model_version"])
            registry[model_name] = {
                **candidate_metadata,
                "previous_versions": history[:20],
            }
            _write_json_atomically(root / REGISTRY_FILE, registry)

        return candidate_metadata
    finally:
        if temporary_model_path.exists():
            temporary_model_path.unlink()


def get_active_model_path(
    model_name: str,
    artifact_dir: Path | str | None = None,
) -> Path | None:
    root = Path(artifact_dir) if artifact_dir is not None else DEFAULT_ARTIFACT_DIR
    metadata = _read_registry(root).get(model_name)
    if metadata is None:
        return None
    model_path = root / metadata["model_path"]
    if not model_path.is_file():
        raise FileNotFoundError(f"Active model artifact is missing: {model_path}")
    return model_path


def rollback_model(
    model_name: str,
    version: str | None = None,
    artifact_dir: Path | str | None = None,
) -> dict[str, Any]:
    root = Path(artifact_dir) if artifact_dir is not None else DEFAULT_ARTIFACT_DIR
    registry = _read_registry(root)
    current = registry.get(model_name)
    if current is None:
        raise ValueError(f"No promoted model exists for {model_name!r}.")

    history = list(current.get("previous_versions", []))
    target_version = version or (history[0] if history else None)
    if target_version is None:
        raise ValueError(f"No previous version is available for {model_name!r}.")
    metadata_path = root / "versions" / model_name / target_version / "metrics.json"
    if not metadata_path.is_file():
        raise ValueError(f"Model version {target_version!r} is not available for {model_name!r}.")
    with metadata_path.open(encoding="utf-8") as source:
        target = json.load(source)
    target_model = root / target["model_path"]
    if not target_model.is_file():
        raise FileNotFoundError(f"Rollback model artifact is missing: {target_model}")

    next_history = [current["model_version"], *(v for v in history if v != target_version)]
    registry[model_name] = {**target, "previous_versions": next_history[:20]}
    _write_json_atomically(root / REGISTRY_FILE, registry)
    return registry[model_name]
