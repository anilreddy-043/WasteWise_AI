import unittest

import pandas as pd

from ml.src._training import chronological_split
from ml.src.train_food_waste import WASTE_FEATURE_COLUMNS, build_training_data
from ml.src.train_forecast import build_training_data as build_demand_training_data


class TrainingFeatureTests(unittest.TestCase):
    def test_demand_lags_only_use_sales_before_prediction_date(self):
        dates = pd.date_range("2026-01-01", periods=9)
        source = pd.DataFrame(
            {
                "product_id": [1001] * len(dates),
                "date": dates,
                "category": ["Dairy"] * len(dates),
                "opening_stock": [20] * len(dates),
                "units_received": [0] * len(dates),
                "units_sold": range(1, len(dates) + 1),
                "unit_price": [10.0] * len(dates),
                "discount_pct": [0.0] * len(dates),
                "days_to_expiry": [3] * len(dates),
            }
        )

        training = build_demand_training_data(source)
        first = training.iloc[0]
        self.assertEqual(first["date"], dates[7])
        self.assertEqual(first["sales_lag_1"], 7)
        self.assertEqual(first["sales_lag_7"], 1)
        self.assertEqual(first["sales_mean_previous_7d"], 4)

    def test_waste_target_is_next_day_and_not_an_input_feature(self):
        dates = pd.date_range("2026-04-01", periods=3)
        source = pd.DataFrame(
            {
                "product_id": [1001] * 3,
                "date": dates,
                "category": ["Dairy"] * 3,
                "opening_stock": [20, 19, 18],
                "units_received": [0, 0, 0],
                "units_sold": [1, 2, 3],
                "unit_price": [10.0] * 3,
                "discount_pct": [0.0] * 3,
                "days_to_expiry": [3, 2, 1],
                "temperature_c": [4.0] * 3,
                "waste_units": [2, 4, 6],
                "stockout_flag": [0] * 3,
            }
        )

        training = build_training_data(source)
        first = training.iloc[0]
        self.assertEqual(first["target_date"], dates[1])
        self.assertEqual(first["target_waste_units"], 4)
        self.assertNotIn("waste_units", WASTE_FEATURE_COLUMNS)
        self.assertNotIn("target_waste_units", WASTE_FEATURE_COLUMNS)

    def test_chronological_split_keeps_later_dates_in_test(self):
        dates = pd.date_range("2026-01-01", periods=10)
        frame = pd.DataFrame({"date": dates, "value": range(10)})

        train, test = chronological_split(frame, "date")
        self.assertLess(train["date"].max(), test["date"].min())
        self.assertEqual(len(train) + len(test), len(frame))


if __name__ == "__main__":
    unittest.main()
