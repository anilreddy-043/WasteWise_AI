import unittest
from datetime import date, datetime, timedelta
from decimal import Decimal
from io import StringIO
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.core.security import get_current_user
from app.db.base import Base
from app.db.session import get_db
from app.main import app
from app.models import (
    DemandForecast,
    ExpiryRiskPrediction,
    InventoryBatch,
    ModelMetric,
    Product,
    Recommendation,
    SaleRecord,
    User,
)
from app.services.model_metrics_service import create_retraining_job, get_retraining_job, run_retraining_job


class ModelMetricsApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine, expire_on_commit=False)
        self.user = User(
            user_id=1,
            full_name="Metrics Admin",
            email="metrics@example.test",
            password_hash="unused",
            role="admin",
            approval_status="approved",
            is_active=True,
        )
        self.db.add(self.user)
        self.db.commit()
        app.dependency_overrides[get_db] = lambda: self.db
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.client = TestClient(app)

    def tearDown(self) -> None:
        app.dependency_overrides.clear()
        self.db.close()
        Base.metadata.drop_all(self.engine)
        self.engine.dispose()

    def add_prediction_history(self) -> None:
        today = date.today()
        now = datetime.now().replace(microsecond=0)
        product = Product(
            product_id=1,
            name="Metrics Test Product",
            category="Dairy Products",
            sku="MET-001",
            unit="kg",
            price=Decimal("3.50"),
            supplier="Test Supplier",
        )
        batch = InventoryBatch(
            batch_id=1,
            product_id=1,
            batch_code="MET-LOT-1",
            quantity_received=Decimal("10"),
            quantity_remaining=Decimal("8"),
            unit_cost=Decimal("2.00"),
            received_at=today - timedelta(days=4),
            expiry_date=today + timedelta(days=3),
            expiry_date_source="estimated",
            status="active",
            location="Test",
        )
        self.db.add_all([product, batch])
        self.db.flush()
        self.db.add_all([
            DemandForecast(
                forecast_id=1,
                product_id=1,
                forecast_date=today,
                predicted_demand=Decimal("4.000"),
                lower_bound=Decimal("2.000"),
                upper_bound=Decimal("6.000"),
                model_version="test-demand-v1",
                created_at=now,
            ),
            ExpiryRiskPrediction(
                prediction_id=1,
                batch_id=1,
                predicted_class=1,
                risk_probability=Decimal("0.800000"),
                model_version="test-expiry-v1",
                predicted_at=now,
            ),
            Recommendation(
                recommendation_id=1,
                product_id=1,
                batch_id=1,
                recommendation_type="discount",
                recommended_quantity=None,
                discount_percent=Decimal("10.00"),
                reason="Test recommendation",
                status="pending",
                created_at=now,
                updated_at=now,
            ),
            SaleRecord(
                sale_id=1,
                product_id=1,
                batch_id=1,
                sold_at=datetime.combine(today, datetime.min.time()),
                quantity=Decimal("5.000"),
                unit_price=Decimal("3.50"),
                total_amount=Decimal("17.50"),
                source="test",
                created_at=now,
            ),
        ])
        self.db.commit()

    def test_metrics_routes_are_registered_and_require_authentication(self) -> None:
        original = app.dependency_overrides.pop(get_current_user)
        try:
            response = self.client.get("/api/v1/model-metrics/models")
            self.assertEqual(response.status_code, 401, response.text)
        finally:
            app.dependency_overrides[get_current_user] = original

        paths = set(app.openapi()["paths"])
        self.assertIn("/api/v1/model-metrics/overview", paths)
        self.assertIn("/api/v1/model-metrics/models", paths)
        self.assertIn("/api/v1/model-metrics/performance", paths)
        self.assertIn("/api/v1/model-metrics/performance-trend", paths)
        self.assertIn("/api/v1/model-metrics/prediction-distribution", paths)
        self.assertIn("/api/v1/model-metrics/feature-importance/{model_name}", paths)
        self.assertIn("/api/v1/model-metrics/recent-predictions", paths)
        self.assertIn("/api/v1/model-metrics/models/{model_name}/details", paths)
        self.assertIn("/api/v1/model-metrics/models/{model_name}/evaluate", paths)
        self.assertIn("/api/v1/model-metrics/retrain-all", paths)

    def test_models_and_feature_importance_use_real_artifacts(self) -> None:
        models = self.client.get("/api/v1/model-metrics/models")
        self.assertEqual(models.status_code, 200, models.text)
        by_name = {item["model_name"]: item for item in models.json()}
        self.assertEqual(
            set(by_name),
            {"demand_forecast", "expiry_risk", "discount_recommendation"},
        )
        self.assertEqual(by_name["demand_forecast"]["algorithm"], "RandomForestRegressor")
        self.assertEqual(by_name["expiry_risk"]["algorithm"], "RandomForestClassifier")
        self.assertEqual(by_name["discount_recommendation"]["algorithm"], "RandomForestRegressor")

        for model_name in by_name:
            response = self.client.get(f"/api/v1/model-metrics/feature-importance/{model_name}")
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            self.assertEqual(body["status"], "available")
            self.assertTrue(body["features"])
            self.assertAlmostEqual(sum(row["importance_percent"] for row in body["features"]), 100.0, places=4)

    def test_performance_and_details_report_real_metrics_without_fabricated_timestamps(self) -> None:
        response = self.client.get("/api/v1/model-metrics/performance")
        self.assertEqual(response.status_code, 200, response.text)
        by_name = {item["model_name"]: item for item in response.json()}
        self.assertEqual(by_name["demand_forecast"]["algorithm"], "RandomForestRegressor")
        self.assertAlmostEqual(by_name["demand_forecast"]["mae"], 3.576221461586033)
        self.assertAlmostEqual(by_name["expiry_risk"]["accuracy"], 0.8814814814814815)
        self.assertAlmostEqual(by_name["discount_recommendation"]["rmse"], 102.77085827840244)
        self.assertIsNone(by_name["demand_forecast"]["evaluated_at"])
        self.assertEqual(by_name["demand_forecast"]["training_timestamp_status"], "unavailable")

        details = self.client.get("/api/v1/model-metrics/models/expiry_risk/details")
        self.assertEqual(details.status_code, 200, details.text)
        self.assertEqual(details.json()["algorithm"], "RandomForestClassifier")
        self.assertEqual(details.json()["training_records"], 1865)

    def test_overview_distribution_recent_and_demand_error_use_database_records(self) -> None:
        self.add_prediction_history()
        overview = self.client.get("/api/v1/model-metrics/overview")
        self.assertEqual(overview.status_code, 200, overview.text)
        self.assertEqual(overview.json()["total_predictions"], 3)
        self.assertEqual(overview.json()["predictions_by_model"]["demand_forecast"], 1)
        self.assertEqual(overview.json()["predictions_by_model"]["expiry_risk"], 1)
        self.assertEqual(overview.json()["predictions_by_model"]["discount_recommendation"], 1)
        self.assertEqual(overview.json()["monthly_predictions"], 3)
        self.assertEqual(
            overview.json()["monthly_trend"],
            [{"month": date.today().strftime("%Y-%m"), "count": 3}],
        )

        distribution = self.client.get("/api/v1/model-metrics/prediction-distribution")
        self.assertEqual(distribution.status_code, 200, distribution.text)
        self.assertEqual(distribution.json()["expiry_risk"][1]["count"], 1)
        self.assertEqual(distribution.json()["discount_recommendations"], [{"type": "discount", "count": 1}])
        self.assertEqual(distribution.json()["demand_forecasts"], {
            "count": 1,
            "minimum": 4.0,
            "maximum": 4.0,
            "mean": 4.0,
        })

        recent = self.client.get("/api/v1/model-metrics/recent-predictions")
        self.assertEqual(recent.status_code, 200, recent.text)
        self.assertEqual(recent.json()["count"], 3)
        self.assertEqual(
            {item["model_name"] for item in recent.json()["items"]},
            {"demand_forecast", "expiry_risk", "discount_recommendation"},
        )

        demand = self.client.get("/api/v1/model-metrics/demand/actual-vs-predicted")
        self.assertEqual(demand.status_code, 200, demand.text)
        self.assertEqual(demand.json()["items"][0]["actual_demand"], 5.0)
        self.assertEqual(demand.json()["items"][0]["error"], -1.0)

    def test_date_range_validation_and_unavailable_history_are_explicit(self) -> None:
        invalid = self.client.get(
            "/api/v1/model-metrics/performance",
            params={"start_date": "2026-11-05", "end_date": "2026-11-04"},
        )
        self.assertEqual(invalid.status_code, 422, invalid.text)

        trend = self.client.get("/api/v1/model-metrics/performance-trend")
        self.assertEqual(trend.status_code, 200, trend.text)
        self.assertEqual(trend.json()["status"], "unavailable")
        self.assertEqual(trend.json()["data"], [])

    def test_evaluation_uses_held_out_data_and_persists_results(self) -> None:
        for model_name in ("demand_forecast", "expiry_risk", "discount_recommendation"):
            response = self.client.post(f"/api/v1/model-metrics/models/{model_name}/evaluate")
            self.assertEqual(response.status_code, 201, response.text)
            body = response.json()
            self.assertEqual(body["source"], "database")
            self.assertGreater(body["sample_size"], 0)
            self.assertEqual(body["test_records"], body["sample_size"])
            self.assertIsNone(body["training_timestamp"])
            self.assertTrue(body["training_timestamp_status"] == "unavailable")
            if model_name == "expiry_risk":
                self.assertIn("confusion_matrix", body["metrics"])
                self.assertIn("accuracy", body["metrics"])
            else:
                self.assertIn("mse", body["metrics"])
                self.assertIn("rmse", body["metrics"])
            self.assertEqual(
                self.db.scalar(select(ModelMetric.model_name).where(ModelMetric.metric_id == body["metric_id"])),
                model_name,
            )

    def test_evaluate_is_admin_only_and_retraining_requires_explicit_confirmation(self) -> None:
        self.user.role = "viewer"
        self.db.commit()
        denied = self.client.post("/api/v1/model-metrics/models/demand_forecast/evaluate")
        self.assertEqual(denied.status_code, 403)
        denied_retraining = self.client.post(
            "/api/v1/model-metrics/retrain-all",
            json={"confirm": True},
        )
        self.assertEqual(denied_retraining.status_code, 403)

        self.user.role = "admin"
        self.db.commit()
        unconfirmed = self.client.post(
            "/api/v1/model-metrics/retrain-all",
            json={"confirm": False},
        )
        self.assertEqual(unconfirmed.status_code, 400)
        self.assertIn("confirm=true", unconfirmed.json()["detail"])

    def test_missing_expiry_prediction_table_is_reported_as_unavailable(self) -> None:
        ExpiryRiskPrediction.__table__.drop(self.engine)
        response = self.client.get("/api/v1/model-metrics/prediction-distribution")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIsNone(response.json()["expiry_risk"])
        self.assertEqual(response.json()["unavailable"], ["expiry_risk"])

    def test_missing_artifact_is_reported_without_fabricating_model_metadata(self) -> None:
        with patch(
            "app.services.model_metrics_service.artifact_path",
            side_effect=FileNotFoundError("test artifact is missing"),
        ):
            models = self.client.get("/api/v1/model-metrics/models")
            self.assertEqual(models.status_code, 200, models.text)
            self.assertTrue(all(item["status"] == "unavailable" for item in models.json()))

            with patch(
                "app.services.model_metrics_service.load_model_artifact",
                side_effect=FileNotFoundError("test artifact is missing"),
            ):
                missing_importance = self.client.get(
                    "/api/v1/model-metrics/feature-importance/demand_forecast"
                )
                self.assertEqual(missing_importance.status_code, 503)

    def test_retraining_worker_failure_is_visible_in_job_status(self) -> None:
        job = create_retraining_job()

        class FailedProcess:
            stdout = StringIO("training failed\n")

            @staticmethod
            def wait() -> int:
                return 1

        with patch("subprocess.Popen", return_value=FailedProcess()):
            run_retraining_job(job["job_id"])

        result = get_retraining_job(job["job_id"])
        self.assertIsNotNone(result)
        self.assertEqual(result["status"], "failed")
        self.assertIn("status 1", result["error"])
