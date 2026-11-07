"""Train an expiry-risk classifier without target or post-outcome leakage."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import (
    accuracy_score,
    balanced_accuracy_score,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.pipeline import Pipeline

from ml.src._training import (
    chronological_split,
    load_csv,
    make_preprocessor,
    save_model,
)

REQUIRED_COLUMNS = {
    "product_id",
    "category",
    "snapshot_date",
    "received_at",
    "expiry_date",
    "initial_quantity",
    "quantity_remaining",
    "days_to_expiry",
    "avg_daily_sales_7d",
    "expected_demand_before_expiry",
    "unit_price",
    "unit_cost",
    "discount_pct",
    "expiry_risk_label",
}


def train_model(
    data_path: Path | str | None = None,
    artifact_dir: Path | str | None = None,
) -> tuple[Any, dict[str, Any]]:
    data = (
        load_csv("inventory_batches.csv", REQUIRED_COLUMNS)
        if data_path is None
        else pd.read_csv(data_path)
    )
    missing = REQUIRED_COLUMNS.difference(data.columns)
    if missing:
        raise ValueError(f"Expiry data is missing: {sorted(missing)}")
    data = data.copy()
    data["snapshot_date"] = pd.to_datetime(data["snapshot_date"], errors="raise")
    data["received_at"] = pd.to_datetime(data["received_at"], errors="raise")
    data["expiry_date"] = pd.to_datetime(data["expiry_date"], errors="raise")
    data["received_age_days"] = (data["snapshot_date"] - data["received_at"]).dt.days
    data["calendar_month"] = data["snapshot_date"].dt.month
    data["calendar_day_of_week"] = data["snapshot_date"].dt.day_of_week
    data["shelf_life_days"] = (data["expiry_date"] - data["received_at"]).dt.days

    target = "expiry_risk_label"
    excluded = {
        target,
        "batch_id",
        "waste_units_actual_simulated",
        "snapshot_date",
        "received_at",
        "expiry_date",
    }
    feature_columns = [column for column in data.columns if column not in excluded]
    train, test = chronological_split(data, "snapshot_date")
    model = Pipeline(
        steps=[
            ("preprocessor", make_preprocessor(data[feature_columns])),
            (
                "classifier",
                RandomForestClassifier(
                    n_estimators=250,
                    min_samples_leaf=2,
                    class_weight="balanced_subsample",
                    random_state=42,
                    n_jobs=1,
                ),
            ),
        ]
    )
    model.fit(train[feature_columns], train[target].astype(int))
    prediction = model.predict(test[feature_columns])
    probabilities = model.predict_proba(test[feature_columns])[:, 1]
    metrics = {
        "model": "expiry_risk",
        "task": "expiry_risk_label binary classification",
        "split": "chronological by snapshot_date; earliest 80% of dates train, latest 20% test",
        "train_rows": int(len(train)),
        "test_rows": int(len(test)),
        "train_end": train["snapshot_date"].max().date().isoformat(),
        "test_start": test["snapshot_date"].min().date().isoformat(),
        "features": feature_columns,
        "excluded_columns": sorted(excluded.intersection(data.columns)),
        "test": {
            "accuracy": float(accuracy_score(test[target], prediction)),
            "balanced_accuracy": float(balanced_accuracy_score(test[target], prediction)),
            "precision": float(precision_score(test[target], prediction, zero_division=0)),
            "recall": float(recall_score(test[target], prediction, zero_division=0)),
            "f1": float(f1_score(test[target], prediction, zero_division=0)),
            "roc_auc": float(roc_auc_score(test[target], probabilities)),
        },
    }
    save_model(model, "expiry_risk", metrics, artifact_dir)
    return model, metrics


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, help="Optional path to inventory batches CSV")
    parser.add_argument("--artifacts", type=Path, help="Optional artifact output directory")
    args = parser.parse_args()
    _, metrics = train_model(args.data, args.artifacts)
    print(pd.Series(metrics["test"]).to_string())


if __name__ == "__main__":
    main()