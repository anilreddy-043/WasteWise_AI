import { requestAuthenticatedJson } from "./auth";

export type ModelName = "demand_forecast" | "expiry_risk" | "discount_recommendation";
export type MetricValues = Record<string, unknown>;

export type ModelCatalogItem = {
  model_name: ModelName;
  model_version: string | null;
  algorithm: string | null;
  status: string;
  artifact_status?: string;
  training_timestamp: string | null;
  training_timestamp_status?: string;
  training_dataset: string | null;
  training_records: number | null;
  test_records: number | null;
  metrics: MetricValues | null;
  features: string[] | null;
  data_caveat?: string | null;
};

export type ModelPerformance = {
  model_name: ModelName;
  model_version: string | null;
  algorithm?: string | null;
  evaluated_at: string | null;
  sample_size: number | null;
  metrics: MetricValues | null;
  source: string;
  status?: string;
};

export type PredictionRecord = {
  model_name: ModelName;
  prediction_id: number;
  predicted_at: string;
  product_id: number;
  product_name: string;
  forecast_date?: string;
  predicted_demand?: number;
  actual_demand?: number | null;
  error?: number | null;
  predicted_class?: string;
  risk_probability?: number;
  risk_level?: string;
  recommendation_type?: string;
  recommended_quantity?: number | null;
  discount_percent?: number | null;
  model_version?: string | null;
};

export type ModelDetails = ModelCatalogItem & {
  latest_evaluation?: {
    evaluated_at: string | null;
    sample_size: number | null;
    metrics: MetricValues;
    source: string;
  } | null;
};

export type RetrainingJob = {
  job_id: string;
  status: "queued" | "running" | "completed" | "completed_with_warning" | "failed";
  progress_percent: number;
  completed_models: string[];
  total_models: number;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  persistence_warning?: string | null;
};

function dateQuery(startDate?: string, endDate?: string): string {
  const params = new URLSearchParams();
  if (startDate) params.set("start_date", startDate);
  if (endDate) params.set("end_date", endDate);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function getModelMetricsOverview() {
  return requestAuthenticatedJson<{
    status: string;
    total_predictions: number;
    monthly_predictions: number;
    predictions_by_model: Record<ModelName, number | null>;
    monthly_by_model: Record<ModelName, number | null>;
    monthly_trend: Array<{ month: string; count: number }>;
    unavailable: string[];
  }>("/api/v1/model-metrics/overview");
}

export function getModelCatalog() {
  return requestAuthenticatedJson<ModelCatalogItem[]>("/api/v1/model-metrics/models");
}

export function getModelPerformance() {
  return requestAuthenticatedJson<ModelPerformance[]>("/api/v1/model-metrics/performance");
}

export function getModelPerformanceTrend(startDate?: string, endDate?: string) {
  return requestAuthenticatedJson<{
    status: string;
    data: ModelPerformance[];
    message: string | null;
  }>(`/api/v1/model-metrics/performance-trend${dateQuery(startDate, endDate)}`);
}

export function getPredictionDistribution() {
  return requestAuthenticatedJson<{
    status: string;
    demand_forecasts: { count: number; minimum: number; maximum: number; mean: number } | null;
    expiry_risk: Array<{ risk_level: string; count: number }> | null;
    discount_recommendations: Array<{ type: string; count: number }>;
    unavailable: string[];
  }>("/api/v1/model-metrics/prediction-distribution");
}

export function getFeatureImportance(modelName: ModelName) {
  return requestAuthenticatedJson<{
    model_name: ModelName;
    status: string;
    message?: string;
    features: Array<{ feature: string; importance: number; importance_percent: number }>;
  }>(`/api/v1/model-metrics/feature-importance/${modelName}`);
}

export function getRecentPredictions(options: {
  modelName?: ModelName | "all";
  startDate?: string;
  endDate?: string;
  limit?: number;
} = {}) {
  const params = new URLSearchParams({ limit: String(options.limit ?? 100) });
  if (options.modelName && options.modelName !== "all") params.set("model_name", options.modelName);
  if (options.startDate) params.set("start_date", options.startDate);
  if (options.endDate) params.set("end_date", options.endDate);
  return requestAuthenticatedJson<{
    status: string;
    items: PredictionRecord[];
    count: number;
    unavailable: string[];
  }>(`/api/v1/model-metrics/recent-predictions?${params.toString()}`);
}

export function getDemandActualVsPredicted(startDate?: string, endDate?: string) {
  const params = new URLSearchParams({ limit: "1000" });
  if (startDate) params.set("start_date", startDate);
  if (endDate) params.set("end_date", endDate);
  return requestAuthenticatedJson<{
    status: string;
    items: Array<{
      product_id: number;
      forecast_date: string;
      predicted_demand: number;
      actual_demand: number | null;
      error: number | null;
      model_version: string;
    }>;
    count: number;
    unmatched_forecasts?: number;
  }>(`/api/v1/model-metrics/demand/actual-vs-predicted?${params.toString()}`);
}

export function getModelDetails(modelName: ModelName) {
  return requestAuthenticatedJson<ModelDetails>(`/api/v1/model-metrics/models/${modelName}/details`);
}

export function startModelRetraining() {
  return requestAuthenticatedJson<RetrainingJob>("/api/v1/model-metrics/retrain-all", {
    method: "POST",
    body: JSON.stringify({ confirm: true }),
  });
}

export function getModelRetrainingStatus(jobId: string) {
  return requestAuthenticatedJson<RetrainingJob>(`/api/v1/model-metrics/retrain-all/${encodeURIComponent(jobId)}`);
}
