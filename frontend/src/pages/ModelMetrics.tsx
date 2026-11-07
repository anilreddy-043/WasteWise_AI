import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  BrainCircuit,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Database,
  Lightbulb,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  Target,
  X,
} from "lucide-react";
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
} from "../services/modelMetrics";
import type {
  MetricValues,
  ModelCatalogItem,
  ModelDetails,
  ModelName,
  ModelPerformance,
  PredictionRecord,
  RetrainingJob,
} from "../services/modelMetrics";
import { formatAppDate, formatAppDateTime, useGeneralSettings } from "../services/generalSettings";

type Props = { onNotify: (message: string) => void; canRetrain?: boolean };
type DateRange = "7" | "30" | "90" | "all";
type ModelPayload = {
  overview: Awaited<ReturnType<typeof getModelMetricsOverview>> | null;
  models: ModelCatalogItem[];
  performance: ModelPerformance[];
  distribution: Awaited<ReturnType<typeof getPredictionDistribution>> | null;
  predictions: PredictionRecord[];
  actualDemand: Awaited<ReturnType<typeof getDemandActualVsPredicted>>["items"];
};

const emptyPayload: ModelPayload = {
  overview: null,
  models: [],
  performance: [],
  distribution: null,
  predictions: [],
  actualDemand: [],
};

const modelNames: ModelName[] = ["demand_forecast", "expiry_risk", "discount_recommendation"];
const modelLabels: Record<ModelName, string> = {
  demand_forecast: "Demand Forecast",
  expiry_risk: "Expiry Risk",
  discount_recommendation: "Discount Recommendation",
};
const modelPurposes: Record<ModelName, string> = {
  demand_forecast: "Forecasts future product demand from inventory and sales signals.",
  expiry_risk: "Classifies expiry risk using batch, shelf-life and demand information.",
  discount_recommendation: "Estimates simulated gross margin under discount scenarios.",
};
const modelColors: Record<ModelName, string> = {
  demand_forecast: "#3789f5",
  expiry_risk: "#0aa968",
  discount_recommendation: "#ff941f",
};
const metricLabels: Record<string, string> = {
  mae: "MAE",
  rmse: "RMSE",
  r2: "R²",
  r2_score: "R²",
  accuracy: "Accuracy",
  precision: "Precision",
  recall: "Recall",
  f1: "F1 Score",
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function metricValue(metrics: MetricValues | null | undefined, key: string): number | null {
  const value = metrics?.[key] ?? (key === "r2" ? metrics?.r2_score : undefined);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getModelMetrics(item: ModelPerformance | ModelCatalogItem): MetricValues {
  return item.metrics ?? {};
}

function formatMetric(value: number | null, metric: string): string {
  if (value === null) return "—";
  if (["accuracy", "precision", "recall", "f1", "r2", "r2_score"].includes(metric)) {
    return `${(value * 100).toFixed(1)}%`;
  }
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not recorded" : formatAppDateTime(value);
}

function startForRange(range: DateRange): string | undefined {
  if (range === "all") return undefined;
  const date = new Date();
  date.setDate(date.getDate() - Number(range));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dateKey(value: string | undefined): string {
  return value?.slice(0, 10) ?? "";
}

function modelIcon(name: ModelName) {
  if (name === "expiry_risk") return <CalendarDays size={17} />;
  if (name === "discount_recommendation") return <Target size={17} />;
  return <BarChart3 size={17} />;
}

function LineChart({ data }: { data: ModelPerformance[] }) {
  const series = modelNames.map((name) => {
    const key = name === "expiry_risk" ? "accuracy" : "r2";
    return {
      name,
      key,
      points: data.flatMap((item) => {
        if (item.model_name !== name || !item.evaluated_at) return [];
        const value = metricValue(getModelMetrics(item), key);
        return value === null ? [] : [{ date: item.evaluated_at, value }];
      }),
    };
  });
  const allPoints = series.flatMap((line) => line.points);
  if (!allPoints.length) {
    return <EmptyState text="No persisted evaluation history is available for this period." />;
  }
  const width = 660;
  const height = 190;
  const left = 43;
  const right = 12;
  const top = 14;
  const bottom = 34;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const allDates = allPoints.map((point) => new Date(point.date).getTime());
  const minDate = Math.min(...allDates);
  const maxDate = Math.max(...allDates);
  const x = (date: string) => left + (maxDate === minDate ? plotWidth / 2 : ((new Date(date).getTime() - minDate) / (maxDate - minDate)) * plotWidth);
  const y = (value: number) => top + (1 - Math.max(0, Math.min(1, value))) * plotHeight;
  return (
    <svg className="mm-line-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Model evaluation trend; regression lines show R squared and expiry risk shows accuracy">
      {[0, 0.25, 0.5, 0.75, 1].map((value) => (
        <g key={value}>
          <line x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke="#e9eef3" />
          <text x={left - 8} y={y(value) + 4} textAnchor="end">{Math.round(value * 100)}</text>
        </g>
      ))}
      {series.map((line) => line.points.length > 0 && (
        <g key={line.name}>
          <polyline
            points={line.points.map((point) => `${x(point.date)},${y(point.value)}`).join(" ")}
            fill="none"
            stroke={modelColors[line.name]}
            strokeWidth="2.5"
          />
          {line.points.map((point, index) => (
            <circle key={`${line.name}-${point.date}-${index}`} cx={x(point.date)} cy={y(point.value)} r="3.5" fill={modelColors[line.name]}>
              <title>{`${modelLabels[line.name]} ${metricLabels[line.key]}: ${formatMetric(point.value, line.key)} on ${formatDate(point.date)}`}</title>
            </circle>
          ))}
        </g>
      ))}
      <text x={left} y={height - 8}>{formatAppDate(new Date(minDate))}</text>
      <text x={width - right} y={height - 8} textAnchor="end">{formatAppDate(new Date(maxDate))}</text>
    </svg>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="mm-empty"><Database size={18} /><span>{text}</span></div>;
}

function MetricComparison({
  metrics,
  selectedMetric,
  onMetricChange,
}: {
  metrics: ModelPerformance[];
  selectedMetric: string;
  onMetricChange: (metric: string) => void;
}) {
  const availableMetrics = [...new Set(metrics.flatMap((item) => Object.keys(getModelMetrics(item))))].filter((key) => key in metricLabels);
  const metric = availableMetrics.includes(selectedMetric) ? selectedMetric : availableMetrics[0] ?? selectedMetric;
  const entries = metrics.flatMap((item) => {
    const value = metricValue(getModelMetrics(item), metric);
    return value === null ? [] : [{ name: item.model_name, value }];
  });
  const max = metric === "mae" || metric === "rmse"
    ? Math.max(1, ...entries.map((item) => item.value))
    : 1;
  return (
    <>
      <div className="mm-chart-control">
        <label htmlFor="mm-performance-metric">Metric</label>
        <select id="mm-performance-metric" value={metric} onChange={(event) => onMetricChange(event.target.value)}>
          {(availableMetrics.length ? availableMetrics : ["r2"]).map((key) => <option key={key} value={key}>{metricLabels[key] ?? key}</option>)}
        </select>
      </div>
      {entries.length ? (
        <div className="mm-compare-list" role="img" aria-label={`${metricLabels[metric] ?? metric} comparison using only available model results`}>
          {entries.map((entry) => (
            <div className="mm-compare-row" key={entry.name}>
              <span>{modelLabels[entry.name]}</span>
              <div className="mm-compare-track"><i style={{ width: `${Math.min(100, Math.max(2, entry.value / max * 100))}%`, background: modelColors[entry.name] }} /></div>
              <b>{formatMetric(entry.value, metric)}</b>
            </div>
          ))}
          <small>{metric === "mae" || metric === "rmse" ? "Lower is better · regression models only" : "Higher is better · only compatible model metrics are shown"}</small>
        </div>
      ) : <EmptyState text="No evaluation values are available for this metric." />}
    </>
  );
}

export default function ModelMetrics({ onNotify, canRetrain = false }: Props) {
  const { items_per_page: pageSize } = useGeneralSettings();
  const [data, setData] = useState<ModelPayload>(emptyPayload);
  const [loading, setLoading] = useState(true);
  const [trendLoading, setTrendLoading] = useState(true);
  const [featureLoading, setFeatureLoading] = useState(true);
  const [refreshIndex, setRefreshIndex] = useState(0);
  const [trend, setTrend] = useState<ModelPerformance[]>([]);
  const [feature, setFeature] = useState<Awaited<ReturnType<typeof getFeatureImportance>> | null>(null);
  const [error, setError] = useState("");
  const [range, setRange] = useState<DateRange>("30");
  const [metric, setMetric] = useState("r2");
  const [distributionModel, setDistributionModel] = useState<ModelName>("demand_forecast");
  const [featureModel, setFeatureModel] = useState<ModelName>("demand_forecast");
  const [detail, setDetail] = useState<ModelDetails | null>(null);
  const [detailPredictions, setDetailPredictions] = useState<PredictionRecord[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [retrainConfirmOpen, setRetrainConfirmOpen] = useState(false);
  const [retraining, setRetraining] = useState(false);
  const [retrainingJob, setRetrainingJob] = useState<RetrainingJob | null>(null);
  const [recentModel, setRecentModel] = useState<ModelName | "all">("all");
  const [recentRange, setRecentRange] = useState<DateRange>("30");
  const [recentSearch, setRecentSearch] = useState("");
  const [recentPage, setRecentPage] = useState(1);
  useEffect(() => { setRecentPage(1); }, [pageSize]);

  const loadDashboard = useCallback(async (showSpinner = true) => {
    if (showSpinner) setLoading(true);
    setError("");
    const results = await Promise.allSettled([
      getModelMetricsOverview(),
      getModelCatalog(),
      getModelPerformance(),
      getPredictionDistribution(),
      getRecentPredictions({ limit: 500 }),
      getDemandActualVsPredicted(undefined, undefined),
    ]);
    const failures: string[] = [];
    const valueAt = <T,>(index: number, fallback: T): T => {
      const result = results[index];
      if (result.status === "fulfilled") return result.value as T;
      failures.push(result.reason instanceof Error ? result.reason.message : "A Model Metrics API request failed.");
      return fallback;
    };
    const overview = valueAt(0, null);
    const models = valueAt(1, []);
    const performance = valueAt(2, []);
    const distribution = valueAt(3, null);
    const predictionResult = valueAt(4, { items: [] });
    const actualResult = valueAt(5, { items: [] });
    setData({
      overview,
      models,
      performance,
      distribution,
      predictions: predictionResult.items,
      actualDemand: actualResult.items,
    });
    if (failures.length) {
      const message = [...new Set(failures)].join(" ");
      setError(message);
      onNotify(message);
    }
    if (showSpinner) setLoading(false);
  }, [onNotify]);

  useEffect(() => { void loadDashboard(); }, [loadDashboard]);

  useEffect(() => {
    let active = true;
    setTrendLoading(true);
    getModelPerformanceTrend(startForRange(range)).then((result) => {
      if (active) setTrend(result.data);
    }).catch((reason: unknown) => {
      if (active) {
        const message = reason instanceof Error ? reason.message : "Could not load evaluation history.";
        setError(message);
        onNotify(message);
      }
    }).finally(() => { if (active) setTrendLoading(false); });
    return () => { active = false; };
  }, [onNotify, range, refreshIndex]);

  useEffect(() => {
    let active = true;
    setFeatureLoading(true);
    getFeatureImportance(featureModel).then((result) => {
      if (active) setFeature(result);
    }).catch((reason: unknown) => {
      if (active) {
        const message = reason instanceof Error ? reason.message : "Could not load feature importance.";
        setFeature(null);
        setError(message);
        onNotify(message);
      }
    }).finally(() => { if (active) setFeatureLoading(false); });
    return () => { active = false; };
  }, [featureModel, onNotify, refreshIndex]);

  const details = data.models;
  const latestEvaluation = useMemo(() => {
    const values = [
      ...data.performance.flatMap((item) => item.evaluated_at ? [item.evaluated_at] : []),
      ...data.models.flatMap((item) => item.training_timestamp ? [item.training_timestamp] : []),
    ];
    return values.sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] ?? null;
  }, [data.performance]);
  const latestPrediction = useMemo(() => data.predictions
    .slice()
    .sort((left, right) => new Date(right.predicted_at).getTime() - new Date(left.predicted_at).getTime())[0] ?? null, [data.predictions]);
  const activeCount = details.filter((item) => item.status === "available").length;
  const inactiveCount = details.length - activeCount;
  const regressionScores = data.performance.flatMap((item) => {
    if (item.model_name === "expiry_risk") return [];
    const score = metricValue(item.metrics, "r2");
    return score === null ? [] : [score];
  });
  const averageR2 = regressionScores.length
    ? regressionScores.reduce((total, value) => total + value, 0) / regressionScores.length
    : null;
  const currentMonthKey = new Date().toISOString().slice(0, 7);
  const previousMonth = new Date();
  previousMonth.setMonth(previousMonth.getMonth() - 1);
  const previousMonthKey = previousMonth.toISOString().slice(0, 7);
  const currentMonthCount = data.overview?.monthly_trend.find((item) => item.month === currentMonthKey)?.count ?? data.overview?.monthly_predictions ?? 0;
  const previousMonthCount = data.overview?.monthly_trend.find((item) => item.month === previousMonthKey)?.count;
  const monthlyChange = previousMonthCount && previousMonthCount > 0
    ? Math.round(((currentMonthCount - previousMonthCount) / previousMonthCount) * 100)
    : null;

  const actualByKey = useMemo(() => new Map(
    data.actualDemand.map((item) => [`${item.product_id}:${dateKey(item.forecast_date)}`, item]),
  ), [data.actualDemand]);
  const enrichedPredictions = useMemo(() => data.predictions.map((item) => {
    if (item.model_name !== "demand_forecast") return item;
    const match = actualByKey.get(`${item.product_id}:${dateKey(item.forecast_date)}`);
    return match ? { ...item, actual_demand: match.actual_demand, error: match.error } : item;
  }), [actualByKey, data.predictions]);
  const filteredRecent = useMemo(() => {
    const startDate = startForRange(recentRange);
    const startTime = startDate ? new Date(`${startDate}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY;
    const query = recentSearch.trim().toLowerCase();
    return enrichedPredictions.filter((item) => {
      const date = new Date(item.predicted_at).getTime();
      const modelMatches = recentModel === "all" || item.model_name === recentModel;
      const searchMatches = !query || `${item.product_name} ${item.product_id} ${item.model_name} ${item.prediction_id}`.toLowerCase().includes(query);
      return modelMatches && searchMatches && date >= startTime;
    });
  }, [enrichedPredictions, recentModel, recentRange, recentSearch]);
  const recentPageCount = Math.max(1, Math.ceil(filteredRecent.length / pageSize));
  const pagePredictions = filteredRecent.slice((recentPage - 1) * pageSize, recentPage * pageSize);

  const openDetails = async (modelName: ModelName) => {
    setDetailLoading(true);
    setDetail(null);
    setDetailPredictions([]);
    try {
      const [modelDetails, recent] = await Promise.all([
        getModelDetails(modelName),
        getRecentPredictions({ modelName, limit: 10 }),
      ]);
      setDetail(modelDetails);
      setDetailPredictions(recent.items);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not load model details.";
      setError(message);
      onNotify(message);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleRetrain = async () => {
    setRetraining(true);
    setRetrainConfirmOpen(false);
    try {
      let job = await startModelRetraining();
      setRetrainingJob(job);
      while (job.status === "queued" || job.status === "running") {
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
        job = await getModelRetrainingStatus(job.job_id);
        setRetrainingJob(job);
      }
      if (job.status === "completed" || job.status === "completed_with_warning") {
        onNotify(job.status === "completed"
          ? "Model retraining completed."
          : `Model retraining completed with a warning${job.persistence_warning ? `: ${job.persistence_warning}` : "."}`);
        await loadDashboard(false);
        setRefreshIndex((index) => index + 1);
      } else {
        const message = job.error || "Model retraining failed.";
        setError(message);
        onNotify(message);
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Model retraining could not be started.";
      setError(message);
      onNotify(message);
    } finally {
      setRetraining(false);
    }
  };

  const selectedDistribution = data.distribution;
  const distributionRecords = data.predictions.filter((item) => item.model_name === distributionModel);
  const demandActuals = data.actualDemand.filter((item) => item.actual_demand !== null);
  const avgActualDemand = demandActuals.length
    ? demandActuals.reduce((sum, item) => sum + (item.actual_demand ?? 0), 0) / demandActuals.length
    : null;
  const avgPredictedDemand = demandActuals.length
    ? demandActuals.reduce((sum, item) => sum + item.predicted_demand, 0) / demandActuals.length
    : null;
  const featureImportance = feature?.features ?? [];
  const insights = [
    (() => {
      const item = data.performance.find((entry) => entry.model_name === "demand_forecast");
      const value = metricValue(item?.metrics, "r2");
      return value === null ? "Demand Forecast evaluation score is not available." : `Demand Forecast held-out R² is ${formatMetric(value, "r2")}.`;
    })(),
    (() => {
      const item = data.performance.find((entry) => entry.model_name === "expiry_risk");
      const value = metricValue(item?.metrics, "accuracy");
      return value === null ? "Expiry Risk classification metrics are not available." : `Expiry Risk held-out accuracy is ${formatMetric(value, "accuracy")}.`;
    })(),
    (() => {
      const item = data.performance.find((entry) => entry.model_name === "discount_recommendation");
      const value = metricValue(item?.metrics, "mae");
      if (value === null) return "Discount Recommendation error metrics are not available.";
      const caveat = data.models.find((model) => model.model_name === "discount_recommendation")?.data_caveat;
      return `Discount Recommendation MAE is ${value.toFixed(2)}${caveat ? `; note: ${caveat}` : "."}`;
    })(),
    trend.length
    ? `${trend.length} persisted model evaluation${trend.length === 1 ? "" : "s"} available in the selected trend window.`
      : "No persisted evaluation history is available for the selected trend window.",
  ];

  return (
    <main className="page-content model-metrics-page">
      <header className="mm-banner">
        <div className="mm-banner-copy">
          <h1>Model Metrics</h1>
          <p>Track the performance of AI models and ensure accurate predictions</p>
        </div>
        <div className="mm-banner-art" aria-hidden="true">
          <div className="mm-brain"><BrainCircuit size={45} /><BarChart3 size={26} /></div>
          <span className="mm-leaf mm-leaf-one">❧</span><span className="mm-leaf mm-leaf-two">❧</span>
        </div>
        <div className="mm-banner-tag"><ShieldCheck size={23} /><b>Data-Driven Decisions<br />for a Smarter,<br />Greener Store</b></div>
      </header>

      {error && <div className="mm-error" role="alert"><AlertTriangle size={17} />{error}<button type="button" onClick={() => { void loadDashboard(); setRefreshIndex((index) => index + 1); }}>Retry</button></div>}

      <section className="mm-kpis" aria-label="Model metrics summary">
        <article className="mm-kpi"><span className="mm-kpi-icon purple"><BarChart3 size={28} /></span><div><small>Total Models</small><strong>{loading ? "—" : details.length}</strong><span>{activeCount} active · {inactiveCount} unavailable</span></div></article>
        <article className="mm-kpi"><span className="mm-kpi-icon green"><Target size={29} /></span><div><small>Average Regression R²</small><strong>{loading ? "—" : formatMetric(averageR2, "r2")}</strong><span>Regression models only</span></div></article>
        <article className="mm-kpi"><span className="mm-kpi-icon blue"><Database size={27} /></span><div><small>Total Predictions</small><strong>{loading ? "—" : data.overview?.total_predictions.toLocaleString() ?? "—"}</strong><span>{(data.overview?.monthly_predictions ?? 0).toLocaleString()} this month{monthlyChange === null ? "" : ` · ${monthlyChange >= 0 ? "+" : ""}${monthlyChange}% vs last month`}</span></div></article>
        <article className="mm-kpi"><span className="mm-kpi-icon orange"><Clock3 size={28} /></span><div><small>Last Updated</small><strong className="mm-kpi-date">{formatDate(latestEvaluation)}</strong><span className={activeCount === details.length && details.length > 0 ? "mm-health good" : "mm-health"}>{activeCount === details.length && details.length > 0 ? "● All models available" : `● ${inactiveCount} model(s) unavailable`}</span></div></article>
      </section>

      <section className="mm-chart-grid" aria-label="Model analytics">
        <article className="mm-panel mm-performance-panel">
          <div className="mm-panel-heading"><h2>Model Performance Comparison</h2><span>Latest evaluation · compatible metric only</span></div>
          {loading ? <div className="mm-chart-loading"><LoaderCircle className="mm-spin" /> Loading metrics…</div> : <MetricComparison metrics={data.performance} selectedMetric={metric} onMetricChange={setMetric} />}
        </article>
        <article className="mm-panel mm-trend-panel">
          <div className="mm-panel-heading">
            <div><h2>Prediction Accuracy Trend</h2><span>Evaluation history · regression R² / expiry accuracy</span></div>
            <select aria-label="Evaluation trend period" value={range} onChange={(event) => setRange(event.target.value as DateRange)}>
              <option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="all">All time</option>
            </select>
          </div>
          <div className="mm-trend-legend">{modelNames.map((name) => <span key={name}><i style={{ background: modelColors[name] }} />{modelLabels[name]} <small>{name === "expiry_risk" ? "Accuracy" : "R²"}</small></span>)}</div>
          {loading || trendLoading ? <div className="mm-chart-loading"><LoaderCircle className="mm-spin" /> Loading history…</div> : <LineChart data={trend} />}
        </article>
        <article className="mm-panel mm-distribution-panel">
          <div className="mm-panel-heading"><h2>Prediction Distribution</h2><select aria-label="Prediction distribution model" value={distributionModel} onChange={(event) => setDistributionModel(event.target.value as ModelName)}>{modelNames.map((name) => <option key={name} value={name}>{modelLabels[name]}</option>)}</select></div>
          {loading ? <div className="mm-chart-loading"><LoaderCircle className="mm-spin" /> Loading distribution…</div> : distributionModel === "expiry_risk" ? (
            selectedDistribution?.expiry_risk ? <div className="mm-risk-bars">{selectedDistribution.expiry_risk.map((item) => {
              const maxCount = Math.max(1, ...selectedDistribution.expiry_risk!.map((risk) => risk.count));
              return <div key={item.risk_level}><span>{item.risk_level}</span><div><i className={`risk-${item.risk_level.toLowerCase().replace(" ", "-")}`} style={{ width: `${Math.max(1, item.count / maxCount * 100)}%` }} /></div><b>{item.count}</b></div>;
            })}</div> : <EmptyState text="Expiry-risk prediction history is not available in the database." />
          ) : distributionModel === "discount_recommendation" ? (
            selectedDistribution?.discount_recommendations.length ? <div className="mm-risk-bars">{selectedDistribution.discount_recommendations.map((item) => {
              const maxCount = Math.max(1, ...selectedDistribution.discount_recommendations.map((entry) => entry.count));
              return <div key={item.type}><span>{item.type}</span><div><i className="risk-low-risk" style={{ width: `${Math.max(1, item.count / maxCount * 100)}%` }} /></div><b>{item.count}</b></div>;
            })}</div> : <EmptyState text="No persisted recommendation records are available." />
          ) : selectedDistribution?.demand_forecasts ? (
            <div className="mm-demand-distribution">
              <div className="mm-demand-stats">
                <span><small>Minimum</small><b>{selectedDistribution.demand_forecasts.minimum.toFixed(1)}</b></span>
                <span><small>Average predicted</small><b>{selectedDistribution.demand_forecasts.mean.toFixed(1)}</b></span>
                <span><small>Maximum</small><b>{selectedDistribution.demand_forecasts.maximum.toFixed(1)}</b></span>
              </div>
              <div className="mm-demand-scale"><i style={{ left: `${selectedDistribution.demand_forecasts.maximum > 0 ? selectedDistribution.demand_forecasts.minimum / selectedDistribution.demand_forecasts.maximum * 100 : 0}%` }} /><b style={{ left: `${selectedDistribution.demand_forecasts.maximum > 0 ? selectedDistribution.demand_forecasts.mean / selectedDistribution.demand_forecasts.maximum * 100 : 50}%` }} /></div>
              <div className="mm-demand-legend"><span>Predicted {selectedDistribution.demand_forecasts.count.toLocaleString()}</span><span>Actual avg. {avgActualDemand === null ? "unavailable" : avgActualDemand.toFixed(1)}</span></div>
              {avgPredictedDemand !== null && <small className="mm-source-note">Actual demand matched from sales records; {demandActuals.length} matched observations.</small>}
            </div>
          ) : <EmptyState text="No saved demand forecasts are available." />}
          {distributionModel !== "demand_forecast" && <small className="mm-source-note">{distributionRecords.length ? `${distributionRecords.length} matching persisted prediction records.` : "Distribution uses persisted prediction records only."}</small>}
        </article>
      </section>

      <section className="mm-panel mm-models-panel">
        <div className="mm-panel-heading">
          <div><h2>ML Models Overview</h2><span>Details and evaluation results from the existing artifacts and backend</span></div>
          {canRetrain && <button className="mm-retrain-button" type="button" onClick={() => setRetrainConfirmOpen(true)} disabled={retraining}><RefreshCw size={14} /> Retrain All Models</button>}
        </div>
        {retrainingJob && <div className="mm-progress" role="status"><div><b>Retraining {retrainingJob.status.replace(/_/g, " ")}</b><span>{retrainingJob.completed_models.length} / {retrainingJob.total_models} models completed{retrainingJob.completed_models.length ? ` · ${retrainingJob.completed_models.map((name) => modelLabels[name as ModelName] ?? name.replace(/_/g, " ")).join(", ")}` : ""}</span></div><progress max="100" value={retrainingJob.progress_percent} /><strong>{retrainingJob.progress_percent}%</strong></div>}
        <div className="mm-table-scroll">
          <table className="mm-model-table">
            <thead><tr><th>#</th><th>Model Name</th><th>Purpose</th><th>Algorithm</th><th>Key Metrics</th><th>Last Trained</th><th>Status</th><th>Action</th></tr></thead>
            <tbody>
              {details.map((item, index) => {
                const performance = data.performance.find((entry) => entry.model_name === item.model_name);
                const values = getModelMetrics(performance ?? item);
                return <tr key={item.model_name}>
                  <td>{index + 1}</td>
                  <td><span className={`mm-model-icon ${item.model_name}`}>{modelIcon(item.model_name)}</span><b>{modelLabels[item.model_name]}</b></td>
                  <td>{modelPurposes[item.model_name]}</td><td>{item.algorithm ?? "Unavailable"}</td>
                  <td>{item.model_name === "expiry_risk" ? <>
                    <b>Accuracy: {formatMetric(metricValue(values, "accuracy"), "accuracy")}</b>
                    <b>Precision: {formatMetric(metricValue(values, "precision"), "precision")}</b>
                    <b>Recall: {formatMetric(metricValue(values, "recall"), "recall")}</b>
                  </> : <>
                    <b>MAE: {formatMetric(metricValue(values, "mae"), "mae")}</b>
                    <b>RMSE: {formatMetric(metricValue(values, "rmse"), "rmse")}</b>
                    <b>R²: {formatMetric(metricValue(values, "r2"), "r2")}</b>
                  </>}</td>
                  <td>{formatDate(item.training_timestamp)}</td>
                  <td><span className={`mm-status ${item.status === "available" ? "available" : "unavailable"}`}><i />{item.status === "available" ? "Active" : "Unavailable"}</span></td>
                  <td><button className="mm-detail-button" type="button" onClick={() => void openDetails(item.model_name)}>View Details</button></td>
                </tr>;
              })}
              {!loading && details.length === 0 && <tr><td colSpan={8}><EmptyState text="No model catalog data is available." /></td></tr>}
              {loading && <tr><td colSpan={8}><div className="mm-chart-loading"><LoaderCircle className="mm-spin" /> Loading model catalog…</div></td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mm-bottom-grid">
        <article className="mm-insights">
          <div className="mm-insights-icon"><Lightbulb size={26} /></div>
          <div><h2>Model Insights</h2><ul>{insights.map((insight) => <li key={insight}>{insight}</li>)}</ul></div>
        </article>
        <article className="mm-panel mm-feature-panel">
          <div className="mm-panel-heading"><h2>Feature Importance</h2><select aria-label="Feature importance model" value={featureModel} onChange={(event) => setFeatureModel(event.target.value as ModelName)}>{modelNames.map((name) => <option key={name} value={name}>{modelLabels[name]}</option>)}</select></div>
          {loading || featureLoading ? <div className="mm-chart-loading"><LoaderCircle className="mm-spin" /> Loading features…</div> : feature?.status === "unavailable" || !featureImportance.length ? <EmptyState text={feature?.message ?? "No feature importance is available for this model."} /> : (
            <div className="mm-feature-bars">{featureImportance.slice(0, 6).map((feature) => <div key={feature.feature}><span title={feature.feature}>{feature.feature}</span><div><i style={{ width: `${Math.min(100, feature.importance_percent)}%` }} /></div><b>{feature.importance_percent.toFixed(1)}%</b></div>)}</div>
          )}
        </article>
        <article className="mm-panel mm-recent-panel">
          <div className="mm-panel-heading"><h2>Recent Predictions</h2><span>{filteredRecent.length} records</span></div>
          <div className="mm-recent-tools">
            <label className="mm-search"><Search size={14} /><input aria-label="Search recent predictions" placeholder="Search product or model" value={recentSearch} onChange={(event) => { setRecentSearch(event.target.value); setRecentPage(1); }} /></label>
            <select aria-label="Recent predictions model filter" value={recentModel} onChange={(event) => { setRecentModel(event.target.value as ModelName | "all"); setRecentPage(1); }}><option value="all">All models</option>{modelNames.map((name) => <option key={name} value={name}>{modelLabels[name]}</option>)}</select>
            <select aria-label="Recent predictions date filter" value={recentRange} onChange={(event) => { setRecentRange(event.target.value as DateRange); setRecentPage(1); }}><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="all">All time</option></select>
          </div>
          <div className="mm-recent-table-scroll"><table className="mm-recent-table">
            <thead><tr><th>ID</th><th>Product</th><th>Prediction</th><th>Actual</th><th>Error</th><th>Date</th></tr></thead>
            <tbody>{pagePredictions.map((item) => {
              const predicted = item.predicted_demand ?? item.risk_level ?? (item.discount_percent === null || item.discount_percent === undefined ? item.recommendation_type : `${item.discount_percent}% discount`);
              const actual = item.actual_demand === null || item.actual_demand === undefined ? "—" : item.actual_demand.toFixed(1);
              const errorValue = item.error === null || item.error === undefined || item.actual_demand === null || item.actual_demand === undefined || item.actual_demand === 0 ? "—" : `${(Math.abs(item.error) / Math.abs(item.actual_demand) * 100).toFixed(1)}%`;
              return <tr key={`${item.model_name}-${item.prediction_id}`}><td>{item.prediction_id}</td><td>{item.product_name}</td><td>{typeof predicted === "number" ? predicted.toLocaleString(undefined, { maximumFractionDigits: 1 }) : predicted}</td><td>{actual}</td><td>{errorValue}</td><td>{formatAppDate(item.predicted_at)}</td></tr>;
            })}
            {!loading && pagePredictions.length === 0 && <tr><td colSpan={6}><EmptyState text={error ? "Prediction records could not be loaded." : "No prediction records match these filters."} /></td></tr>}
            {loading && <tr><td colSpan={6}>Loading prediction records…</td></tr>}
            </tbody>
          </table></div>
          <div className="mm-pagination"><span>Page {recentPage} of {recentPageCount}</span><button type="button" aria-label="Previous prediction page" disabled={recentPage <= 1} onClick={() => setRecentPage((page) => page - 1)}>‹</button><button type="button" aria-label="Next prediction page" disabled={recentPage >= recentPageCount} onClick={() => setRecentPage((page) => page + 1)}>›</button></div>
        </article>
      </section>

      <div className="mm-last-prediction"><CheckCircle2 size={14} />Last successful prediction: {latestPrediction ? `${modelLabels[latestPrediction.model_name]} · ${formatDate(latestPrediction.predicted_at)}` : "No prediction history available"}</div>

      {(detailLoading || detail) && <div className="mm-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDetail(null); }}>
        <section className="mm-modal" role="dialog" aria-modal="true" aria-labelledby="mm-detail-title">
          <header><div><span className="mm-modal-icon">{detail && modelIcon(detail.model_name)}</span><div><h2 id="mm-detail-title">{detail ? `${modelLabels[detail.model_name]} Details` : "Loading Model Details"}</h2><p>Artifact metadata and persisted prediction records</p></div></div><button type="button" aria-label="Close model details" onClick={() => setDetail(null)}><X size={19} /></button></header>
          {detailLoading ? <div className="mm-modal-loading"><LoaderCircle className="mm-spin" /> Loading details…</div> : detail && <>
            <div className="mm-detail-grid">
              <div><small>Purpose</small><b>{modelPurposes[detail.model_name]}</b></div>
              <div><small>Algorithm</small><b>{detail.algorithm ?? "Unavailable"}</b></div>
              <div><small>Model version</small><b>{detail.model_version ?? "Unavailable"}</b></div>
              <div><small>Model status</small><b>{detail.status === "available" ? "Active" : "Unavailable"}</b></div>
              <div><small>Training dataset</small><b>{detail.training_dataset ?? "Unavailable"}</b></div>
              <div><small>Training records</small><b>{detail.training_records?.toLocaleString() ?? "Unavailable"}</b></div>
              <div><small>Test records</small><b>{detail.test_records?.toLocaleString() ?? "Unavailable"}</b></div>
              <div><small>Last training date</small><b>{formatDate(detail.training_timestamp)}</b></div>
              <div><small>Last evaluation date</small><b>{formatDate(detail.latest_evaluation?.evaluated_at ?? data.performance.find((item) => item.model_name === detail.model_name)?.evaluated_at)}</b></div>
            </div>
            <h3>Evaluation metrics</h3><div className="mm-detail-metrics">{Object.entries(detail.latest_evaluation?.metrics ?? detail.metrics ?? {}).filter(([, value]) => isFiniteNumber(value)).map(([key, value]) => <span key={key}><small>{metricLabels[key] ?? key}</small><b>{formatMetric(Number(value), key)}</b></span>)}</div>
            <h3>Features</h3><p className="mm-detail-copy">{detail.features?.length ? detail.features.join(", ") : "Feature list is unavailable from the artifact metadata."}</p>
            <h3>Recent prediction history</h3><p className="mm-detail-copy">{detailPredictions.length ? `${detailPredictions.length} persisted records. Latest: ${formatDate(detailPredictions[0]?.predicted_at)}.` : "No persisted prediction history is available for this model."}</p>
            <h3>Limitations</h3><p className="mm-detail-copy">{detail.data_caveat ?? (detail.training_timestamp ? "Metrics reflect the supplied evaluation data; refer to the training dataset and evaluation sample size." : "Training and evaluation timestamps are not recorded in artifact metadata.")}</p>
          </>}
        </section>
      </div>}

      {retrainConfirmOpen && <div className="mm-modal-backdrop" role="presentation"><section className="mm-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="mm-confirm-title">
        <span className="mm-confirm-icon"><AlertTriangle size={22} /></span><h2 id="mm-confirm-title">Retrain all models?</h2>
        <p>This will train and validate the model artifacts on the backend, then attempt to persist evaluation results. Existing artifact replacement is controlled by backend validation and registry rules.</p>
        <div><button type="button" className="mm-cancel-button" onClick={() => setRetrainConfirmOpen(false)}>Cancel</button><button type="button" className="mm-retrain-button" onClick={() => void handleRetrain()}>Confirm retraining</button></div>
      </section></div>}

      <button className="mm-refresh" type="button" onClick={() => { void loadDashboard(); setRefreshIndex((index) => index + 1); }} disabled={loading || retraining} aria-label="Refresh model metrics"><RefreshCw size={15} /> Refresh dashboard</button>
    </main>
  );
}
