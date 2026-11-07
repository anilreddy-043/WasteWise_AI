"""Train a prototype discount-response model on simulated scenarios."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import GroupShuffleSplit
from sklearn.pipeline import Pipeline

from ml.src._training import (
    load_csv,
    make_preprocessor,
    regression_metrics,
    save_model,
)

REQUIRED_COLUMNS = {
    "batch_id",
    "product_id",
    "days_to_expiry",
    "quantity_remaining",
    "discount_pct",
    "estimated_gross_margin_simulated",
}
FEATURE_COLUMNS = [
    "product_id",
    "days_to_expiry",
    "quantity_remaining",
    "discount_pct",
]
TARGET = "estimated_gross_margin_simulated"


def train_model(
    data_path: Path | str | None = None,
    artifact_dir: Path | str | None = None,
) -> tuple[Any, dict[str, Any]]:
    data = (
        load_csv("discount_scenarios_simulated.csv", REQUIRED_COLUMNS)
        if data_path is None
        else pd.read_csv(data_path)
    )
    missing = REQUIRED_COLUMNS.difference(data.columns)
    if missing:
        raise ValueError(f"Discount data is missing: {sorted(missing)}")
    data = data.copy()
    data["product_id"] = data["product_id"].astype(str)
    split = GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=42)
    train_indices, test_indices = next(
        split.split(data[FEATURE_COLUMNS], data[TARGET], groups=data["batch_id"])
    )
    train = data.iloc[train_indices]
    test = data.iloc[test_indices]
    model = Pipeline(
        steps=[
            ("preprocessor", make_preprocessor(train[FEATURE_COLUMNS])),
            (
                "regressor",
                RandomForestRegressor(
                    n_estimators=250,
                    min_samples_leaf=2,
                    max_features=0.9,
                    random_state=42,
                    n_jobs=1,
                ),
            ),
        ]
    )
    model.fit(train[FEATURE_COLUMNS], train[TARGET])
    prediction = model.predict(test[FEATURE_COLUMNS])
    metrics = {
        "model": "discount_recommendation",
        "task": "simulated gross-margin regression for discount scenarios",
        "data_caveat": "Training outcomes are simulated and are not evidence of real customer price response.",
        "split": "80/20 grouped by batch_id so scenarios from one batch cannot cross partitions",
        "train_rows": int(len(train)),
        "test_rows": int(len(test)),
        "train_batches": int(train["batch_id"].nunique()),
        "test_batches": int(test["batch_id"].nunique()),
        "features": FEATURE_COLUMNS,
        "target": TARGET,
        "test": regression_metrics(test[TARGET], prediction),
        "training_mean_baseline": regression_metrics(
            test[TARGET],
            pd.Series(train[TARGET].mean(), index=test.index).to_numpy(),
        ),
    }
    save_model(model, "discount_recommendation", metrics, artifact_dir)
    return model, metrics


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, help="Optional path to simulated scenario CSV")
    parser.add_argument("--artifacts", type=Path, help="Optional artifact output directory")
    args = parser.parse_args()
    _, metrics = train_model(args.data, args.artifacts)
    print(pd.Series(metrics["test"]).to_string())


if __name__ == "__main__":
    main()