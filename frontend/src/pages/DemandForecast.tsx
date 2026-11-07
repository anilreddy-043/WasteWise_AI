import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, ArrowDown, ArrowUpRight, BarChart3, CalendarDays,
  ChevronDown, ChevronLeft, ChevronRight, Download, Package, RefreshCw, Search,
  Sparkles, TrendingUp, X,
} from "lucide-react";
import {
  generateForecasts, listForecasts, listInventorySummary, listProducts, listSales,
} from "../services/business";
import type {
  ForecastRecord, InventorySummaryRecord, ProductRecord, SaleRecord,
} from "../services/business";
import ProductSymbolIcon from "../components/ProductSymbol";
import { productSymbol } from "../services/productSymbols";
import { useGeneralSettings } from "../services/generalSettings";
import { formatAppDate } from "../services/generalSettings";

type Props = { onNotify: (message: string) => void; canGenerate?: boolean };
type ForecastStatus = "High Demand" | "Normal" | "Low Demand";
type ForecastProduct = {
  product: ProductRecord | undefined;
  productId: number;
  forecastRows: ForecastRecord[];
  forecastTotal: number;
  dailyForecast: number;
  currentStock: number;
  dailySales: number;
  recommendedStock: number;
  status: ForecastStatus;
};
type TrendPoint = { date: string; actual: number | null; predicted: number | null };

const DAY_MS = 24 * 60 * 60 * 1000;
const CATEGORY_COLORS = ["#079b54", "#3988f6", "#ffab17", "#ff625d", "#a957e9", "#94a3b8"];

function dayKey(value: string | Date): string {
  if (typeof value === "string") return value.slice(0, 10);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localDate(value: string): Date {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return new Date(year, month - 1, day);
}

function addDays(value: string, count: number): string {
  const date = localDate(value);
  date.setDate(date.getDate() + count);
  return dayKey(date);
}

function numeric(value: number | string | null | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatNumber(value: number, maximumFractionDigits = 0): string {
  return value.toLocaleString(undefined, { maximumFractionDigits });
}

function formatShortDate(value: string): string {
  return formatAppDate(value);
}

function linePath(values: Array<number | null>, x: (index: number) => number, y: (value: number) => number): string {
  let open = false;
  return values.reduce<string>((path, value, index) => {
    if (value === null) {
      open = false;
      return path;
    }
    const command = open ? "L" : "M";
    open = true;
    return `${path}${command}${x(index).toFixed(1)},${y(value).toFixed(1)} `;
  }, "");
}

function MiniTrend({ values, status }: { values: number[]; status: ForecastStatus }) {
  if (values.length < 2) return <span aria-label="Forecast trend unavailable">—</span>;
  const width = 39;
  const height = 23;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low || 1;
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * (width - 2) + 1;
    const y = height - 2 - ((value - low) / span) * (height - 5);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const color = status === "High Demand" ? "#ef4444" : status === "Low Demand" ? "#3988f6" : "#10a45b";
  return <svg className="forecast-mini-trend" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${status} forecast trend`}>
    <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" />
    {points.split(" ").map((point, index) => {
      const [cx, cy] = point.split(",");
      return <circle key={index} cx={cx} cy={cy} r="1.3" fill={color} />;
    })}
  </svg>;
}

function DemandTrendChart({ points }: { points: TrendPoint[] }) {
  const width = 600;
  const height = 150;
  const padding = { top: 11, right: 12, bottom: 24, left: 42 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(1, ...points.flatMap((point) => [point.actual ?? 0, point.predicted ?? 0]));
  const x = (index: number) => padding.left + (points.length <= 1 ? chartWidth / 2 : (index / (points.length - 1)) * chartWidth);
  const y = (value: number) => padding.top + chartHeight - (value / maxValue) * chartHeight;
  const actual = points.map((point) => point.actual);
  const predicted = points.map((point) => point.predicted);
  const labels = [0, Math.floor((points.length - 1) / 3), Math.floor(2 * (points.length - 1) / 3), points.length - 1]
    .filter((index, position, all) => points[index] && all.indexOf(index) === position);

  if (!points.length) return <div className="forecast-empty" role="status">No saved forecast or sales history is available for this period.</div>;
  return <svg className="forecast-trend-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Actual and predicted daily demand trend">
    {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
      const lineY = padding.top + chartHeight * fraction;
      return <g key={fraction}>
        <line x1={padding.left} x2={width - padding.right} y1={lineY} y2={lineY} stroke="#edf1f5" />
        <text x={padding.left - 7} y={lineY + 3} textAnchor="end">{formatNumber(maxValue * (1 - fraction))}</text>
      </g>;
    })}
    <path d={linePath(actual, x, y)} fill="none" stroke="#0aa45a" strokeWidth="2" />
    <path d={linePath(predicted, x, y)} fill="none" stroke="#3987ff" strokeWidth="2" />
    {points.map((point, index) => point.actual !== null
      ? <circle key={`actual-${point.date}`} cx={x(index)} cy={y(point.actual)} r="2" fill="#fff" stroke="#0aa45a" strokeWidth="1.5"><title>{`${formatShortDate(point.date)} actual: ${formatNumber(point.actual, 1)}`}</title></circle>
      : null)}
    {points.map((point, index) => point.predicted !== null
      ? <circle key={`predicted-${point.date}`} cx={x(index)} cy={y(point.predicted)} r="2" fill="#fff" stroke="#3987ff" strokeWidth="1.5"><title>{`${formatShortDate(point.date)} forecast: ${formatNumber(point.predicted, 1)}`}</title></circle>
      : null)}
    {labels.map((index) => <text key={index} x={x(index)} y={height - 5} textAnchor="middle">{formatShortDate(points[index].date)}</text>)}
  </svg>;
}

function CategoryDemandChart({ rows }: { rows: Array<{ category: string; current: number; next: number }> }) {
  const width = 350;
  const height = 150;
  const padding = { top: 17, right: 9, bottom: 27, left: 38 };
  const chartHeight = height - padding.top - padding.bottom;
  const max = Math.max(1, ...rows.flatMap((row) => [row.current, row.next]));
  const groupWidth = (width - padding.left - padding.right) / Math.max(rows.length, 1);
  const barWidth = Math.min(13, groupWidth * 0.28);
  if (!rows.length) return <div className="forecast-empty" role="status">No category forecast data is available.</div>;
  return <svg className="forecast-category-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Current month actual sales and next month forecast by category">
    {[0, 0.5, 1].map((fraction) => {
      const gridY = padding.top + chartHeight * fraction;
      return <g key={fraction}>
        <line x1={padding.left} x2={width - padding.right} y1={gridY} y2={gridY} stroke="#edf1f5" />
        <text x={padding.left - 5} y={gridY + 3} textAnchor="end">{formatNumber(max * (1 - fraction))}</text>
      </g>;
    })}
    {rows.map((row, index) => {
      const center = padding.left + (index + 0.5) * groupWidth;
      const currentHeight = (row.current / max) * chartHeight;
      const nextHeight = (row.next / max) * chartHeight;
      return <g key={row.category}>
        <rect x={center - barWidth - 1} y={padding.top + chartHeight - currentHeight} width={barWidth} height={currentHeight} rx="2" fill="#9be4bb"><title>{`${row.category}: ${formatNumber(row.current, 1)} actual units this month`}</title></rect>
        <rect x={center + 1} y={padding.top + chartHeight - nextHeight} width={barWidth} height={nextHeight} rx="2" fill="#0aa45a"><title>{`${row.category}: ${formatNumber(row.next, 1)} forecast units next month`}</title></rect>
        <text x={center} y={height - 7} textAnchor="middle">{row.category.length > 10 ? `${row.category.slice(0, 9)}…` : row.category}</text>
      </g>;
    })}
  </svg>;
}

function donutGradient(parts: Array<{ value: number; color: string }>): string {
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  if (!total) return "conic-gradient(#e8edf2 0 100%)";
  let cursor = 0;
  const stops = parts.map((part) => {
    const end = cursor + (part.value / total) * 100;
    const stop = `${part.color} ${cursor.toFixed(2)}% ${end.toFixed(2)}%`;
    cursor = end;
    return stop;
  });
  return `conic-gradient(${stops.join(", ")})`;
}

export default function DemandForecast({ onNotify, canGenerate = false }: Props) {
  const { items_per_page: pageSize } = useGeneralSettings();
  const [forecasts, setForecasts] = useState<ForecastRecord[]>([]);
  const [products, setProducts] = useState<ProductRecord[]>([]);
  const [inventory, setInventory] = useState<InventorySummaryRecord[]>([]);
  const [sales, setSales] = useState<SaleRecord[]>([]);
  const [selectedProduct, setSelectedProduct] = useState("");
  const [period, setPeriod] = useState("30");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [pageSize]);
  const [selectedDetails, setSelectedDetails] = useState<ForecastProduct | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

  const productById = useMemo(() => new Map(products.map((product) => [product.product_id, product])), [products]);
  const stockById = useMemo(() => new Map(inventory.map((row) => [row.product_id, numeric(row.quantity)])), [inventory]);
  const today = dayKey(new Date());
  const requestedDays = period === "all" ? null : Number(period);

  async function refresh(productId?: number): Promise<boolean> {
    setLoading(true);
    setError("");
    try {
      const [productRows, inventoryRows, salesRows] = await Promise.all([
        listProducts(), listInventorySummary(), listSales(),
      ]);
      // The unfiltered endpoint caps at 500 rows; load by product to retain each full forecast horizon.
      const forecastRows = productId !== undefined
        ? await listForecasts(productId)
        : (await Promise.all(productRows.map((product) => listForecasts(product.product_id)))).flat();
      setForecasts(forecastRows);
      setProducts(productRows);
      setInventory(inventoryRows);
      setSales(salesRows);
      return true;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not load demand forecast data.";
      setError(message);
      onNotify(message);
      return false;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  const futureForecasts = useMemo(() => forecasts.filter((record) => dayKey(record.forecast_date) >= today), [forecasts, today]);
  const periodForecasts = useMemo(() => {
    if (!requestedDays) return futureForecasts;
    const endDay = addDays(today, requestedDays - 1);
    return futureForecasts.filter((record) => dayKey(record.forecast_date) <= endDay);
  }, [futureForecasts, requestedDays, today]);
  const forecastDayCount = new Set(periodForecasts.map((record) => dayKey(record.forecast_date))).size;
  const periodDays = requestedDays ?? Math.max(forecastDayCount, 1);
  const periodEnd = periodForecasts.reduce((latest, record) => {
    const date = dayKey(record.forecast_date);
    return date > latest ? date : latest;
  }, today);
  const salesStart = requestedDays ? addDays(today, -(requestedDays - 1)) : (sales.map((sale) => dayKey(sale.sold_at)).sort()[0] ?? today);
  const periodSales = useMemo(() => sales.filter((sale) => {
    const day = dayKey(sale.sold_at);
    return day >= salesStart && day <= today;
  }), [sales, salesStart, today]);
  const actualDemandTotal = periodSales.reduce((sum, sale) => sum + numeric(sale.quantity), 0);

  const forecastProducts = useMemo(() => {
    const rowsByProduct = new Map<number, ForecastRecord[]>();
    periodForecasts.forEach((record) => {
      const rows = rowsByProduct.get(record.product_id) ?? [];
      rows.push(record);
      rowsByProduct.set(record.product_id, rows);
    });
    const dailyDemand = [...rowsByProduct.values()].map((rows) =>
      rows.reduce((sum, record) => sum + numeric(record.predicted_demand), 0) / periodDays);
    const meanDailyDemand = dailyDemand.length ? dailyDemand.reduce((sum, value) => sum + value, 0) / dailyDemand.length : 0;

    return [...rowsByProduct.entries()].map(([productId, rows]) => {
      const forecastTotal = rows.reduce((sum, record) => sum + numeric(record.predicted_demand), 0);
      const dailyForecast = forecastTotal / periodDays;
      const status: ForecastStatus = meanDailyDemand === 0
        ? "Normal"
        : dailyForecast >= meanDailyDemand * 1.25
          ? "High Demand"
          : dailyForecast <= meanDailyDemand * 0.75
            ? "Low Demand"
            : "Normal";
      const actualQuantity = periodSales.filter((sale) => sale.product_id === productId)
        .reduce((sum, sale) => sum + numeric(sale.quantity), 0);
      const sorted = [...rows].sort((a, b) => dayKey(a.forecast_date).localeCompare(dayKey(b.forecast_date)));
      const buffer = dailyForecast * 7;
      return {
        product: productById.get(productId),
        productId,
        forecastRows: sorted,
        forecastTotal,
        dailyForecast,
        currentStock: stockById.get(productId) ?? 0,
        dailySales: actualQuantity / periodDays,
        recommendedStock: Math.ceil(forecastTotal + buffer),
        status,
      };
    }).sort((a, b) => (a.product?.name ?? `Product #${a.productId}`).localeCompare(b.product?.name ?? `Product #${b.productId}`));
  }, [periodForecasts, periodDays, periodSales, productById, stockById]);

  const filteredProducts = useMemo(() => forecastProducts.filter((row) => {
    const name = row.product?.name ?? `Product #${row.productId}`;
    const sku = row.product?.sku ?? "";
    const matchesSearch = `${name} ${sku}`.toLowerCase().includes(search.trim().toLowerCase());
    const matchesCategory = !categoryFilter || row.product?.category === categoryFilter;
    const matchesStatus = !statusFilter || row.status === statusFilter;
    return matchesSearch && matchesCategory && matchesStatus;
  }), [forecastProducts, categoryFilter, search, statusFilter]);
  const pageCount = Math.max(1, Math.ceil(filteredProducts.length / pageSize));
  const visibleProducts = filteredProducts.slice((page - 1) * pageSize, page * pageSize);
  const totalDemand = periodForecasts.reduce((sum, record) => sum + numeric(record.predicted_demand), 0);
  const highDemandCount = forecastProducts.filter((row) => row.status === "High Demand").length;
  const lowDemandCount = forecastProducts.filter((row) => row.status === "Low Demand").length;

  const actualByDay = useMemo(() => {
    const result = new Map<string, number>();
    periodSales.forEach((sale) => {
      const day = dayKey(sale.sold_at);
      result.set(day, (result.get(day) ?? 0) + numeric(sale.quantity));
    });
    return result;
  }, [periodSales]);
  const predictedByDay = useMemo(() => {
    const result = new Map<string, number>();
    periodForecasts.forEach((record) => {
      const day = dayKey(record.forecast_date);
      result.set(day, (result.get(day) ?? 0) + numeric(record.predicted_demand));
    });
    return result;
  }, [periodForecasts]);
  const trendPoints = useMemo<TrendPoint[]>(() => {
    const forecastEnd = periodForecasts.reduce((latest, record) => {
      const date = dayKey(record.forecast_date);
      return date > latest ? date : latest;
    }, today);
    const start = salesStart;
    const totalDays = Math.max(1, Math.round((localDate(forecastEnd).getTime() - localDate(start).getTime()) / DAY_MS) + 1);
    const sampleEvery = Math.max(1, Math.ceil(totalDays / 28));
    const days: string[] = [];
    for (let offset = 0; offset < totalDays; offset += sampleEvery) days.push(addDays(start, offset));
    if (days[days.length - 1] !== forecastEnd) days.push(forecastEnd);
    return days.map((date) => ({
      date,
      actual: date <= today ? (actualByDay.get(date) ?? 0) : null,
      predicted: date >= today && predictedByDay.has(date) ? predictedByDay.get(date)! : null,
    }));
  }, [actualByDay, periodForecasts, predictedByDay, salesStart, today]);

  const categories = useMemo(() => {
    const currentMonthStart = `${today.slice(0, 7)}-01`;
    const nextMonthStart = new Date(localDate(currentMonthStart).getFullYear(), localDate(currentMonthStart).getMonth() + 1, 1);
    const nextMonthKey = dayKey(nextMonthStart);
    const nextMonthEnd = dayKey(new Date(nextMonthStart.getFullYear(), nextMonthStart.getMonth() + 1, 0));
    const currentByCategory = new Map<string, number>();
    const nextByCategory = new Map<string, number>();
    sales.filter((sale) => dayKey(sale.sold_at) >= currentMonthStart && dayKey(sale.sold_at) <= today).forEach((sale) => {
      const category = productById.get(sale.product_id)?.category ?? "Other";
      currentByCategory.set(category, (currentByCategory.get(category) ?? 0) + numeric(sale.quantity));
    });
    futureForecasts.filter((record) => {
      const date = dayKey(record.forecast_date);
      return date >= nextMonthKey && date <= nextMonthEnd;
    }).forEach((record) => {
      const category = productById.get(record.product_id)?.category ?? "Other";
      nextByCategory.set(category, (nextByCategory.get(category) ?? 0) + numeric(record.predicted_demand));
    });
    return [...new Set([...currentByCategory.keys(), ...nextByCategory.keys()])]
      .map((category) => ({
        category,
        current: currentByCategory.get(category) ?? 0,
        next: nextByCategory.get(category) ?? 0,
      }))
      .sort((a, b) => b.next - a.next || b.current - a.current)
      .slice(0, 6);
  }, [futureForecasts, productById, sales, today]);

  const distribution = useMemo(() => {
    const totals = new Map<string, number>();
    periodForecasts.forEach((record) => {
      const category = productById.get(record.product_id)?.category ?? "Other";
      totals.set(category, (totals.get(category) ?? 0) + numeric(record.predicted_demand));
    });
    const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, 5).map(([category, value], index) => ({
      category, value, color: CATEGORY_COLORS[index],
    }));
    if (sorted.length > 5) top.push({
      category: "Other",
      value: sorted.slice(5).reduce((sum, entry) => sum + entry[1], 0),
      color: CATEGORY_COLORS[5],
    });
    return top;
  }, [periodForecasts, productById]);
  const gradient = donutGradient(distribution);

  async function runForecast() {
    setGenerating(true);
    setError("");
    try {
      await generateForecasts(today, 30, selectedProduct ? [Number(selectedProduct)] : undefined);
      const refreshed = await refresh(selectedProduct ? Number(selectedProduct) : undefined);
      onNotify(refreshed ? "Demand forecasts generated and saved." : "Forecasts were generated, but the list could not be refreshed.");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not generate forecasts.";
      setError(message);
      onNotify(message);
    } finally {
      setGenerating(false);
    }
  }

  function exportRows() {
    const headers = ["Product", "SKU", "Category", "Current stock", "Average daily sales", "Forecast demand", "Recommended stock", "Status"];
    const rows = filteredProducts.map((row) => [
      row.product?.name ?? `Product #${row.productId}`, row.product?.sku ?? "",
      row.product?.category ?? "Unknown", row.currentStock, row.dailySales,
      row.forecastTotal, row.recommendedStock, row.status,
    ]);
    const csv = [headers, ...rows].map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "wastewise-demand-forecast.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  function changePeriod(value: string) {
    setPeriod(value);
    setPage(1);
  }

  const periodLabel = period === "all" ? "All saved dates" : `Next ${period} Days`;
  const trendCategory = (row: ForecastProduct) => row.forecastRows.map((record) => numeric(record.predicted_demand));
  const dateRange = `${formatShortDate(salesStart)} - ${formatShortDate(periodEnd)}`;

  return (
    <main className="page-content forecast-page">
      <header className="forecast-banner">
        <div className="forecast-banner-copy">
          <h1>Demand Forecast</h1>
          <p>Predict future demand and plan your inventory smarter</p>
        </div>
        <div className="forecast-banner-art" aria-hidden="true">
          <span>🥕</span><span>🛒</span><span>🌿</span>
          <div className="forecast-art-bars"><i /><i /><i /><i /><i /><TrendingUp size={37} /></div>
        </div>
        <div className="forecast-banner-controls">
          <label>
            <select aria-label="Filter forecasts by product" value={selectedProduct} onChange={(event) => {
              const value = event.target.value;
              setSelectedProduct(value);
              setPage(1);
              void refresh(value ? Number(value) : undefined);
            }}>
              <option value="">All Products</option>
              {products.map((product) => <option key={product.product_id} value={product.product_id}>{product.name}</option>)}
            </select>
            <ChevronDown size={13} />
          </label>
          <span className="forecast-date"><CalendarDays size={14} />{dateRange}</span>
          <button type="button" className="forecast-export" onClick={() => void refresh(selectedProduct ? Number(selectedProduct) : undefined)} disabled={loading} aria-label="Refresh demand forecast data">
            <RefreshCw size={14} /> Refresh
          </button>
          {canGenerate && <button type="button" className="forecast-export" onClick={() => void runForecast()} disabled={generating}>
            <Sparkles size={14} /> {generating ? "Generating…" : "Generate Forecast"}
          </button>}
        </div>
      </header>

      {error && <div className="error-banner" role="alert"><AlertTriangle size={18} />{error}</div>}

      <section className="forecast-stats" aria-label="Demand forecast summary">
        <article className="forecast-stat-card">
          <div className="forecast-stat-icon green"><BarChart3 size={27} /></div>
          <div className="forecast-stat-content"><span>Total Forecasted Demand</span><div><strong>{loading ? "—" : formatNumber(totalDemand, 1)}</strong><small>units</small></div><p>{period === "all" ? "Across saved forecast dates" : `Next ${period} days`}</p></div>
        </article>
        <article className="forecast-stat-card">
          <div className="forecast-stat-icon blue"><TrendingUp size={27} /></div>
          <div className="forecast-stat-content"><span>Average Daily Demand</span><div><strong>{loading ? "—" : formatNumber(totalDemand / periodDays, 1)}</strong><small>units</small></div><p>Across all forecast products</p></div>
        </article>
        <article className="forecast-stat-card">
          <div className="forecast-stat-icon purple"><Package size={27} /></div>
          <div className="forecast-stat-content"><span>Products Forecasted</span><div><strong>{loading ? "—" : forecastProducts.length}</strong></div><p>Products with saved predictions</p></div>
        </article>
        <article className="forecast-stat-card">
          <div className="forecast-stat-icon orange"><ArrowUpRight size={27} /></div>
          <div className="forecast-stat-content"><span>High Demand Products</span><div><strong>{loading ? "—" : highDemandCount}</strong></div><p>Above the portfolio forecast average</p></div>
        </article>
        <article className="forecast-stat-card">
          <div className="forecast-stat-icon red"><ArrowDown size={27} /></div>
          <div className="forecast-stat-content"><span>Low Demand Products</span><div><strong>{loading ? "—" : lowDemandCount}</strong></div><p>Below the portfolio forecast average</p></div>
        </article>
      </section>

      <section className="forecast-charts" aria-label="Demand forecast charts">
        <article className="forecast-chart-card forecast-trend-card">
          <div className="forecast-chart-heading"><h2>Demand Forecast Trend</h2><span className="forecast-chart-period">{periodLabel}</span></div>
          <div className="forecast-chart-legend"><span><i className="actual-dot" />Actual Demand</span><span><i className="predicted-dot" />Predicted Demand</span></div>
          {loading ? <div className="forecast-empty" role="status">Loading demand trend…</div> : <DemandTrendChart points={trendPoints} />}
          {!loading && actualDemandTotal === 0 && <span className="forecast-chart-note">No sales recorded in this period</span>}
        </article>
        <article className="forecast-chart-card forecast-category-card">
          <div className="forecast-chart-heading"><h2>Forecasted Demand by Category</h2></div>
          <div className="forecast-chart-legend"><span><i className="current-dot" />Current Month</span><span><i className="next-dot" />Next Month (Forecast)</span></div>
          {loading ? <div className="forecast-empty" role="status">Loading category forecast…</div> : <CategoryDemandChart rows={categories} />}
        </article>
        <article className="forecast-chart-card forecast-distribution-card">
          <div className="forecast-chart-heading"><h2>Forecast Distribution</h2></div>
          {loading ? <div className="forecast-empty" role="status">Loading forecast distribution…</div> : distribution.length === 0
            ? <div className="forecast-empty" role="status">No category forecast data is available.</div>
            : <div className="forecast-distribution-content">
              <div className="forecast-donut" style={{ background: gradient }} role="img" aria-label="Forecast demand distribution by category">
                <div><strong>{formatNumber(totalDemand, 0)}</strong><span>Units</span></div>
              </div>
              <ul className="forecast-legend">
                {distribution.map((item) => <li key={item.category}><span style={{ background: item.color }} /><span>{item.category}</span><b>{totalDemand ? `${Math.round((item.value / totalDemand) * 100)}%` : "0%"}</b></li>)}
              </ul>
            </div>}
        </article>
      </section>

      <section className="forecast-table-panel" aria-label="Product forecasts">
        <div className="forecast-toolbar">
          <label className="forecast-search"><Search size={15} /><input aria-label="Search forecast products" placeholder="Search products by name or SKU..." value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} /></label>
          <select aria-label="Filter forecasts by category" value={categoryFilter} onChange={(event) => { setCategoryFilter(event.target.value); setPage(1); }}>
            <option value="">All Categories</option>
            {[...new Set(products.map((product) => product.category))].sort().map((category) => <option key={category} value={category}>{category}</option>)}
          </select>
          <select aria-label="Filter forecasts by status" value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }}>
            <option value="">All Forecast Status</option><option value="High Demand">High Demand</option><option value="Normal">Normal</option><option value="Low Demand">Low Demand</option>
          </select>
          <select className="forecast-period-select" aria-label="Forecast period" value={period} onChange={(event) => changePeriod(event.target.value)}>
            <option value="7">Next 7 Days</option><option value="30">Next 30 Days</option><option value="90">Next 90 Days</option><option value="all">All Saved Dates</option>
          </select>
          <button type="button" className="forecast-export" onClick={exportRows} disabled={loading || filteredProducts.length === 0}><Download size={14} /> Export</button>
        </div>
        <div className="forecast-table-scroll">
          <table className="forecast-table">
            <thead><tr>
              <th>#</th><th>Product</th><th>Category</th><th>Current Stock</th><th>Avg Daily Sales</th>
              <th>Forecast ({period === "all" ? "Saved Dates" : `Next ${period} Days`})</th><th>Recommended Stock</th><th>Forecast Trend</th><th>Status</th><th>Action</th>
            </tr></thead>
            <tbody>
              {loading && <tr><td className="forecast-empty" colSpan={10}>Loading forecasts…</td></tr>}
              {!loading && error && <tr><td className="forecast-empty" colSpan={10}>Forecast data could not be loaded.</td></tr>}
              {!loading && !error && visibleProducts.map((row, index) => (
                <tr key={row.productId}>
                  <td>{(page - 1) * pageSize + index + 1}</td>
                  <td><span className="forecast-product-emoji" aria-hidden="true"><ProductSymbolIcon symbol={productSymbol(row.product?.name ?? `Product #${row.productId}`, row.product?.category)} /></span><span className="forecast-product-name">{row.product?.name ?? `Product #${row.productId}`}</span></td>
                  <td>{row.product?.category ?? "Unknown"}</td>
                  <td>{formatNumber(row.currentStock, 1)}</td>
                  <td>{formatNumber(row.dailySales, 1)}</td>
                  <td>{formatNumber(row.forecastTotal, 1)}</td>
                  <td title="Forecast demand plus a seven-day forecast buffer">{formatNumber(row.recommendedStock)}</td>
                  <td><MiniTrend values={trendCategory(row)} status={row.status} /></td>
                  <td><span className={`forecast-status ${row.status.toLowerCase().replace(" ", "-")}`}>{row.status}</span></td>
                  <td><button type="button" className="forecast-view-button" onClick={() => setSelectedDetails(row)} aria-label={`View ${row.product?.name ?? `Product ${row.productId}`} forecast details`}>View</button></td>
                </tr>
              ))}
              {!loading && !error && filteredProducts.length === 0 && <tr><td className="forecast-empty" colSpan={10}>{forecastProducts.length ? "No products match these filters." : "No saved forecasts found for this period."}</td></tr>}
            </tbody>
          </table>
        </div>
        <footer className="forecast-table-footer">
          <span>{filteredProducts.length ? `Showing ${(page - 1) * pageSize + 1} to ${Math.min(page * pageSize, filteredProducts.length)} of ${filteredProducts.length} products` : "Showing 0 products"}</span>
          <nav aria-label="Forecast table pages">
            <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1} aria-label="Previous page"><ChevronLeft size={15} /></button>
            {Array.from({ length: pageCount }, (_, index) => index + 1).slice(Math.max(0, page - 2), Math.max(0, page - 2) + 4).map((pageNumber) => (
              <button type="button" key={pageNumber} className={page === pageNumber ? "current" : ""} onClick={() => setPage(pageNumber)} aria-current={page === pageNumber ? "page" : undefined}>{pageNumber}</button>
            ))}
            <button type="button" onClick={() => setPage((current) => Math.min(pageCount, current + 1))} disabled={page >= pageCount} aria-label="Next page"><ChevronRight size={15} /></button>
          </nav>
        </footer>
      </section>

      {selectedDetails && <div className="forecast-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedDetails(null); }}>
        <section className="forecast-modal" role="dialog" aria-modal="true" aria-labelledby="forecast-detail-title">
          <div className="forecast-modal-heading">
            <div className="forecast-product-avatar"><ProductSymbolIcon symbol={productSymbol(selectedDetails.product?.name ?? `Product #${selectedDetails.productId}`, selectedDetails.product?.category)} /></div>
            <div><h2 id="forecast-detail-title">{selectedDetails.product?.name ?? `Product #${selectedDetails.productId}`}</h2><p>{selectedDetails.product?.sku ?? "Forecast details"} · {selectedDetails.product?.category ?? "Unknown category"}</p></div>
            <button type="button" onClick={() => setSelectedDetails(null)} aria-label="Close forecast details"><X size={18} /></button>
          </div>
          <div className="forecast-detail-grid">
            <div><span>Current stock</span><strong>{formatNumber(selectedDetails.currentStock, 1)} {selectedDetails.product?.unit ?? "units"}</strong></div>
            <div><span>Average daily sales</span><strong>{formatNumber(selectedDetails.dailySales, 1)} {selectedDetails.product?.unit ?? "units"}</strong></div>
            <div><span>Forecast demand</span><strong>{formatNumber(selectedDetails.forecastTotal, 1)} {selectedDetails.product?.unit ?? "units"}</strong></div>
            <div><span>Suggested stock incl. 7-day buffer</span><strong>{formatNumber(selectedDetails.recommendedStock)} {selectedDetails.product?.unit ?? "units"}</strong></div>
            <div><span>Forecast range</span><strong>{selectedDetails.forecastRows.length ? `${formatShortDate(dayKey(selectedDetails.forecastRows[0].forecast_date))} – ${formatShortDate(dayKey(selectedDetails.forecastRows[selectedDetails.forecastRows.length - 1].forecast_date))}` : "—"}</strong></div>
            <div><span>Model version</span><strong>{selectedDetails.forecastRows[0]?.model_version ?? "Unavailable"}</strong></div>
          </div>
          <div className="forecast-detail-status"><TrendingUp size={15} /> Forecast status: <b>{selectedDetails.status}</b></div>
          <button type="button" className="forecast-modal-done" onClick={() => setSelectedDetails(null)}>Done</button>
        </section>
      </div>}
    </main>
  );
}
