import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ModelMetrics from "./ModelMetrics";
import * as metricsApi from "../services/modelMetrics";
import type { ModelName } from "../services/modelMetrics";

vi.mock("../services/modelMetrics", () => ({
  getDemandActualVsPredicted: vi.fn(),
  getFeatureImportance: vi.fn(),
  getModelCatalog: vi.fn(),
  getModelDetails: vi.fn(),
  getModelMetricsOverview: vi.fn(),
  getModelPerformance: vi.fn(),
  getModelPerformanceTrend: vi.fn(),
  getModelRetrainingStatus: vi.fn(),
  getPredictionDistribution: vi.fn(),
  getRecentPredictions: vi.fn(),
  startModelRetraining: vi.fn(),
}));

const now = new Date();
const today = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
const catalog = [
  {
    model_name: "demand_forecast" as const, model_version: "demand-v1",
    algorithm: "RandomForestRegressor", status: "available", training_timestamp: null,
    training_dataset: "perishable_inventory.csv", training_records: 1400, test_records: 350,
    metrics: { mae: 3.57, rmse: 4.5, r2: 0.765 }, features: ["category", "sales_lag_1"],
  },
  {
    model_name: "expiry_risk" as const, model_version: "expiry-v1",
    algorithm: "RandomForestClassifier", status: "available", training_timestamp: null,
    training_dataset: "inventory_batches.csv", training_records: 540, test_records: 135,
    metrics: { accuracy: 0.881, precision: 0.902, recall: 0.902, f1: 0.902 }, features: ["days_to_expiry"],
  },
  {
    model_name: "discount_recommendation" as const, model_version: "discount-v1",
    algorithm: "RandomForestRegressor", status: "available", training_timestamp: null,
    training_dataset: "discount_scenarios_simulated.csv", training_records: 8000, test_records: 2000,
    metrics: { mae: 38.42, rmse: 102.77, r2: 0.937 },
    features: ["discount_pct", "days_to_expiry"], data_caveat: "Evaluation uses simulated scenarios.",
  },
];
const performance = [
  { model_name: "demand_forecast" as const, model_version: "demand-v1", evaluated_at: null, sample_size: 350, metrics: { mae: 3.57, rmse: 4.5, r2: 0.765 }, source: "artifact_metrics" },
  { model_name: "expiry_risk" as const, model_version: "expiry-v1", evaluated_at: null, sample_size: 135, metrics: { accuracy: 0.881, precision: 0.902, recall: 0.875, f1: 0.888 }, source: "artifact_metrics" },
  { model_name: "discount_recommendation" as const, model_version: "discount-v1", evaluated_at: null, sample_size: 2000, metrics: { mae: 38.42, rmse: 102.77, r2: 0.937 }, source: "artifact_metrics" },
];
const prediction = {
  model_name: "demand_forecast" as const, prediction_id: 21, predicted_at: today,
  product_id: 1, product_name: "Apple", forecast_date: today.slice(0, 10),
  predicted_demand: 12, actual_demand: null, error: null, model_version: "demand-v1",
};

function installData() {
  vi.mocked(metricsApi.getModelMetricsOverview).mockResolvedValue({
    status: "available", total_predictions: 982, monthly_predictions: 24,
    predictions_by_model: { demand_forecast: 982, expiry_risk: null, discount_recommendation: 0 },
    monthly_by_model: { demand_forecast: 24, expiry_risk: null, discount_recommendation: 0 },
    monthly_trend: [{ month: now.toISOString().slice(0, 7), count: 24 }], unavailable: ["expiry_risk"],
  });
  vi.mocked(metricsApi.getModelCatalog).mockResolvedValue(catalog);
  vi.mocked(metricsApi.getModelPerformance).mockResolvedValue(performance);
  vi.mocked(metricsApi.getPredictionDistribution).mockResolvedValue({
    status: "available",
    demand_forecasts: { count: 982, minimum: 1, maximum: 100, mean: 45 },
    expiry_risk: null,
    discount_recommendations: [],
    unavailable: ["expiry_risk"],
  });
  vi.mocked(metricsApi.getModelPerformanceTrend).mockResolvedValue({
    status: "available",
    data: performance.map((item) => ({ ...item, evaluated_at: today })),
    message: null,
  });
  vi.mocked(metricsApi.getRecentPredictions).mockResolvedValue({
    status: "available", items: [prediction], count: 1, unavailable: ["expiry_risk"],
  });
  vi.mocked(metricsApi.getDemandActualVsPredicted).mockResolvedValue({
    status: "available",
    items: [{ product_id: 1, forecast_date: today.slice(0, 10), predicted_demand: 12, actual_demand: 10, error: 2, model_version: "demand-v1" }],
    count: 1,
  });
  vi.mocked(metricsApi.getFeatureImportance).mockResolvedValue({
    model_name: "demand_forecast", status: "available",
    features: [{ feature: "sales_lag_1", importance: 0.32, importance_percent: 32 }],
  });
  vi.mocked(metricsApi.getModelDetails).mockImplementation(async (modelName: ModelName) => ({
    ...catalog.find((item) => item.model_name === modelName)!,
    latest_evaluation: { evaluated_at: today, sample_size: 350, metrics: { mae: 3.57, rmse: 4.5, r2: 0.765 }, source: "database" },
  }));
  vi.mocked(metricsApi.startModelRetraining).mockResolvedValue({
    job_id: "job-1", status: "completed", progress_percent: 100,
    completed_models: ["demand_forecast", "expiry_risk", "discount_recommendation"],
    total_models: 3, started_at: today, completed_at: today, error: null,
  });
  vi.mocked(metricsApi.getModelRetrainingStatus).mockResolvedValue({
    job_id: "job-1", status: "completed", progress_percent: 100,
    completed_models: [], total_models: 3, started_at: today, completed_at: today, error: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  installData();
});

describe("ModelMetrics dashboard", () => {
  it("renders API-derived summary, compatible metrics, model table, charts and features", async () => {
    render(<ModelMetrics onNotify={vi.fn()} />);

    expect(await screen.findByText("982")).toBeInTheDocument();
    expect(screen.getByText("982")).toBeInTheDocument();
    expect(screen.getByText("76.5%")).toBeInTheDocument();
    expect(screen.getByText("Accuracy: 88.1%")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /R² comparison/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Model evaluation trend/ })).toBeInTheDocument();
    expect(screen.getByText("sales_lag_1")).toBeInTheDocument();
    expect(screen.getByText(/Evaluation uses simulated scenarios/)).toBeInTheDocument();
    expect(screen.getByText("Apple")).toBeInTheDocument();
    expect(screen.getByText("10.0")).toBeInTheDocument();
  });

  it("switches distribution model and requests the chosen evaluation date range", async () => {
    render(<ModelMetrics onNotify={vi.fn()} />);
    await screen.findByText("Apple");

    fireEvent.change(screen.getByLabelText("Prediction distribution model"), { target: { value: "expiry_risk" } });
    expect(await screen.findByText("Expiry-risk prediction history is not available in the database.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Evaluation trend period"), { target: { value: "7" } });
    await waitFor(() => expect(metricsApi.getModelPerformanceTrend).toHaveBeenLastCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)));
  });

  it("opens details from the table without exposing artifact filesystem paths", async () => {
    render(<ModelMetrics onNotify={vi.fn()} />);
    await screen.findByText("Apple");

    fireEvent.click(screen.getAllByRole("button", { name: "View Details" })[0]);
    expect(await screen.findByRole("dialog", { name: "Demand Forecast Details" })).toBeInTheDocument();
    expect(screen.getByText("perishable_inventory.csv")).toBeInTheDocument();
    expect(screen.getByText(/350/)).toBeInTheDocument();
    expect(screen.queryByText(/artifact_path|backend\\models/i)).not.toBeInTheDocument();
    expect(metricsApi.getRecentPredictions).toHaveBeenLastCalledWith({ modelName: "demand_forecast", limit: 10 });
  });

  it("filters and paginates real recent predictions", async () => {
    vi.mocked(metricsApi.getRecentPredictions).mockResolvedValue({
      status: "available",
      items: Array.from({ length: 12 }, (_, index) => ({ ...prediction, prediction_id: index + 1, product_name: index === 0 ? "Apple" : `Fruit ${index}` })),
      count: 12,
      unavailable: [],
    });
    render(<ModelMetrics onNotify={vi.fn()} />);
    await screen.findByText("Fruit 9");

    fireEvent.change(screen.getByLabelText("Search recent predictions"), { target: { value: "Apple" } });
    expect(screen.getByText("Apple")).toBeInTheDocument();
    expect(screen.queryByText("Fruit 1")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search recent predictions"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Next prediction page" }));
    expect(screen.getByText("Fruit 10")).toBeInTheDocument();
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
  });

  it("makes retraining admin-only and requires explicit confirmation", async () => {
    const { rerender } = render(<ModelMetrics onNotify={vi.fn()} />);
    await screen.findByText("Apple");
    expect(screen.queryByRole("button", { name: "Retrain All Models" })).not.toBeInTheDocument();

    rerender(<ModelMetrics onNotify={vi.fn()} canRetrain />);
    fireEvent.click(await screen.findByRole("button", { name: "Retrain All Models" }));
    expect(screen.getByRole("dialog", { name: "Retrain all models?" })).toBeInTheDocument();
    expect(metricsApi.startModelRetraining).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm retraining" }));
    await waitFor(() => expect(metricsApi.startModelRetraining).toHaveBeenCalledOnce());
    expect(await screen.findByRole("status")).toHaveTextContent("Retraining completed");
  });

  it("shows loading, API error details and truthful empty states", async () => {
    let rejectOverview: ((error: Error) => void) | undefined;
    vi.mocked(metricsApi.getModelMetricsOverview).mockImplementation(() => new Promise((_, reject) => { rejectOverview = reject; }));
    vi.mocked(metricsApi.getModelCatalog).mockResolvedValue([]);
    vi.mocked(metricsApi.getModelPerformance).mockResolvedValue([]);
    vi.mocked(metricsApi.getPredictionDistribution).mockResolvedValue({
      status: "unavailable", demand_forecasts: null, expiry_risk: null, discount_recommendations: [], unavailable: ["expiry_risk"],
    });
    vi.mocked(metricsApi.getRecentPredictions).mockResolvedValue({ status: "unavailable", items: [], count: 0, unavailable: ["expiry_risk"] });
    const { container } = render(<ModelMetrics onNotify={vi.fn()} />);
    expect(container.querySelector(".mm-spin")).toBeInTheDocument();
    rejectOverview?.(new Error("Authentication required"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Authentication required");
    expect(screen.getByText("No saved demand forecasts are available.")).toBeInTheDocument();
    expect(screen.getByText("Prediction records could not be loaded.")).toBeInTheDocument();
  });
});
