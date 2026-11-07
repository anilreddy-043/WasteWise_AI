"""Train all four models and write individual plus combined metrics."""

from __future__ import annotations

import json
import hashlib
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from ml.src._training import DEFAULT_ARTIFACT_DIR, RAW_DATA_DIR
from ml.src.model_registry import publish_candidate
from ml.src.train_discount_model import train_model as train_discount_model
from ml.src.train_expiry_risk import train_model as train_expiry_risk
from ml.src.train_food_waste import train_model as train_food_waste
from ml.src.train_forecast import train_model as train_demand_forecast


TRAINING_DATASETS = (
    "products.csv",
    "perishable_inventory.csv",
    "inventory_batches.csv",
    "discount_scenarios_simulated.csv",
)


def dataset_fingerprint(data_dir: Path | str = RAW_DATA_DIR) -> str:
    digest = hashlib.sha256()
    root = Path(data_dir)
    for filename in TRAINING_DATASETS:
        path = root / filename
        if not path.is_file():
            raise FileNotFoundError(f"Required training data not found: {path}")
        digest.update(filename.encode("utf-8"))
        digest.update(path.read_bytes())
    return digest.hexdigest()


def train_all(
    artifact_dir: Path | str | None = None,
    data_dir: Path | str = RAW_DATA_DIR,
    progress_callback: Callable[[str, int, int], None] | None = None,
    model_names: tuple[str, ...] | None = None,
) -> dict[str, dict[str, Any]]:
    destination = Path(artifact_dir) if artifact_dir is not None else DEFAULT_ARTIFACT_DIR
    fingerprint = dataset_fingerprint(data_dir)
    results = {}
    available_trainers = {
        "demand_forecast": (train_demand_forecast, "perishable_inventory.csv"),
        "expiry_risk": (train_expiry_risk, "inventory_batches.csv"),
        "food_waste": (train_food_waste, "perishable_inventory.csv"),
        "discount_recommendation": (train_discount_model, "discount_scenarios_simulated.csv"),
    }
    selected_names = model_names or tuple(available_trainers)
    unknown_names = set(selected_names).difference(available_trainers)
    if unknown_names:
        raise ValueError(f"Unknown model names requested for training: {sorted(unknown_names)}")
    trainers = tuple(available_trainers[name] for name in selected_names)
    for completed, (trainer, dataset) in enumerate(trainers, start=1):
        with tempfile.TemporaryDirectory(prefix="wastewise-candidate-") as staging:
            model, metrics = trainer(
                data_path=Path(data_dir) / dataset,
                artifact_dir=staging,
            )
            metrics["algorithm"] = type(model.steps[-1][1]).__name__
            metrics["training_timestamp"] = datetime.now(timezone.utc).isoformat()
            publication = publish_candidate(
                model,
                metrics["model"],
                metrics,
                artifact_dir=destination,
                dataset_fingerprint=fingerprint,
            )
            results[metrics["model"]] = {
                **metrics,
                "model_version": publication["model_version"],
                "promotion_status": publication["promotion_status"],
                "evaluated_at": publication["evaluated_at"],
            }
        if progress_callback is not None:
            progress_callback(metrics["model"], completed, len(trainers))
    run_dir = destination / "training_runs"
    run_dir.mkdir(parents=True, exist_ok=True)
    run_path = run_dir / f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')}_metrics.json"
    run_path.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    return results


def maybe_train_all(
    artifact_dir: Path | str | None = None,
    data_dir: Path | str = RAW_DATA_DIR,
) -> dict[str, dict[str, Any]] | None:
    destination = Path(artifact_dir) if artifact_dir is not None else DEFAULT_ARTIFACT_DIR
    fingerprint = dataset_fingerprint(data_dir)
    state_path = destination / "training_state.json"
    if state_path.is_file():
        with state_path.open(encoding="utf-8") as source:
            if json.load(source).get("dataset_fingerprint") == fingerprint:
                return None
    results = train_all(destination, data_dir)
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_value = {
        "dataset_fingerprint": fingerprint,
        "evaluated_at": datetime.now(timezone.utc).isoformat(),
    }
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=state_path.parent,
        prefix=".training_state.",
        suffix=".tmp",
        delete=False,
    ) as temporary:
        temporary_path = Path(temporary.name)
        json.dump(state_value, temporary, indent=2)
        temporary.write("\n")
        temporary.flush()
        os.fsync(temporary.fileno())
    os.replace(temporary_path, state_path)
    return results


def main() -> None:
    for name, metrics in train_all().items():
        print(f"{name}: {metrics['test']}")


if __name__ == "__main__":
    main()
