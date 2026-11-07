import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, BarChart3, CalendarDays, ChevronDown, ChevronLeft, ChevronRight,
  Download, Eye, Leaf, Package, Plus, RefreshCw, Search, Trash2, TrendingDown, X,
} from "lucide-react";
import { createWaste, listBatches, listProducts, listWaste } from "../services/business";
import type { InventoryBatchRecord, ProductRecord, WasteRecord } from "../services/business";
import { loadWasteTrend } from "../services/dashboard";
import type { WasteTrend } from "../services/dashboard";
import ProductSymbolIcon from "../components/ProductSymbol";
import { productSymbol } from "../services/productSymbols";
import { useGeneralSettings } from "../services/generalSettings";
import { formatAppDate, formatAppDateTime } from "../services/generalSettings";

type Props = { onNotify: (message: string) => void; canManage?: boolean; canExport?: boolean };
type WasteForm = {
  product_id: string;
  batch_id: string;
  quantity: string;
  reason: "spoilage" | "expired" | "damaged" | "overstock" | "other";
  waste_cost: string;
  notes: string;
};

const emptyForm: WasteForm = {
  product_id: "",
  batch_id: "",
  quantity: "",
  reason: "spoilage",
  waste_cost: "0",
  notes: "",
};
const chartColors = ["#0aa45a", "#3987ff", "#ffad22", "#a56be0", "#e56b6b", "#8795a5"];

function localDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function rangeStart(selection: string, end: string): string {
  const start = new Date(`${end}T00:00:00`);
  if (selection === "month") start.setDate(1);
  else if (selection === "year") start.setMonth(0, 1);
  else start.setDate(start.getDate() - Number(selection) + 1);
  return localDate(start);
}

function numberValue(value: number | string | null | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatNumber(value: number, digits = 2): string {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: digits }).format(value);
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(value);
}

function formatDate(value: string): string {
  return formatAppDate(value.slice(0, 10));
}

function linePath(values: Array<number | null>, width: number, height: number, maximum: number): string {
  let open = false;
  return values.reduce<string>((path, value, index) => {
    if (value === null) {
      open = false;
      return path;
    }
    const x = values.length < 2 ? width / 2 : (index / (values.length - 1)) * width;
    const y = height - (value / maximum) * height;
    const command = open ? "L" : "M";
    open = true;
    return `${path}${command} ${x.toFixed(1)} ${y.toFixed(1)} `;
  }, "");
}

function reasonLabel(reason: string): string {
  return reason.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function WasteTrendChart({ trend, unit }: { trend: WasteTrend; unit: string }) {
  const actual = trend.actual.filter((item) => item.unit === unit);
  const expired = trend.expired_inventory.filter((item) => item.unit === unit);
  const imported = trend.imported_history.filter((item) => item.unit === unit);
  const periods = [...new Set([...actual.map((item) => item.period), ...expired.map((item) => item.period), ...imported.map((item) => item.period)])].sort();
  const actualByDate = new Map(actual.map((item) => [item.period, numberValue(item.quantity)]));
  const expiredByDate = new Map(expired.map((item) => [item.period, numberValue(item.quantity)]));
  const importedByDate = new Map(imported.map((item) => [item.period, numberValue(item.quantity)]));
  const maximum = Math.max(1, ...actual.map((item) => numberValue(item.quantity)), ...expired.map((item) => numberValue(item.quantity)), ...imported.map((item) => numberValue(item.quantity))) * 1.12;
  if (!periods.length) return <div className="dashboard-chart-empty">No recorded, expired, or imported waste history for this period.</div>;
  const labels = periods.filter((_, index) => index === 0 || index === periods.length - 1 || index % Math.ceil(periods.length / 5) === 0);
  return <svg className="waste-trend-svg" viewBox="0 0 360 112" preserveAspectRatio="none" role="img" aria-label={`Recorded, expired inventory, and imported waste quantity in ${unit}`}>
    {[0, 1, 2, 3, 4].map((line) => {
      const y = line * 26;
      return <g key={line}>
        <line x1="0" x2="360" y1={y} y2={y} stroke="#e8eef3" />
        <text x="0" y={Math.max(8, y - 2)}>{formatNumber(maximum * (1 - line / 4), 0)}</text>
      </g>;
    })}
    <path d={linePath(periods.map((period) => importedByDate.get(period) ?? null), 360, 104, maximum)} fill="none" stroke="#8795a5" strokeDasharray="4 3" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    <path d={linePath(periods.map((period) => expiredByDate.get(period) ?? null), 360, 104, maximum)} fill="none" stroke="#e56b6b" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    <path d={linePath(periods.map((period) => actualByDate.get(period) ?? null), 360, 104, maximum)} fill="none" stroke="#0aa45a" strokeWidth="2.2" vectorEffect="non-scaling-stroke" />
    {periods.map((period, index) => {
      const value = actualByDate.get(period);
      const x = periods.length < 2 ? 180 : (index / (periods.length - 1)) * 360;
      const expiredValue = expiredByDate.get(period);
      return <g key={period}>
        {value !== undefined && <circle key={`actual-${period}`} cx={x} cy={104 - (value / maximum) * 104} r="2.2" fill="#fff" stroke="#0aa45a" strokeWidth="1.5"><title>{`${period}: ${formatNumber(value)} recorded ${unit}`}</title></circle>}
        {expiredValue !== undefined && <circle key={`expired-${period}`} cx={x} cy={104 - (expiredValue / maximum) * 104} r="2.2" fill="#fff" stroke="#e56b6b" strokeWidth="1.5"><title>{`${period}: ${formatNumber(expiredValue)} expired ${unit}`}</title></circle>}
      </g>;
    })}
    {labels.map((period) => {
      const index = periods.indexOf(period);
      const x = periods.length < 2 ? 180 : (index / (periods.length - 1)) * 360;
      return <text key={period} x={x} y="111" textAnchor={index === 0 ? "start" : index === periods.length - 1 ? "end" : "middle"}>{period.slice(0, 7)}</text>;
    })}
  </svg>;
}

export default function WasteReports({ onNotify, canManage = false, canExport = false }: Props) {
  const { items_per_page: pageSize } = useGeneralSettings();
  const [records, setRecords] = useState<WasteRecord[]>([]);
  const [products, setProducts] = useState<ProductRecord[]>([]);
  const [batches, setBatches] = useState<InventoryBatchRecord[]>([]);
  const [trend, setTrend] = useState<WasteTrend | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [showForm, setShowForm] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<WasteRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [range, setRange] = useState("180");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [reasonFilter, setReasonFilter] = useState("");
  const [search, setSearch] = useState("");
  const [startDate, setStartDate] = useState(rangeStart("180", localDate(new Date())));
  const [endDate, setEndDate] = useState(localDate(new Date()));
  const [selectedUnit, setSelectedUnit] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [pageSize]);

  const productById = useMemo(() => new Map(products.map((product) => [product.product_id, product])), [products]);

  async function refresh(start = startDate, end = endDate): Promise<boolean> {
    setLoading(true);
    setError("");
    try {
      const [wasteRows, productRows, batchRows, trendData] = await Promise.all([
        listWaste(), listProducts(), listBatches(),
        loadWasteTrend({ start_date: start, end_date: end }, start === end ? "day" : "month"),
      ]);
      setRecords(wasteRows);
      setProducts(productRows);
      setBatches(batchRows);
      setTrend(trendData);
      setSelectedUnit((current) => trendData.units.includes(current) ? current : trendData.units[0] ?? "");
      return true;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not load waste report data.";
      setError(message);
      onNotify(message);
      return false;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  const expiredInventoryRecords = useMemo<WasteRecord[]>(() => {
    const today = localDate(new Date());
    return batches
      .filter((batch) => numberValue(batch.quantity_remaining) > 0 && batch.expiry_date.slice(0, 10) < today)
      .map((batch) => ({
        waste_id: -batch.batch_id,
        product_id: batch.product_id,
        batch_id: batch.batch_id,
        quantity: batch.quantity_remaining,
        reason: "expired",
        waste_cost: numberValue(batch.quantity_remaining) * numberValue(batch.unit_cost),
        recorded_at: `${batch.expiry_date.slice(0, 10)}T00:00:00`,
        notes: "Current expired inventory (derived from the batch expiry date).",
      }));
  }, [batches]);

  const filteredRecords = useMemo(() => [...records, ...expiredInventoryRecords].filter((record) => {
    const product = productById.get(record.product_id);
    const recordDate = record.recorded_at.slice(0, 10);
    const searchText = `${product?.name ?? ""} ${product?.sku ?? ""} ${record.notes ?? ""} ${record.reason}`.toLowerCase();
    return (!categoryFilter || product?.category === categoryFilter)
      && (!reasonFilter || record.reason === reasonFilter)
      && (!search.trim() || searchText.includes(search.trim().toLowerCase()))
      && recordDate >= startDate
      && recordDate <= endDate;
  }), [records, expiredInventoryRecords, productById, categoryFilter, reasonFilter, search, startDate, endDate]);
  const categories = [...new Set(products.map((product) => product.category))].sort();
  const reasons = [...new Set([...records, ...expiredInventoryRecords].map((record) => record.reason))].sort();
  const units = useMemo(() => [...new Set(filteredRecords.map((record) => productById.get(record.product_id)?.unit ?? "unit"))].sort(), [filteredRecords, productById]);
  const quantityByUnit = useMemo(() => {
    const totals = new Map<string, number>();
    filteredRecords.forEach((record) => {
      const unit = productById.get(record.product_id)?.unit ?? "unit";
      totals.set(unit, (totals.get(unit) ?? 0) + numberValue(record.quantity));
    });
    return totals;
  }, [filteredRecords, productById]);
  const quantityLabel = units.length > 1 ? "Mixed" : units.length === 1 ? `${formatNumber(quantityByUnit.get(units[0]) ?? 0)} ${units[0]}` : "0";
  const quantityNote = units.length > 1
    ? units.map((unit) => `${formatNumber(quantityByUnit.get(unit) ?? 0)} ${unit}`).join(" · ")
    : "Actual recorded application waste";
  const totalCost = filteredRecords.reduce((sum, record) => sum + numberValue(record.waste_cost), 0);
  const importedQuantity = trend?.imported_history
    .filter((item) => item.period >= startDate.slice(0, 7) && item.period <= endDate.slice(0, 7))
    .reduce((sum, item) => sum + numberValue(item.quantity), 0) ?? 0;
  const categoryTotals = useMemo(() => {
    const totals = new Map<string, number>();
    filteredRecords.forEach((record) => {
      const category = productById.get(record.product_id)?.category ?? "Uncategorized";
      totals.set(category, (totals.get(category) ?? 0) + numberValue(record.quantity));
    });
    return [...totals.entries()].sort((a, b) => b[1] - a[1]);
  }, [filteredRecords, productById]);
  const categoryTotal = categoryTotals.reduce((sum, [, value]) => sum + value, 0);
  let donutStart = 0;
  const donutStops = categoryTotals.map(([, value], index) => {
    const start = donutStart;
    donutStart += categoryTotal ? value / categoryTotal * 100 : 0;
    return `${chartColors[index % chartColors.length]} ${start}% ${donutStart}%`;
  });
  const productTotals = useMemo(() => {
    const totals = new Map<number, number>();
    filteredRecords.forEach((record) => totals.set(record.product_id, (totals.get(record.product_id) ?? 0) + numberValue(record.quantity)));
    return [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [filteredRecords]);
  const maxProductTotal = Math.max(1, ...productTotals.map(([, value]) => value));
  const reasonTotals = useMemo(() => {
    const totals = new Map<string, number>();
    filteredRecords.forEach((record) => totals.set(record.reason, (totals.get(record.reason) ?? 0) + 1));
    return [...totals.entries()].sort((a, b) => b[1] - a[1]);
  }, [filteredRecords]);
  const maxReasonCount = Math.max(1, ...reasonTotals.map(([, count]) => count));
  const totalPages = Math.max(1, Math.ceil(filteredRecords.length / pageSize));
  const visibleRecords = filteredRecords.slice((page - 1) * pageSize, page * pageSize);
  const availableBatches = batches.filter((batch) => String(batch.product_id) === form.product_id);
  const selectedProduct = products.find((product) => String(product.product_id) === form.product_id);

  async function submitWaste(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      await createWaste({
        product_id: Number(form.product_id),
        batch_id: form.batch_id ? Number(form.batch_id) : null,
        quantity: Number(form.quantity),
        reason: form.reason,
        waste_cost: Number(form.waste_cost),
        notes: form.notes.trim() || null,
      });
      setForm(emptyForm);
      setShowForm(false);
      const refreshed = await refresh();
      onNotify(refreshed ? "Waste record saved." : "Waste record saved, but the history could not be refreshed.");
    } catch (reason) {
      onNotify(reason instanceof Error ? reason.message : "Could not save waste record.");
    } finally {
      setSaving(false);
    }
  }

  function applyRange(value: string) {
    const end = localDate(new Date());
    const start = rangeStart(value, end);
    setRange(value);
    setStartDate(start);
    setEndDate(end);
    setPage(1);
    void refresh(start, end);
  }

  function exportWaste() {
    const header = ["Recorded At", "Product", "SKU", "Category", "Batch", "Quantity", "Unit", "Reason", "Waste Cost", "Notes"];
    const rows = filteredRecords.map((record) => {
      const product = productById.get(record.product_id);
      const batch = batches.find((item) => item.batch_id === record.batch_id);
      return [
        record.recorded_at, product?.name ?? `Product #${record.product_id}`, product?.sku ?? "",
        product?.category ?? "Uncategorized", batch?.batch_code ?? "", record.quantity,
        product?.unit ?? "unit", reasonLabel(record.reason), record.waste_cost, record.notes ?? "",
      ];
    }).map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(","));
    const url = URL.createObjectURL(new Blob([[header.join(","), ...rows].join("\r\n")], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "wastewise-waste-records.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function setFilter(action: () => void) {
    action();
    setPage(1);
  }

  return (
    <main className="page-content waste-reports-page">
      <header className="waste-report-banner">
        <div><h1>Waste Reports</h1><p>Track recorded waste, understand trends, and find opportunities to reduce loss.</p></div>
        <div className="waste-report-banner-art" aria-hidden="true">
          <span className="waste-banner-produce">🥬🍅🥕</span>
          <div className="waste-bin"><span>♻</span></div>
          <span className="waste-banner-bottle">🧃</span>
          <div className="waste-banner-message"><Leaf size={17} /><b>Less waste,<br />more value</b></div>
          <span className="waste-banner-leaves">🌿</span>
        </div>
        <div className="page-actions">
          <label className="waste-report-select">
            <select aria-label="Waste report date range" value={range} onChange={(event) => applyRange(event.target.value)}>
              <option value="30">Last 30 days</option><option value="90">Last 90 days</option>
              <option value="180">Last 6 months</option><option value="year">This year</option>
            </select><ChevronDown size={13} />
          </label>
          <button type="button" className="export-button" onClick={() => void refresh()} disabled={loading}><RefreshCw size={15} /> Refresh</button>
          {canExport && <button type="button" className="export-button" onClick={exportWaste} disabled={loading}><Download size={15} /> Export</button>}
          {canManage && <button type="button" className="save-button" onClick={() => setShowForm(true)}><Plus size={15} /> Record Waste</button>}
        </div>
      </header>

      {error && <div className="error-banner" role="alert"><AlertTriangle size={17} />{error}</div>}
      {!loading && !error && filteredRecords.length === 0 && trend?.imported_history.length
        ? <div className="waste-data-notice" role="status"><AlertTriangle size={16} /><span><b>No operational waste has been recorded in this period.</b> Imported training history is shown separately in the trend chart and is not included in recorded waste totals.</span></div>
        : null}

      <section className="waste-report-stats" aria-label="Waste report summary">
        <article className="waste-report-stat"><div className="waste-stat-icon red"><Trash2 size={26} /></div><div><span>Waste Records</span><strong>{loading ? "—" : formatNumber(filteredRecords.length, 0)}</strong><small>Application records in selected period</small></div></article>
        <article className="waste-report-stat"><div className="waste-stat-icon green"><Package size={26} /></div><div><span>Recorded Quantity</span><strong>{loading ? "—" : quantityLabel}</strong><small>{quantityNote}</small></div></article>
        <article className="waste-report-stat"><div className="waste-stat-icon orange"><TrendingDown size={26} /></div><div><span>Recorded Waste Cost</span><strong>{loading ? "—" : formatMoney(totalCost)}</strong><small>Cost attached to recorded waste entries</small></div></article>
        <article className="waste-report-stat"><div className="waste-stat-icon blue"><BarChart3 size={26} /></div><div><span>Imported Training History</span><strong>{loading ? "—" : `${formatNumber(importedQuantity, 0)} ${trend?.imported_history[0]?.unit ?? "units"}`}</strong><small>Separate historical dataset · not operational waste</small></div></article>
      </section>

      <section className="waste-report-charts" aria-label="Waste analytics">
        <article className="waste-chart-card waste-trend-card" tabIndex={0} title="Double-click or focus and press Enter to expand">
          <div className="waste-chart-heading"><h2>Waste Trend</h2>{trend && trend.units.length > 1 && <label><select aria-label="Waste chart unit" value={selectedUnit} onChange={(event) => setSelectedUnit(event.target.value)}>{trend.units.map((unit) => <option key={unit}>{unit}</option>)}</select><ChevronDown size={12} /></label>}</div>
          <div className="waste-chart-legend"><span><i className="quantity-key" />Recorded application waste</span><span><i className="expired-key" />Expired inventory</span><span><i className="imported-key" />Imported training history</span></div>
          {loading ? <div className="dashboard-chart-empty">Loading waste trend…</div> : error || !trend ? <div className="dashboard-chart-empty">Waste trend is unavailable.</div> : <WasteTrendChart trend={trend} unit={selectedUnit || trend.units[0] || "unit"} />}
        </article>
        <article className="waste-chart-card waste-category-card" tabIndex={0} title="Double-click or focus and press Enter to expand">
          <h2>Recorded Waste by Category</h2>
          {categoryTotals.length ? <div className="waste-category-chart">
            <div className="waste-category-donut" style={{ background: `conic-gradient(${donutStops.join(", ")})` }} role="img" aria-label="Recorded waste by product category">
              <div><strong>{formatNumber(categoryTotal)}</strong><span>{units.length === 1 ? units[0] : "Units"}</span></div>
            </div>
            <ul>{categoryTotals.map(([category, value], index) => <li key={category}><i style={{ background: chartColors[index % chartColors.length] }} /><span>{category}</span><b>{formatNumber(value)}</b></li>)}</ul>
          </div> : <div className="waste-chart-empty">No recorded waste by category for the selected filters.</div>}
        </article>
        <article className="waste-chart-card top-products-card" tabIndex={0} title="Double-click or focus and press Enter to expand">
          <h2>Products with Most Recorded Waste</h2>
          {productTotals.length ? <div className="top-waste-products">
            {productTotals.map(([productId, quantity], index) => {
              const product = productById.get(productId);
              const color = chartColors[index % chartColors.length];
              return <div key={productId}><span aria-hidden="true"><ProductSymbolIcon symbol={productSymbol(product?.name ?? `Product #${productId}`, product?.category)} /></span><b>{product?.name ?? `Product #${productId}`}</b><div><i style={{ width: `${quantity / maxProductTotal * 100}%`, background: color }} /></div><small>{formatNumber(quantity)} {product?.unit ?? ""}</small></div>;
            })}
          </div> : <div className="waste-chart-empty">Product ranking will appear when waste is recorded.</div>}
        </article>
      </section>

      <section className="waste-report-lower">
        <div className="waste-records-panel">
          <div className="waste-report-toolbar">
            <label className="waste-report-search"><Search size={14} /><input aria-label="Search waste records" placeholder="Search product, SKU, reason or notes..." value={search} onChange={(event) => setFilter(() => setSearch(event.target.value))} />{search && <button type="button" aria-label="Clear waste search" onClick={() => setSearch("")}><X size={13} /></button>}</label>
            <label className="waste-report-select"><select aria-label="Filter waste by category" value={categoryFilter} onChange={(event) => setFilter(() => setCategoryFilter(event.target.value))}><option value="">All categories</option>{categories.map((category) => <option key={category}>{category}</option>)}</select><ChevronDown size={12} /></label>
            <label className="waste-report-select"><select aria-label="Filter waste by reason" value={reasonFilter} onChange={(event) => setFilter(() => setReasonFilter(event.target.value))}><option value="">All reasons</option>{reasons.map((reason) => <option key={reason} value={reason}>{reasonLabel(reason)}</option>)}</select><ChevronDown size={12} /></label>
            <label className="waste-report-date"><CalendarDays size={13} /><input aria-label="Waste start date" type="date" value={startDate} max={endDate} onChange={(event) => { setStartDate(event.target.value); setPage(1); }} /></label>
            <label className="waste-report-date"><CalendarDays size={13} /><input aria-label="Waste end date" type="date" value={endDate} min={startDate} max={localDate(new Date())} onChange={(event) => { setEndDate(event.target.value); setPage(1); }} /></label>
            <button type="button" className="waste-report-export" onClick={() => void refresh()} disabled={loading} aria-label="Apply waste date filters"><RefreshCw size={13} /> Apply</button>
            {canExport && <button type="button" className="waste-report-export" onClick={exportWaste} disabled={loading || filteredRecords.length === 0}><Download size={13} /> Export</button>}
          </div>
          <div className="waste-records-scroll">
            <table className="waste-records-table">
              <thead><tr><th>Date</th><th>Product</th><th>Batch</th><th>Quantity</th><th>Reason</th><th>Cost</th><th>Notes</th><th>Details</th></tr></thead>
              <tbody>
                {loading && <tr><td className="waste-empty-state" colSpan={8}>Loading waste records…</td></tr>}
                {!loading && error && <tr><td className="waste-empty-state" colSpan={8}>Waste data could not be loaded.</td></tr>}
                {!loading && !error && visibleRecords.map((record) => {
                  const product = productById.get(record.product_id);
                  const batch = batches.find((item) => item.batch_id === record.batch_id);
                  return <tr key={record.waste_id}>
                    <td>{formatDate(record.recorded_at)}</td>
                    <td><span className="waste-product-emoji" aria-hidden="true"><ProductSymbolIcon symbol={productSymbol(product?.name ?? `Product #${record.product_id}`, product?.category)} /></span><b>{product?.name ?? `Product #${record.product_id}`}</b></td>
                    <td>{batch?.batch_code ?? (record.batch_id ? `Batch #${record.batch_id}` : "—")}</td>
                    <td>{formatNumber(numberValue(record.quantity))} {product?.unit ?? ""}</td>
                    <td><span className={`waste-reason-pill ${record.reason}`}>{reasonLabel(record.reason)}</span></td>
                    <td>{formatMoney(numberValue(record.waste_cost))}</td>
                    <td title={record.notes ?? ""}>{record.notes || "—"}</td>
                    <td><button type="button" className="waste-view-action" aria-label={`View waste record ${record.waste_id}`} onClick={() => setSelectedRecord(record)}><Eye size={14} /></button></td>
                  </tr>;
                })}
                {!loading && !error && visibleRecords.length === 0 && <tr><td className="waste-empty-state" colSpan={8}>{records.length ? "No records match the selected filters." : "No operational waste records in this period. Training history is shown separately above."}</td></tr>}
              </tbody>
            </table>
          </div>
          <footer className="waste-records-footer">
            <span>{filteredRecords.length ? `Showing ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, filteredRecords.length)} of ${filteredRecords.length} records` : "Showing 0 records"}</span>
            <nav aria-label="Waste record pages">
              <button type="button" aria-label="Previous waste page" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1}><ChevronLeft size={14} /></button>
              {Array.from({ length: totalPages }, (_, index) => index + 1).slice(Math.max(0, page - 2), Math.max(0, page - 2) + 4).map((pageNumber) => <button type="button" key={pageNumber} className={page === pageNumber ? "current" : ""} aria-current={page === pageNumber ? "page" : undefined} onClick={() => setPage(pageNumber)}>{pageNumber}</button>)}
              <button type="button" aria-label="Next waste page" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={page >= totalPages}><ChevronRight size={14} /></button>
            </nav>
          </footer>
        </div>
        <aside className="waste-report-side-panels" aria-label="Waste report breakdown">
          <article className="waste-side-card"><h2>Waste Records by Reason</h2>
            {reasonTotals.length
              ? <div className="waste-distribution-list">{reasonTotals.map(([reason, count], index) => <div className="waste-distribution-row" key={reason}><span>{reasonLabel(reason)}</span><div><i style={{ width: `${count / maxReasonCount * 100}%`, background: chartColors[index % chartColors.length] }} /></div><b>{count}</b></div>)}</div>
              : <div className="waste-chart-empty">No reason breakdown yet.</div>}
          </article>
          <article className="waste-side-card"><h2>Report Data Sources</h2>
            <div className="waste-source-list">
              <p><i className="quantity-key" /><span><b>Recorded waste</b><small>Application records; these determine KPIs, rankings and history.</small></span></p>
              <p><i className="imported-key" /><span><b>Imported training data</b><small>{trend?.imported_history_status.message ?? "Unavailable"}</small></span></p>
              {trend?.imported_history_status.status === "unavailable" && <div role="status" className="waste-source-warning"><AlertTriangle size={13} />{trend.imported_history_status.message}</div>}
            </div>
          </article>
        </aside>
      </section>

      {showForm && <div className="waste-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowForm(false); }}>
        <form className="waste-record-modal" onSubmit={submitWaste}>
          <header><span>♻</span><div><h2>Record Waste</h2><p>Records actual waste and deducts quantity from a selected batch.</p></div><button type="button" aria-label="Close record waste form" onClick={() => setShowForm(false)}><X size={17} /></button></header>
          <label>Product<select required value={form.product_id} onChange={(event) => setForm({ ...form, product_id: event.target.value, batch_id: "" })}><option value="">Select product</option>{products.map((product) => <option key={product.product_id} value={product.product_id}>{product.name}</option>)}</select></label>
          <label>Batch<select value={form.batch_id} onChange={(event) => setForm({ ...form, batch_id: event.target.value })}><option value="">No batch selected</option>{availableBatches.map((batch) => <option key={batch.batch_id} value={batch.batch_id}>{batch.batch_code} · {batch.quantity_remaining} remaining</option>)}</select></label>
          {selectedProduct && <small className="waste-form-hint">Unit: {selectedProduct.unit}. Batch quantity is reduced after this record is saved.</small>}
          <div className="form-row">
            <label>Quantity<input required type="number" min="0.001" step="0.001" value={form.quantity} onChange={(event) => setForm({ ...form, quantity: event.target.value })} /></label>
            <label>Reason<select value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value as WasteForm["reason"] })}>{["spoilage", "expired", "damaged", "overstock", "other"].map((reason) => <option key={reason} value={reason}>{reasonLabel(reason)}</option>)}</select></label>
          </div>
          <label>Waste cost<input type="number" min="0" step="0.01" value={form.waste_cost} onChange={(event) => setForm({ ...form, waste_cost: event.target.value })} /></label>
          <label>Notes<textarea maxLength={500} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></label>
          <div className="modal-actions"><button type="button" className="cancel-button" onClick={() => setShowForm(false)}>Cancel</button><button type="submit" className="save-button" disabled={saving}>{saving ? "Saving…" : "Save Waste Record"}</button></div>
        </form>
      </div>}

      {selectedRecord && <div className="waste-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedRecord(null); }}>
        <section className="waste-record-modal" role="dialog" aria-modal="true" aria-labelledby="waste-record-title">
          <header><span><ProductSymbolIcon symbol={productSymbol(productById.get(selectedRecord.product_id)?.name ?? `Product #${selectedRecord.product_id}`, productById.get(selectedRecord.product_id)?.category)} /></span><div><h2 id="waste-record-title">Waste Record #{selectedRecord.waste_id}</h2><p>{productById.get(selectedRecord.product_id)?.name ?? `Product #${selectedRecord.product_id}`}</p></div><button type="button" aria-label="Close waste record details" onClick={() => setSelectedRecord(null)}><X size={17} /></button></header>
          <dl>
            <div><dt>Recorded date</dt><dd>{formatAppDateTime(selectedRecord.recorded_at)}</dd></div>
            <div><dt>Batch</dt><dd>{batches.find((batch) => batch.batch_id === selectedRecord.batch_id)?.batch_code ?? "Not specified"}</dd></div>
            <div><dt>Quantity</dt><dd>{formatNumber(numberValue(selectedRecord.quantity))} {productById.get(selectedRecord.product_id)?.unit ?? ""}</dd></div>
            <div><dt>Reason</dt><dd>{reasonLabel(selectedRecord.reason)}</dd></div>
            <div><dt>Waste cost</dt><dd>{formatMoney(numberValue(selectedRecord.waste_cost))}</dd></div>
            <div><dt>Notes</dt><dd>{selectedRecord.notes || "No notes"}</dd></div>
          </dl>
          <button type="button" className="waste-modal-done" onClick={() => setSelectedRecord(null)}>Done</button>
        </section>
      </div>}
    </main>
  );
}
