import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDemandActualVsPredicted,
  getFeatureImportance,
  getModelCatalog,
  getModelDetails,
  getModelMetricsOverview,
  getModelPerformance,
  getModelPerformanceTrend,
  getModelRetrainingStatus,
  getPredictionDistribution,
  getRecentPredictions,
  startModelRetraining,
} from "./modelMetrics";
import { requestAuthenticatedJson } from "./auth";

vi.mock("./auth", () => ({ requestAuthenticatedJson: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requestAuthenticatedJson).mockResolvedValue({});
});

describe("Model Metrics API client", () => {
  it("uses the authenticated versioned metrics endpoints and forwards date/model filters", async () => {
    await getModelMetricsOverview();
    await getModelCatalog();
    await getModelPerformance();
    await getModelPerformanceTrend("2026-10-01", "2026-10-31");
    await getPredictionDistribution();
    await getFeatureImportance("expiry_risk");
    await getRecentPredictions({ modelName: "demand_forecast", startDate: "2026-10-01", endDate: "2026-10-31", limit: 25 });
    await getDemandActualVsPredicted("2026-10-01", "2026-10-31");
    await getModelDetails("discount_recommendation");

    expect(vi.mocked(requestAuthenticatedJson).mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/model-metrics/overview",
      "/api/v1/model-metrics/models",
      "/api/v1/model-metrics/performance",
      "/api/v1/model-metrics/performance-trend?start_date=2026-10-01&end_date=2026-10-31",
      "/api/v1/model-metrics/prediction-distribution",
      "/api/v1/model-metrics/feature-importance/expiry_risk",
      "/api/v1/model-metrics/recent-predictions?limit=25&model_name=demand_forecast&start_date=2026-10-01&end_date=2026-10-31",
      "/api/v1/model-metrics/demand/actual-vs-predicted?limit=1000&start_date=2026-10-01&end_date=2026-10-31",
      "/api/v1/model-metrics/models/discount_recommendation/details",
    ]);
  });

  it("requires explicit retraining confirmation and uses admin retraining status routes", async () => {
    await startModelRetraining();
    await getModelRetrainingStatus("job/42");

    expect(vi.mocked(requestAuthenticatedJson).mock.calls).toEqual([
      ["/api/v1/model-metrics/retrain-all", {
        method: "POST",
        body: JSON.stringify({ confirm: true }),
      }],
      ["/api/v1/model-metrics/retrain-all/job%2F42"],
    ]);
  });
});
