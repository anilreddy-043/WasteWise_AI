"""Train a next-day food-waste model using only the preceding day's inputs."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.pipeline import Pipeline

from ml.src._training import (
    chronological_split,
    date_features,
    load_csv,
    make_preprocessor,
    regression_metrics,
    save_model,
)

REQUIRED_COLUMNS = {
    "product_id",
    "date",
    "category",
    "opening_stock",
    "units_received",
    "units_sold",
    "unit_price",
    "discount_pct",
    "days_to_expiry",
    "temperature_c",
    "waste_units",
    "stockout_flag",
}
OBSERVED_FEATURES = [
    "opening_stock",
    "units_received",
    "units_sold",
    "unit_price",
    "discount_pct",
    "days_to_expiry",
    "temperature_c",
    "stockout_flag",
]
WASTE_FEATURE_COLUMNS = [
    "previous_product_id",
    "previous_category",
    *[f"previous_{column}" for column in OBSERVED_FEATURES],
    "target_calendar_month",
    "target_calendar_day_of_week",
    "target_calendar_day_of_month",
    "target_calendar_day_of_year",
]


def build_training_data(source: pd.DataFrame) -> pd.DataFrame:
    data = source.copy()
    data["date"] = pd.to_datetime(data["date"], errors="raise")
    data = data.sort_values(["product_id", "date"]).reset_index(drop=True)
    grouped = data.groupby("product_id", sort=False)
    data["target_date"] = grouped["date"].shift(-1)
    data["target_waste_units"] = grouped["waste_units"].shift(-1)
    for column in OBSERVED_FEATURES:
        data[f"previous_{column}"] = data[column]
    data["previous_category"] = data["category"]
    data["previous_product_id"] = data["product_id"].astype(str)
    data = data.loc[(data["target_date"] - data["date"]).dt.days.eq(1)].copy()
    data = pd.concat(
        [data, date_features(data["target_date"], prefix="target_calendar_")],
        axis=1,
    )
    return data


def train_model(
    data_path: Path | str | None = None,
    artifact_dir: Path | str | None = None,
) -> tuple[Any, dict[str, Any]]:
    data = (
        load_csv("perishable_inventory.csv", REQUIRED_COLUMNS)
        if data_path is None
        else pd.read_csv(data_path)
    )
    missing = REQUIRED_COLUMNS.difference(data.columns)
    if missing:
        raise ValueError(f"Waste data is missing: {sorted(missing)}")
    data = build_training_data(data)
    feature_columns = WASTE_FEATURE_COLUMNS
    train, test = chronological_split(data, "target_date")
    model = Pipeline(
        steps=[
            ("preprocessor", make_preprocessor(data[feature_columns])),
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
    model.fit(train[feature_columns], train["target_waste_units"])
    prediction = model.predict(test[feature_columns])
    baseline_prediction = train["target_waste_units"].mean()
    metrics = {
        "model": "food_waste",
        "task": "next-day target_waste_units regression",
        "prediction_horizon": "one day",
        "input_timing": "all observed features are from the preceding date; calendar features describe the target date",
        "split": "chronological by target_date; earliest 80% of dates train, latest 20% test",
        "train_rows": int(len(train)),
        "test_rows": int(len(test)),
        "train_target_end": train["target_date"].max().date().isoformat(),
        "test_target_start": test["target_date"].min().date().isoformat(),
        "features": feature_columns,
        "excluded_target_columns": ["waste_units", "target_waste_units"],
        "test_positive_waste_rate": float(
            test["target_waste_units"].gt(0).mean()
        ),
        "test": regression_metrics(test["target_waste_units"], prediction),
        "training_mean_baseline": regression_metrics(
            test["target_waste_units"],
            pd.Series(baseline_prediction, index=test.index).to_numpy(),
        ),
        "zero_waste_baseline": regression_metrics(
            test["target_waste_units"],
            pd.Series(0.0, index=test.index).to_numpy(),
        ),
    }
    save_model(model, "food_waste", metrics, artifact_dir)
    return model, metrics


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, help="Optional path to perishable inventory CSV")
    parser.add_argument("--artifacts", type=Path, help="Optional artifact output directory")
    args = parser.parse_args()
    _, metrics = train_model(args.data, args.artifacts)
    print(pd.Series(metrics["test"]).to_string())


if __name__ == "__main__":
    main()
