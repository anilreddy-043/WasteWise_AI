"""Shared utilities for the standalone ML training jobs."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder

PROJECT_ROOT = Path(__file__).resolve().parents[2]
RAW_DATA_DIR = PROJECT_ROOT / "ml" / "data" / "raw"
DEFAULT_ARTIFACT_DIR = PROJECT_ROOT / "ml" / "artifacts"


def load_csv(filename: str, required_columns: set[str]) -> pd.DataFrame:
    path = RAW_DATA_DIR / filename
    if not path.is_file():
        raise FileNotFoundError(f"Required training data not found: {path}")
    frame = pd.read_csv(path)
    missing = required_columns.difference(frame.columns)
    if missing:
        raise ValueError(f"{filename} is missing required columns: {sorted(missing)}")
    if frame.empty:
        raise ValueError(f"Training data is empty: {path}")
    return frame


def make_preprocessor(features: pd.DataFrame) -> ColumnTransformer:
    categorical = features.select_dtypes(include=["object", "category"]).columns.tolist()
    numeric = features.columns.difference(categorical).tolist()

    numeric_pipeline = Pipeline(
        steps=[("imputer", SimpleImputer(strategy="median"))]
    )
    categorical_pipeline = Pipeline(
        steps=[
            ("imputer", SimpleImputer(strategy="most_frequent")),
            ("onehot", OneHotEncoder(handle_unknown="ignore")),
        ]
    )
    return ColumnTransformer(
        transformers=[
            ("numeric", numeric_pipeline, numeric),
            ("categorical", categorical_pipeline, categorical),
        ],
        remainder="drop",
    )


def chronological_split(
    frame: pd.DataFrame, date_column: str, train_fraction: float = 0.8
) -> tuple[pd.DataFrame, pd.DataFrame]:
    dates = np.sort(frame[date_column].dropna().unique())
    if len(dates) < 2:
        raise ValueError(f"At least two distinct dates are required in {date_column}")
    split_index = min(max(int(len(dates) * train_fraction), 1), len(dates) - 1)
    cutoff = dates[split_index]
    train = frame.loc[frame[date_column] < cutoff].copy()
    test = frame.loc[frame[date_column] >= cutoff].copy()
    if train.empty or test.empty:
        raise ValueError(f"Chronological split produced an empty partition for {date_column}")
    return train, test


def regression_metrics(actual: pd.Series, predicted: np.ndarray) -> dict[str, float]:
    from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

    return {
        "mae": float(mean_absolute_error(actual, predicted)),
        "rmse": float(np.sqrt(mean_squared_error(actual, predicted))),
        "r2": float(r2_score(actual, predicted)),
    }


def save_model(
    model: Any,
    model_name: str,
    metrics: dict[str, Any],
    artifact_dir: Path | str | None = None,
) -> Path:
    if artifact_dir is None:
        from ml.src.model_registry import publish_candidate

        metadata = publish_candidate(model, model_name, metrics)
        return DEFAULT_ARTIFACT_DIR / metadata["model_path"]

    import joblib

    destination = Path(artifact_dir)
    destination.mkdir(parents=True, exist_ok=True)
    model_path = destination / f"{model_name}.joblib"
    joblib.dump(model, model_path)
    metrics_path = destination / f"{model_name}_metrics.json"
    metrics_path.write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    return model_path


def date_features(dates: pd.Series, prefix: str = "") -> pd.DataFrame:
    parsed = pd.to_datetime(dates, errors="raise")
    return pd.DataFrame(
        {
            f"{prefix}month": parsed.dt.month.to_numpy(),
            f"{prefix}day_of_week": parsed.dt.day_of_week.to_numpy(),
            f"{prefix}day_of_month": parsed.dt.day.to_numpy(),
            f"{prefix}day_of_year": parsed.dt.day_of_year.to_numpy(),
        },
        index=dates.index,
    )
