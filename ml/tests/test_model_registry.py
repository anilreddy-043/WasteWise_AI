import tempfile
import unittest
from pathlib import Path

from ml.src.model_registry import get_active_model_path, publish_candidate, rollback_model


def passing_demand_metrics(mae: float) -> dict[str, object]:
    return {
        "model": "demand_forecast",
        "test_rows": 100,
        "test": {"mae": mae, "rmse": mae + 1, "r2": 0.7},
        "seven_day_mean_baseline": {"mae": 5.0, "rmse": 6.0},
    }


class ModelRegistryTests(unittest.TestCase):
    def test_candidate_promotion_is_benchmark_gated_and_rollbackable(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = publish_candidate(
                {"candidate": 1},
                "demand_forecast",
                passing_demand_metrics(3.0),
                root,
                dataset_fingerprint="dataset-1",
            )
            self.assertEqual(first["promotion_status"], "promoted")
            first_path = get_active_model_path("demand_forecast", root)
            self.assertIsNotNone(first_path)
            self.assertTrue(first_path.is_file())

            rejected = publish_candidate(
                {"candidate": 2},
                "demand_forecast",
                passing_demand_metrics(6.0),
                root,
                dataset_fingerprint="dataset-2",
            )
            self.assertEqual(rejected["promotion_status"], "evaluated_not_promoted")
            self.assertEqual(get_active_model_path("demand_forecast", root), first_path)

            second = publish_candidate(
                {"candidate": 3},
                "demand_forecast",
                passing_demand_metrics(2.0),
                root,
                dataset_fingerprint="dataset-3",
            )
            self.assertEqual(second["promotion_status"], "promoted")
            active_before_rollback = get_active_model_path("demand_forecast", root)
            self.assertNotEqual(active_before_rollback, first_path)

            rolled_back = rollback_model("demand_forecast", artifact_dir=root)
            self.assertEqual(rolled_back["model_version"], first["model_version"])
            self.assertEqual(get_active_model_path("demand_forecast", root), first_path)

    def test_existing_model_is_not_replaced_by_a_weaker_evaluated_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "demand_forecast_metrics.json").write_text(
                '{"test_rows": 100, "test": {"mae": 2.0, "rmse": 3.0}}',
                encoding="utf-8",
            )
            result = publish_candidate(
                {"candidate": 1},
                "demand_forecast",
                passing_demand_metrics(3.0),
                root,
            )
            self.assertEqual(result["promotion_status"], "evaluated_not_promoted")
            self.assertIsNone(get_active_model_path("demand_forecast", root))


if __name__ == "__main__":
    unittest.main()
