import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  BarChart3,
  Lightbulb,
  Leaf,
  Package,
  RefreshCw,
  ShoppingCart,
  Trash2,
} from "lucide-react";
import {
  loadDashboardHighlights,
  loadDashboardData,
  markRecommendationApplied,
} from "../services/dashboard";
import ProductSymbolIcon from "../components/ProductSymbol";
import { productSymbol } from "../services/productSymbols";
import { formatAppDate, formatAppDateTime } from "../services/generalSettings";
import type {
  DashboardPayload,
  DateRange,
} from "../services/dashboard";

type DashboardProps = { userName: string; onNotify: (message: string) => void };

const chartColors = ["#20ad61", "#4294fa", "#8795a5", "#ffad22", "#a56be0", "#e56b6b"];

function localDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateRange(selection: string): DateRange {
  const end = new Date();
  const start = new Date(end);
  if (selection === "7" || selection === "30" || selection === "365") {
    start.setDate(start.getDate() - (Number(selection) - 1));
  } else if (selection === "month") {
    start.setDate(1);
  } else if (selection === "3m" || selection === "6m") {
    start.setMonth(start.getMonth() - Number(selection.slice(0, -1)) + 1, 1);
    start.setDate(1);
  } else {
    start.setMonth(0, 1);
  }
  return { start_date: localDate(start), end_date: localDate(end) };
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(value);
}

function formatCurrency(value: number, currency = "INR"): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
}

function ProductName({ name, category }: { name: string; category?: string }) {
  return <span className="table-product"><i className="product-symbol" aria-hidden="true"><ProductSymbolIcon symbol={productSymbol(name, category)} /></i><span>{name}</span></span>;
}

function formatDate(value: string): string {
  return formatAppDate(value);
}

function quantitySummary(values: { unit: string; quantity: number }[]): { value: string; note: string } {
  if (values.length === 0) return { value: "0", note: "No available quantities" };
  if (values.length === 1) return { value: formatNumber(values[0].quantity), note: values[0].unit };
  return {
    value: "Mixed",
    note: values.map(({ unit, quantity }) => `${formatNumber(quantity)} ${unit}`).join(" · "),
  };
}

function linePath(values: (number | null)[], max: number, width: number, height: number): string {
  const segments: string[] = [];
  let segment: string[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (segment.length) segments.push(segment.join(" "));
      segment = [];
      return;
    }
    const x = values.length < 2 ? width / 2 : (index / (values.length - 1)) * width;
    const y = height - (value / max) * height;
    segment.push(`${segment.length ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`);
  });
  if (segment.length) segments.push(segment.join(" "));
  return segments.join(" ");
}

function actionLabel(action: string, entityType: string, entityId: number | null): string {
  const readable = action.replace(/_/g, " ");
  return entityId === null ? readable : `${readable} · ${entityType} #${entityId}`;
}

export default function Dashboard({ userName, onNotify }: DashboardProps) {
  const [salesRange, setSalesRange] = useState("365");
  const [wasteRange, setWasteRange] = useState("6m");
  const [salesUnit, setSalesUnit] = useState("");
  const [wasteUnit, setWasteUnit] = useState("");
  const [payload, setPayload] = useState<DashboardPayload | null>(null);
  const [expiryAlerts, setExpiryAlerts] = useState<DashboardPayload["expiryAlerts"]>([]);
  const [recommendations, setRecommendations] = useState<DashboardPayload["recommendations"]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expiryAlertsLoading, setExpiryAlertsLoading] = useState(true);
  const [expiryAlertsError, setExpiryAlertsError] = useState("");
  const [recommendationsLoading, setRecommendationsLoading] = useState(true);
  const [recommendationsError, setRecommendationsError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [applyingRecommendation, setApplyingRecommendation] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    loadDashboardData(dateRange(salesRange), dateRange(wasteRange))
      .then((result) => { if (active) setPayload(result); })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Dashboard data could not be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [salesRange, wasteRange, refreshKey]);

  useEffect(() => {
    let active = true;
    setExpiryAlertsLoading(true);
    setExpiryAlertsError("");
    setRecommendationsLoading(true);
    setRecommendationsError("");
    const highlights = loadDashboardHighlights();
    void highlights.expiryAlerts.then((outcome) => {
      if (!active) return;
      if (outcome.status === "fulfilled") setExpiryAlerts(outcome.value);
      else setExpiryAlertsError(outcome.reason instanceof Error ? outcome.reason.message : "Expiry alerts could not be loaded.");
      setExpiryAlertsLoading(false);
    });
    void highlights.recommendations.then((outcome) => {
      if (!active) return;
      if (outcome.status === "fulfilled") setRecommendations(outcome.value);
      else setRecommendationsError(outcome.reason instanceof Error ? outcome.reason.message : "Recommendations could not be loaded.");
      setRecommendationsLoading(false);
    });
    return () => { active = false; };
  }, [refreshKey]);

  useEffect(() => {
    if (!payload) return;
    if (!payload.salesDemand.units.includes(salesUnit)) setSalesUnit(payload.salesDemand.units[0] ?? "");
    if (!payload.wasteTrend.units.includes(wasteUnit)) setWasteUnit(payload.wasteTrend.units[0] ?? "");
  }, [payload, salesUnit, wasteUnit]);

  async function applyRecommendation(recommendationId: number) {
    setApplyingRecommendation(recommendationId);
    try {
      await markRecommendationApplied(recommendationId);
      onNotify("Recommendation approved. No inventory or pricing was changed.");
      setRefreshKey((value) => value + 1);
    } catch (cause) {
      onNotify(cause instanceof Error ? cause.message : "Recommendation status could not be updated.");
    } finally {
      setApplyingRecommendation(null);
    }
  }

  const header = (
    <section className="dashboard-hero">
      <div className="dashboard-welcome">
        <span>Good day,</span>
        <h1>{userName} <Leaf className="name-leaf" size={26} fill="currentColor" /></h1>
        <p>Monitor recorded inventory, sales, and waste activity.</p>
      </div>
      <div className="earth-illustration" aria-hidden="true">
        <span className="earth-orbit orbit-one" /><span className="earth-orbit orbit-two" />
        <span className="earth">🌍</span><span className="earth-leaf leaf-a">🌿</span>
        <span className="earth-leaf leaf-b">🌱</span><span className="earth-leaf leaf-c">🍃</span>
        <span className="earth-spark spark-a">✦</span><span className="earth-spark spark-b">•</span>
      </div>
      <div className="impact-card">
        <strong>Recorded activity in selected period</strong>
        <div className="impact-stats">
          <div className="impact-stat"><span className="impact-icon"><ShoppingCart size={21} /></span><b>{payload?.summary.sales_record_count ?? "—"}<small>Sales records</small></b></div>
          <div className="impact-stat"><span className="impact-icon tree"><Trash2 size={21} /></span><b>{payload?.wasteTrend.actual_record_count ?? "—"}<small>Waste records</small></b></div>
        </div>
      </div>
    </section>
  );

  if (!payload) {
    return (
      <div className="dashboard-page">
        {header}
        <div className={`dashboard-state ${error ? "error" : ""}`} role={error ? "alert" : "status"}>
          {error ? <><b>Dashboard data is unavailable.</b><span>{error}</span><button onClick={() => setRefreshKey((value) => value + 1)}><RefreshCw size={14} /> Retry</button></> : <><RefreshCw size={16} className="dashboard-spinner" /><span>{loading ? "Loading dashboard data…" : "No dashboard data is available."}</span></>}
        </div>
      </div>
    );
  }

  const summary = payload.summary;
  const selectedSalesUnit = salesUnit || payload.salesDemand.units[0] || "";
  const selectedWasteUnit = wasteUnit || payload.wasteTrend.units[0] || "";
  const actualByDate = new Map(payload.salesDemand.actual_sales.filter((point) => point.unit === selectedSalesUnit).map((point) => [point.date, point.quantity]));
  const historyByDate = new Map(payload.salesDemand.imported_history.filter((point) => point.unit === selectedSalesUnit).map((point) => [point.date, point.quantity]));
  const predictedByDate = new Map(payload.salesDemand.predicted_demand.filter((point) => point.unit === selectedSalesUnit).map((point) => [point.date, point.quantity]));
  const rawSalesDates = [...new Set([...actualByDate.keys(), ...historyByDate.keys(), ...predictedByDate.keys()])].sort();
  const salesChart = aggregateSalesChart(rawSalesDates.map((date) => ({
    date,
    actual: actualByDate.get(date) ?? null,
    imported: historyByDate.get(date) ?? null,
    predicted: predictedByDate.get(date) ?? null,
  })), salesRange);
  const salesDates = salesChart.map((point) => point.date);
  const salesValues = salesChart.flatMap((point) => [point.actual, point.imported, point.predicted]).filter((value): value is number => value !== null);
  const salesMaximum = Math.max(1, ...salesValues) * 1.08;
  const chartTicks = [1, 0.75, 0.5, 0.25, 0].map((fraction) => Math.round(salesMaximum * fraction));
  const categoryTotal = payload.categoryDistribution.total_products;
  let donutStart = 0;
  const donutStops = payload.categoryDistribution.categories.map((category, index) => {
    const start = donutStart;
    donutStart += categoryTotal ? category.product_count / categoryTotal * 100 : 0;
    return `${chartColors[index % chartColors.length]} ${start}% ${donutStart}%`;
  });
  const donutStyle = { background: donutStops.length ? `conic-gradient(${donutStops.join(", ")})` : "#e5ebf0" };
  const actualWaste = payload.wasteTrend.actual.filter((point) => point.unit === selectedWasteUnit);
  const expiredWaste = payload.wasteTrend.expired_inventory.filter((point) => point.unit === selectedWasteUnit);
  const importedWaste = payload.wasteTrend.imported_history.filter((point) => point.unit === selectedWasteUnit);
  const wastePeriods = [...new Set([...actualWaste.map((point) => point.period), ...expiredWaste.map((point) => point.period), ...importedWaste.map((point) => point.period)])].sort();
  const wasteMaximum = Math.max(1, ...actualWaste.map((point) => point.quantity), ...expiredWaste.map((point) => point.quantity), ...importedWaste.map((point) => point.quantity)) * 1.15;
  const inventoryDisplay = quantitySummary(summary.available_inventory);
  const wasteDisplay = quantitySummary(summary.waste_quantity_by_unit);
  const salesLabelRange = `${formatDate(summary.start_date)} – ${formatDate(summary.end_date)}`;
  const importNotice = [summary.imported_catalog, payload.salesDemand.imported_history_status, payload.wasteTrend.imported_history_status]
    .find((source) => source.status === "unavailable");

  return (
    <div className="dashboard-page">
      {header}
      {error && <div className="dashboard-inline-error" role="alert">Refresh failed: {error}</div>}
      {importNotice && <div className="dashboard-inline-error" role="status">{importNotice.message}</div>}
      <section className="dashboard-kpis" aria-label="Store overview">
        <Kpi icon={<Package size={24} />} color="green" label="Total Products" value={formatNumber(summary.product_count)} note={summary.imported_product_count === null ? `${formatNumber(summary.active_product_count)} application products` : `${formatNumber(summary.imported_product_count)} CSV catalog · ${formatNumber(summary.user_product_count ?? 0)} application`} />
        <Kpi icon={<Package size={24} />} color="blue" label="Available Inventory" value={inventoryDisplay.value} note={inventoryDisplay.note} wrapNote={summary.available_inventory.length > 1} />
        <Kpi
          icon={<AlertTriangle size={25} />}
          color="amber"
          label="Expiry Alerts"
          value={formatNumber(summary.expired_batch_count + summary.expiring_soon_batch_count)}
          note={`${summary.application_expired_batch_count} live overdue · ${summary.application_expiring_soon_batch_count} live within ${summary.expiry_window_days}d\n${summary.snapshot_expired_batch_count} snapshot overdue · ${summary.snapshot_expiring_soon_batch_count} snapshot within ${summary.expiry_window_days}d`}
          wrapNote
        />
        <Kpi icon={<ShoppingCart size={24} />} color="purple" label="Sales Revenue" value={formatCurrency(summary.sales_revenue, summary.currency)} note={`${formatNumber(summary.sales_record_count)} records · ${salesLabelRange}`} />
        <Kpi icon={<Trash2 size={24} />} color="red" label="Waste Recorded" value={wasteDisplay.value} note={`${wasteDisplay.note} · ${formatCurrency(summary.waste_cost, summary.currency)} recorded cost`} wrapNote={summary.waste_quantity_by_unit.length > 1} />
      </section>

      <section className="dashboard-chart-grid">
        <article className="dashboard-card dashboard-chart-card sales-chart-card" aria-label="Sales vs Predicted Demand chart" title="Double-click or focus and press Enter to expand" tabIndex={0}>
          <CardTitle title="Sales vs Predicted Demand">
            <select aria-label="Sales chart range" value={salesRange} onChange={(event) => setSalesRange(event.target.value)}>
              <option value="365">Last Year</option><option value="30">Last 30 Days</option><option value="7">Last 7 Days</option><option value="month">This Month</option>
            </select>
          </CardTitle>
          <div className="chart-legend">
            <span><i className="legend-dot actual" />Actual sales</span>
            {payload.salesDemand.predicted_demand.length > 0 && <span><i className="legend-dot predicted" />{payload.salesDemand.prediction.source === "historical_average_baseline" ? "Historical baseline" : "Saved forecast"}</span>}
            {payload.salesDemand.imported_history.length > 0 && <span><i className="legend-dot imported" />Imported training history</span>}
            {payload.salesDemand.units.length > 1 && <select aria-label="Sales unit" value={selectedSalesUnit} onChange={(event) => setSalesUnit(event.target.value)}>{payload.salesDemand.units.map((unit) => <option key={unit}>{unit}</option>)}</select>}
          </div>
          {salesChart.length === 0 ? <ChartEmpty text="No actual sales, imported history, or saved forecasts for this unit and period." /> : (
            <div className="line-chart">
              <span className="axis-title">{selectedSalesUnit || "Units"}</span>
              <div className="line-chart-y">{chartTicks.map((tick, index) => <span key={index}>{formatNumber(tick)}</span>)}</div>
              <svg viewBox="0 0 360 105" preserveAspectRatio="none" role="img" aria-label={`Sales and demand series in ${selectedSalesUnit || "units"}`}>
                {[0, 1, 2, 3, 4].map((line) => <line key={line} x1="0" x2="360" y1={line * 26.25} y2={line * 26.25} stroke="#e8eef3" strokeWidth="1" />)}
                <path d={linePath(salesChart.map((point) => point.imported), salesMaximum, 360, 105)} fill="none" stroke="#8795a5" strokeDasharray="4 3" strokeWidth="2" vectorEffect="non-scaling-stroke" />
                <path d={linePath(salesChart.map((point) => point.predicted), salesMaximum, 360, 105)} fill="none" stroke="#4294fa" strokeWidth="2.2" vectorEffect="non-scaling-stroke" />
                <path d={linePath(salesChart.map((point) => point.actual), salesMaximum, 360, 105)} fill="none" stroke="#20ad61" strokeWidth="2.2" vectorEffect="non-scaling-stroke" />
                {salesChart.map((point, index) => point.actual === null ? null : (() => {
                  const x = salesChart.length < 2 ? 180 : (index / (salesChart.length - 1)) * 360;
                  const y = 105 - (point.actual / salesMaximum) * 105;
                  return <circle key={`actual-${point.date}`} cx={x} cy={y} r="2.8" fill="#fff" stroke="#20ad61" strokeWidth="1.8"><title>{`${point.date}: ${formatNumber(point.actual)} ${selectedSalesUnit} actual sales`}</title></circle>;
                })())}
              </svg>
              <div className="line-chart-x">{dateTicks(salesDates).map((date) => <span key={date}>{shortDate(date)}</span>)}</div>
            </div>
          )}
          <small className="chart-provenance">{payload.salesDemand.prediction.message} {payload.salesDemand.imported_history_status.status === "available" ? "Imported history is not application sales." : ""}</small>
        </article>

        <article className="dashboard-card dashboard-chart-card category-chart-card" aria-label="Product Category Mix chart" title="Double-click or focus and press Enter to expand" tabIndex={0}>
          <CardTitle title="Product Category Mix" />
          <div className="donut-content">
            <div className="donut-chart" style={donutStyle}><div><b>{formatNumber(categoryTotal)}</b><span>Catalog products</span></div></div>
            <div className="donut-legend">
              {payload.categoryDistribution.categories.length === 0 ? <p className="chart-empty-inline">No products in the catalog.</p> : payload.categoryDistribution.categories.map((item, index) => (
                <div className="donut-legend-row" key={item.category}><i className="legend-dot" style={{ backgroundColor: chartColors[index % chartColors.length] }} /><span>{item.category}</span><b>{formatNumber(item.product_share_percent)}%</b></div>
              ))}
            </div>
          </div>
          <small className="chart-provenance">Share is by distinct catalog product; stock quantities are live-only.</small>
        </article>

        <article className="dashboard-card dashboard-chart-card waste-chart-card" aria-label="Waste Trend chart" title="Double-click or focus and press Enter to expand" tabIndex={0}>
          <CardTitle title="Waste Trend">
            <select aria-label="Waste chart range" value={wasteRange} onChange={(event) => setWasteRange(event.target.value)}>
              <option value="7">Last 7 Days</option><option value="6m">Last 6 Months</option><option value="year">This Year</option><option value="3m">Last 3 Months</option>
            </select>
          </CardTitle>
          <div className="chart-legend">
            <span><i className="legend-dot actual" />Recorded waste</span>
            <span className="waste-record-count">{formatNumber(payload.wasteTrend.actual_record_count)} records</span>
            {expiredWaste.length > 0 && <span><i className="legend-dot expired" />Expired inventory</span>}
            {importedWaste.length > 0 && <span><i className="legend-dot imported" />Training history · not actual waste</span>}
            {payload.wasteTrend.units.length > 1 && <select aria-label="Waste unit" value={selectedWasteUnit} onChange={(event) => setWasteUnit(event.target.value)}>{payload.wasteTrend.units.map((unit) => <option key={unit}>{unit}</option>)}</select>}
          </div>
          {wastePeriods.length === 0 ? <ChartEmpty text="No recorded or imported waste history for this period." /> : (
            <div className="bar-chart">
              <span className="axis-title">{selectedWasteUnit || "Quantity"}</span>
              <div className="bar-chart-y"><span>{formatNumber(wasteMaximum)}</span><span>{formatNumber(wasteMaximum * .75)}</span><span>{formatNumber(wasteMaximum * .5)}</span><span>{formatNumber(wasteMaximum * .25)}</span><span>0</span></div>
              <div className="bar-plot"><div className="bar-gridlines"><i /><i /><i /><i /><i /></div>
                {wastePeriods.map((period) => {
                  const actual = actualWaste.find((point) => point.period === period)?.quantity ?? 0;
                  const expired = expiredWaste.find((point) => point.period === period)?.quantity ?? 0;
                  const imported = importedWaste.find((point) => point.period === period)?.quantity ?? 0;
                  const peak = Math.max(actual, expired, imported);
                  return <div className="bar-column" key={period} title={`${period}: recorded ${formatNumber(actual)}, expired inventory ${formatNumber(expired)}, imported training ${formatNumber(imported)}`}><b className="waste-value-label" aria-label={`${period}: ${formatNumber(actual)} ${selectedWasteUnit} recorded waste`} style={{ bottom: `calc(${peak / wasteMaximum * 100}% + 3px)` }}>{formatNumber(actual)}</b><div className="waste-bars"><span className="actual" style={{ height: `${actual / wasteMaximum * 100}%` }} /><span className="expired" style={{ height: `${expired / wasteMaximum * 100}%` }} /><span className="imported" style={{ height: `${imported / wasteMaximum * 100}%` }} /></div><small>{payload.wasteTrend.granularity === "day" ? shortDate(period) : shortMonth(period)}</small></div>;
                })}
              </div>
            </div>
          )}
          <small className="chart-provenance">{expiredWaste.length ? "Expired inventory is counted on its expiry date and shown separately from recorded waste." : ""} {payload.wasteTrend.imported_history_status.status === "available" ? "Imported training waste is shown separately; it is not recorded operational waste." : "Only recorded application waste is shown."}</small>
        </article>
      </section>

      <section className="dashboard-tables-grid">
        <DashboardTable className="expiry-dashboard-card" icon={<span className="table-heading-icon expiry-icon">!</span>} title="Expiry Alerts" headers={["Product", "Batch", "Expiry Date", "Days", "Quantity", "Risk", "Source"]}>
          {expiryAlerts.length === 0 ? <EmptyRow colSpan={7} text={expiryAlertsLoading ? "Loading expiry alerts…" : expiryAlertsError || "No non-empty application batches or eligible CSV snapshot alerts."} /> : expiryAlerts.map((item) => <tr key={`${item.source}:${item.batch_id}`}><td><ProductName name={item.product_name} category={item.category} /></td><td>{item.batch_code}</td><td className={item.status === "expired" ? "expiry-date" : ""}>{formatDate(item.expiry_date)}<small className="form-field-note">{item.expiry_date_source === "estimated" ? "Estimated" : item.expiry_date_source === "manufacturer_verified" ? "Manufacturer verified" : item.expiry_date_source === "manual_verified" ? "Manually verified" : item.expiry_date_source === "imported" ? "Imported" : "Unverified legacy date"}</small></td><td className={item.days_to_expiry <= 3 ? "days-urgent" : "days-ok"}>{item.days_to_expiry < 0 ? `${Math.abs(item.days_to_expiry)}d overdue` : item.days_to_expiry}</td><td>{formatNumber(item.quantity_remaining)} {item.unit}</td><td><span className={`risk-pill ${item.risk}`}>{item.risk}</span></td><td>{item.source === "application" ? "Live" : `Snapshot · ${item.snapshot_date ? formatDate(item.snapshot_date) : "CSV"}`}</td></tr>)}
        </DashboardTable>
        <DashboardTable className="recommendation-dashboard-card" icon={<Lightbulb className="table-heading-icon bulb-icon" size={18} />} title="Operational Recommendations" headers={["Product", "Current", "Suggested", "Discount", "Reason", "Source / Action"]}>
          {recommendations.length === 0 ? <EmptyRow colSpan={6} text={recommendationsLoading ? "Loading recommendations…" : recommendationsError || "No operational recommendations are currently available."} /> : recommendations.map((item) => <tr key={`${item.source}:${item.recommendation_id ?? `${item.product_id}:${item.batch_id ?? 0}`}`}><td><ProductName name={item.product_name} category={item.product_category ?? undefined} /></td><td className="price-green">{item.current_price === null ? "—" : formatCurrency(item.current_price, summary.currency)}</td><td className="price-green">{item.suggested_price === null ? "—" : formatCurrency(item.suggested_price, summary.currency)}</td><td>{item.discount_percent === null ? "—" : `${formatNumber(item.discount_percent)}%`}</td><td className="reason-cell">{item.reason}</td><td>{item.source === "simulated_scenario" ? <span className="risk-pill medium">Simulated · not applied</span> : item.recommendation_id !== null ? <button className="table-action-button" disabled={applyingRecommendation === item.recommendation_id} onClick={() => void applyRecommendation(item.recommendation_id!)}>{applyingRecommendation === item.recommendation_id ? "Saving" : "Approve"}</button> : <span className="risk-pill medium">Generated · not saved</span>}</td></tr>)}
        </DashboardTable>
      </section>

      <section className="dashboard-bottom-grid">
        <DashboardTable className="selling-card" title="Top Selling Products" headers={["Product", "Quantity", "Revenue", "Source"]}>
          {payload.topProducts.length === 0 ? <EmptyRow colSpan={4} text="No application sales or CSV training history for this period." /> : payload.topProducts.map((item) => <tr key={`${item.source}:${item.product_id}`}><td><ProductName name={item.product_name} category={item.category} /></td><td>{formatNumber(item.quantity_sold)} {item.unit}</td><td>{item.revenue === null ? "Training only" : formatCurrency(item.revenue, summary.currency)}</td><td>{item.source === "application" ? "Actual sales" : "CSV training"}</td></tr>)}
        </DashboardTable>
        <DashboardTable className="low-stock-card" title="Low Stock Products" headers={["Product", "Quantity", "Snapshot / Threshold", "Source"]}>
          {payload.lowStock.length === 0 ? <EmptyRow colSpan={4} text="No application low-stock records or low-stock CSV snapshot examples." /> : payload.lowStock.map((item) => <tr key={`${item.source}:${item.product_id}:${item.snapshot_date ?? "live"}`}><td><ProductName name={item.product_name} category={item.category} /></td><td className="stock-critical">{formatNumber(item.current_stock)} {item.unit}</td><td>{item.snapshot_date ? formatDate(item.snapshot_date) : `${formatNumber(item.reorder_level)} ${item.unit}`}</td><td>{item.source === "application" ? "Live stock" : "CSV snapshot"}</td></tr>)}
        </DashboardTable>
        <DashboardTable className="activity-card" title="Recent Activities" headers={["Activity", "User", "Time"]}>
          {payload.recentActivities.length === 0 ? <EmptyRow colSpan={3} text="No recorded activity." /> : payload.recentActivities.map((item) => <tr key={item.activity_id}><td><span className="activity-text"><i className="activity-symbol green"><BarChart3 size={10} /></i>{actionLabel(item.action, item.entity_type, item.entity_id)}</span></td><td>{item.actor_name ?? "Not recorded"}</td><td>{formatTimestamp(item.created_at)}</td></tr>)}
        </DashboardTable>
      </section>
      <div className="dashboard-footnote">Recorded application data and imported training history are kept separate.</div>
    </div>
  );
}

function dateTicks(dates: string[]): string[] {
  if (dates.length === 0) return [];
  const fractions = dates.length <= 4 ? [0, 1] : [0, 1 / 3, 2 / 3, 1];
  return [...new Set(fractions.map((fraction) => dates[Math.round((dates.length - 1) * fraction)]))];
}

type SalesChartPoint = { date: string; actual: number | null; imported: number | null; predicted: number | null };

function aggregateSalesChart(points: SalesChartPoint[], range: string): SalesChartPoint[] {
  const grouped = new Map<string, { actual: number[]; imported: number[]; predicted: number[]; label: string }>();
  points.forEach((point) => {
    const date = new Date(`${point.date}T00:00:00`);
    let key = point.date;
    let label = point.date;
    if (range === "365" || range === "6m") {
      key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      label = `${key}-01`;
    } else if (range === "30") {
      const monday = new Date(date);
      monday.setDate(date.getDate() - ((date.getDay() + 6) % 7));
      key = localDate(monday);
      label = key;
    }
    const bucket = grouped.get(key) ?? { actual: [], imported: [], predicted: [], label };
    if (point.actual !== null) bucket.actual.push(point.actual);
    if (point.imported !== null) bucket.imported.push(point.imported);
    if (point.predicted !== null) bucket.predicted.push(point.predicted);
    grouped.set(key, bucket);
  });
  const sum = (values: number[]) => values.length ? values.reduce((total, value) => total + value, 0) : null;
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, bucket]) => ({
    date: bucket.label,
    actual: sum(bucket.actual),
    imported: sum(bucket.imported),
    predicted: sum(bucket.predicted),
  }));
}

function shortDate(value: string): string {
  return formatAppDate(value);
}

function shortMonth(value: string): string {
  return new Intl.DateTimeFormat("en-IN", { month: "short" }).format(new Date(`${value}T00:00:00`));
}

function formatTimestamp(value: string): string {
  return formatAppDateTime(value);
}

function ChartEmpty({ text }: { text: string }) {
  return <div className="dashboard-chart-empty"><BarChart3 size={20} /><span>{text}</span></div>;
}

function EmptyRow({ colSpan, text }: { colSpan: number; text: string }) {
  return <tr><td className="dashboard-empty-row" colSpan={colSpan}>{text}</td></tr>;
}

function Kpi({ icon, color, label, value, note, wrapNote = false }: { icon: ReactNode; color: string; label: string; value: string; note: string; wrapNote?: boolean }) {
  return <article className="dashboard-kpi"><span className={`dashboard-kpi-icon ${color}`}>{icon}</span><div className="dashboard-kpi-body"><span className="dashboard-kpi-label">{label}</span><div className="dashboard-kpi-value-row"><b>{value}</b></div><small className={wrapNote ? "dashboard-kpi-note-wrap" : undefined}>{note}</small></div></article>;
}

function CardTitle({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="dashboard-card-title"><h2>{title}</h2>{children}</div>;
}

function DashboardTable({ className, title, icon, headers, children }: { className: string; title: string; icon?: ReactNode; headers: string[]; children: ReactNode }) {
  return <article className={`dashboard-card dashboard-table-card ${className}`}><div className="dashboard-table-heading">{icon}{title}</div><div className="dashboard-table-scroll"><table><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{children}</tbody></table></div></article>;
}