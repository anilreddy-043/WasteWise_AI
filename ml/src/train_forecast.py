"""Train a rolling one-day-ahead demand model from historical sales."""

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
}


def build_training_data(source: pd.DataFrame) -> pd.DataFrame:
    data = source.copy()
    data["date"] = pd.to_datetime(data["date"], errors="raise")
    data = data.sort_values(["product_id", "date"]).reset_index(drop=True)
    grouped_sales = data.groupby("product_id", sort=False)["units_sold"]
    data["sales_lag_1"] = grouped_sales.shift(1)
    data["sales_lag_7"] = grouped_sales.shift(7)
    data["sales_mean_previous_7d"] = grouped_sales.transform(
        lambda sales: sales.shift(1).rolling(7, min_periods=7).mean()
    )
    data = pd.concat([data, date_features(data["date"], prefix="calendar_")], axis=1)
    return data.dropna(subset=["sales_lag_1", "sales_lag_7", "sales_mean_previous_7d"])


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
        raise ValueError(f"Demand data is missing: {sorted(missing)}")
    data = build_training_data(data)
    excluded = {"date", "units_sold", "temperature_c", "stockout_flag", "waste_units"}
    feature_columns = [column for column in data.columns if column not in excluded]
    train, test = chronological_split(data, "date")
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
    model.fit(train[feature_columns], train["units_sold"])
    prediction = model.predict(test[feature_columns])
    metrics = {
        "model": "demand_forecast",
        "task": "rolling one-day-ahead units_sold regression",
        "split": "chronological by date; earliest 80% of dates train, latest 20% test",
        "train_rows": int(len(train)),
        "test_rows": int(len(test)),
        "train_end": train["date"].max().date().isoformat(),
        "test_start": test["date"].min().date().isoformat(),
        "features": feature_columns,
        "test": regression_metrics(test["units_sold"], prediction),
        "seven_day_mean_baseline": regression_metrics(
            test["units_sold"], test["sales_mean_previous_7d"].to_numpy()
        ),
    }
    save_model(model, "demand_forecast", metrics, artifact_dir)
    return model, metrics


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, help="Optional path to perishable sales CSV")
    parser.add_argument("--artifacts", type=Path, help="Optional artifact output directory")
    args = parser.parse_args()
    _, metrics = train_model(args.data, args.artifacts)
    print(pd.Series(metrics["test"]).to_string())


if __name__ == "__main__":
    main()