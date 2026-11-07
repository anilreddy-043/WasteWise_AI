import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  AlertTriangle,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
  Users,
  X,
} from "lucide-react";
import ProductSymbolIcon from "../components/ProductSymbol";
import { productSymbol } from "../services/productSymbols";
import { visiblePageNumbers } from "../services/pagination";
import { useGeneralSettings } from "../services/generalSettings";
import { formatAppDate } from "../services/generalSettings";
import {
  createExpiryAlertRule,
  deleteExpiryAlertRule,
  exportExpiryAlerts,
  getExpiryAlertBatch,
  getExpiryAlertCharts,
  getExpiryAlertFilters,
  listExpiryAlerts,
  listExpiryAlertRules,
  updateExpiryAlertRule,
} from "../services/expiryAlerts";
import type {
  ExpiryAlert,
  ExpiryAlertCharts,
  ExpiryAlertFilters,
  ExpiryAlertPage,
  ExpiryAlertQuery,
  ExpiryAlertRule,
  ExpiryAlertRuleInput,
  ExpiryRisk,
} from "../services/expiryAlerts";

type Props = { onNotify: (message: string) => void; canManageRules: boolean; canExport?: boolean };
type RiskFilter = "all" | ExpiryRisk;

const EMPTY_SUMMARY: ExpiryAlertPage["summary"] = {
  total_batches: 0,
  expired: 0,
  high: 0,
  medium: 0,
  low: 0,
  safe: 0,
  risk_counts: { expired: 0, high: 0, medium: 0, low: 0, safe: 0 },
};

const EMPTY_CHARTS: ExpiryAlertCharts = {
  risk_distribution: [],
  expiring_next_14_days: [],
  top_categories: [],
};

const EMPTY_FILTERS: ExpiryAlertFilters = { categories: [], locations: [], suppliers: [] };
const RISK_COLORS: Record<ExpiryRisk, string> = {
  expired: "#b82e40",
  high: "#f24f55",
  medium: "#ffa917",
  low: "#398df3",
  safe: "#12a25c",
};

const NEW_RULE: ExpiryAlertRuleInput = {
  name: "",
  days_before_expiry: 3,
  risk_level: null,
  category: null,
  location: null,
  supplier: null,
  enabled: true,
};

function formatDate(value: string): string {
  return formatAppDate(value.slice(0, 10));
}

function formatRiskLabel(risk: ExpiryRisk): string {
  return risk.charAt(0).toUpperCase() + risk.slice(1);
}

function donutGradient(charts: ExpiryAlertCharts, total: number): string {
  if (!total) return "conic-gradient(#e9eff3 0 100%)";
  let position = 0;
  const segments = charts.risk_distribution.flatMap(({ risk, count }) => {
    if (!count) return [];
    const start = position;
    position += (count / total) * 100;
    return [`${RISK_COLORS[risk]} ${start}% ${position}%`];
  });
  return `conic-gradient(${segments.join(", ")})`;
}

export default function ExpiryAlerts({ onNotify, canManageRules, canExport = false }: Props) {
  const { items_per_page: pageSize } = useGeneralSettings();
  const [data, setData] = useState<ExpiryAlertPage | null>(null);
  const [charts, setCharts] = useState<ExpiryAlertCharts>(EMPTY_CHARTS);
  const [filters, setFilters] = useState<ExpiryAlertFilters>(EMPTY_FILTERS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [risk, setRisk] = useState<RiskFilter>("all");
  const [location, setLocation] = useState("");
  const [supplier, setSupplier] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [pageSize]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [exportFormat, setExportFormat] = useState<"csv" | "xlsx">("csv");
  const [detail, setDetail] = useState<ExpiryAlert | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [rules, setRules] = useState<ExpiryAlertRule[]>([]);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [editingRule, setEditingRule] = useState<ExpiryAlertRule | null>(null);
  const [ruleForm, setRuleForm] = useState<ExpiryAlertRuleInput>(NEW_RULE);
  const [savingRule, setSavingRule] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const request = useMemo<ExpiryAlertQuery>(() => ({
    search: query.trim() || undefined,
    category: category || undefined,
    risk: risk === "all" ? undefined : risk,
    location: location || undefined,
    supplier: supplier || undefined,
    page,
    page_size: pageSize,
  }), [query, category, risk, location, supplier, page, pageSize]);

  const chartRequest = useMemo(() => ({
    search: request.search,
    category: request.category,
    risk: request.risk,
    location: request.location,
    supplier: request.supplier,
  }), [request]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    Promise.all([
      listExpiryAlerts(request),
      getExpiryAlertCharts(chartRequest),
      getExpiryAlertFilters(),
    ]).then(([pageData, chartData, filterData]) => {
      if (!active) return;
      setData(pageData);
      setCharts(chartData);
      setFilters(filterData);
      setSelectedIds((current) => current.filter((id) => pageData.items.some((item) => item.batch_id === id)));
    }).catch((reason: unknown) => {
      if (!active) return;
      const message = reason instanceof Error ? reason.message : "Could not load expiry alerts.";
      setData(null);
      setCharts(EMPTY_CHARTS);
      setFilters(EMPTY_FILTERS);
      setError(message);
      onNotify(message);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [request, chartRequest, refreshKey, onNotify]);

  const summary = data?.summary ?? EMPTY_SUMMARY;
  const unavailable = !loading && Boolean(error) && data === null;
  const totalPages = Math.max(1, data?.total_pages ?? 1);
  const visibleIds = data?.items.map((item) => item.batch_id) ?? [];
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));

  const riskCards = [
    { risk: "high" as const, label: "High Risk Items", range: "0–3 days", note: "Need immediate action", icon: AlertTriangle, color: "red" },
    { risk: "medium" as const, label: "Medium Risk Items", range: "4–7 days", note: "Plan priority use", icon: AlertTriangle, color: "amber" },
    { risk: "low" as const, label: "Low Risk Items", range: "8–14 days", note: "Monitor stock rotation", icon: Users, color: "blue" },
    { risk: "safe" as const, label: "Safe Items", range: ">14 days", note: "No immediate action needed", icon: ShieldAlert, color: "green" },
  ];

  async function openBatch(batchId: number) {
    setDetailLoading(true);
    try {
      setDetail(await getExpiryAlertBatch(batchId));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not load batch details.";
      onNotify(message);
    } finally {
      setDetailLoading(false);
    }
  }

  async function exportRows() {
    try {
      const blob = await exportExpiryAlerts(request, exportFormat, selectedIds);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `wastewise-expiry-alerts.${exportFormat}`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      onNotify(`Expiry alert ${exportFormat.toUpperCase()} export downloaded.`);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Could not export expiry alerts.";
      onNotify(message);
    }
  }

  async function openRuleManager() {
    setShowRules(true);
    setRulesLoading(true);
    setEditingRule(null);
    setRuleForm(NEW_RULE);
    try {
      setRules(await listExpiryAlertRules());
    } catch (reason) {
      onNotify(reason instanceof Error ? reason.message : "Could not load alert rules.");
    } finally {
      setRulesLoading(false);
    }
  }

  function editRule(rule: ExpiryAlertRule) {
    setEditingRule(rule);
    setRuleForm({
      name: rule.name,
      days_before_expiry: rule.days_before_expiry,
      risk_level: rule.risk_level,
      category: rule.category,
      location: rule.location,
      supplier: rule.supplier,
      enabled: rule.enabled,
    });
  }

  async function saveRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingRule(true);
    try {
      if (editingRule) {
        await updateExpiryAlertRule(editingRule.rule_id, ruleForm);
        onNotify("Expiry alert rule updated.");
      } else {
        await createExpiryAlertRule(ruleForm);
        onNotify("Expiry alert rule created.");
      }
      setRules(await listExpiryAlertRules());
      setEditingRule(null);
      setRuleForm(NEW_RULE);
    } catch (reason) {
      onNotify(reason instanceof Error ? reason.message : "Could not save the alert rule.");
    } finally {
      setSavingRule(false);
    }
  }

  async function toggleRule(rule: ExpiryAlertRule) {
    try {
      await updateExpiryAlertRule(rule.rule_id, { enabled: !rule.enabled });
      setRules(await listExpiryAlertRules());
      onNotify(`Alert rule ${rule.enabled ? "disabled" : "enabled"}.`);
    } catch (reason) {
      onNotify(reason instanceof Error ? reason.message : "Could not update the alert rule.");
    }
  }

  async function removeRule(rule: ExpiryAlertRule) {
    try {
      await deleteExpiryAlertRule(rule.rule_id);
      setRules(await listExpiryAlertRules());
      if (editingRule?.rule_id === rule.rule_id) {
        setEditingRule(null);
        setRuleForm(NEW_RULE);
      }
      onNotify("Alert rule archived.");
    } catch (reason) {
      onNotify(reason instanceof Error ? reason.message : "Could not archive the alert rule.");
    }
  }

  function toggleBatch(batchId: number) {
    setSelectedIds((current) =>
      current.includes(batchId) ? current.filter((id) => id !== batchId) : [...current, batchId],
    );
  }

  function toggleVisibleSelection() {
    setSelectedIds((current) => allVisibleSelected
      ? current.filter((id) => !visibleIds.includes(id))
      : [...new Set([...current, ...visibleIds])]);
  }

  const totalForDonut = charts.risk_distribution.reduce((total, item) => total + item.count, 0);
  const maxRangeCount = Math.max(1, ...charts.expiring_next_14_days.map((item) => item.count));
  const maxCategoryCount = Math.max(1, ...charts.top_categories.map((item) => item.count));

  return (
    <main className="page-content expiry-page">
      <header className="expiry-banner">
        <div className="expiry-banner-copy">
          <span className="expiry-eyebrow">INVENTORY HEALTH</span>
          <h1>Expiry Alerts</h1>
          <p>Monitor products nearing expiry and take action to reduce waste</p>
        </div>
        <div className="expiry-banner-art" aria-hidden="true">
          <span className="expiry-leaves expiry-leaf-left">🌿</span>
          <span className="expiry-calendar">▦</span>
          <span className="expiry-clock">◷</span>
          <span className="expiry-leaves expiry-leaf-right">🌿</span>
        </div>
        {canManageRules && (
          <button type="button" className="expiry-add-button" onClick={() => void openRuleManager()}>
            <Plus size={16} /> Add Alert Rule
          </button>
        )}
      </header>

      {error && <div className="error-banner" role="alert"><AlertTriangle size={18} />{error}</div>}

      <section className="expiry-stats" aria-label="Expiry risk summary">
        {riskCards.map(({ risk: level, label, range, note, icon: Icon, color }) => {
          const count = summary.risk_counts[level];
          const percent = summary.total_batches ? Math.round((count / summary.total_batches) * 100) : 0;
          return (
            <article className="expiry-stat-card" key={level}>
              <span className={`expiry-stat-icon ${color}`}><Icon size={25} /></span>
              <div className="expiry-stat-copy">
                <span>{label}</span>
                <div><b>{loading || unavailable ? "—" : count}</b><small>({range})</small><i>{loading || unavailable ? "—" : `${percent}%`}</i></div>
                <em>{note}</em>
              </div>
            </article>
          );
        })}
      </section>
      <div className="expiry-summary-note">
        <span><CalendarDays size={13} /> {loading ? "Loading live inventory…" : unavailable ? "Expiry data unavailable" : `${summary.total_batches} batches with stock reviewed`}</span>
        <span className="expiry-expired-count"><AlertTriangle size={13} /> {loading || unavailable ? "—" : `${summary.expired} expired`}</span>
        <button type="button" aria-label="Refresh expiry alerts" disabled={loading} onClick={() => setRefreshKey((value) => value + 1)}><RefreshCw size={13} /> Refresh</button>
      </div>

      <section className="expiry-table-card" aria-label="Expiry alert batches">
        <div className="expiry-toolbar">
          <label className="expiry-search">
            <Search size={15} />
            <input aria-label="Search expiry alerts" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Search by product name, batch ID, or category..." />
            {query && <button type="button" aria-label="Clear search" onClick={() => { setQuery(""); setPage(1); }}><X size={13} /></button>}
          </label>
          <select aria-label="Filter expiry alerts by category" value={category} onChange={(event) => { setCategory(event.target.value); setPage(1); }}>
            <option value="">All Categories</option>{filters.categories.map((value) => <option key={value}>{value}</option>)}
          </select>
          <select aria-label="Filter expiry alerts by risk" value={risk} onChange={(event) => { setRisk(event.target.value as RiskFilter); setPage(1); }}>
            <option value="all">All Risk Levels</option>
            {(["expired", "high", "medium", "low", "safe"] as ExpiryRisk[]).map((value) => <option key={value} value={value}>{formatRiskLabel(value)}</option>)}
          </select>
          <select aria-label="Filter expiry alerts by location" value={location} onChange={(event) => { setLocation(event.target.value); setPage(1); }}>
            <option value="">All Locations</option>{filters.locations.map((value) => <option key={value}>{value}</option>)}
          </select>
          <select aria-label="Filter expiry alerts by supplier" value={supplier} onChange={(event) => { setSupplier(event.target.value); setPage(1); }}>
            <option value="">All Suppliers</option>{filters.suppliers.map((value) => <option key={value}>{value}</option>)}
          </select>
          {canExport && <>
            <select aria-label="Export format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as "csv" | "xlsx")}>
              <option value="csv">CSV</option><option value="xlsx">Excel</option>
            </select>
            <button type="button" className="expiry-export-button" onClick={() => void exportRows()} disabled={loading}>
              <Download size={14} /> Export{selectedIds.length ? ` (${selectedIds.length})` : ""}
            </button>
          </>}
        </div>

        <div className="expiry-table-scroll">
          <table className="expiry-table">
            <thead>
              <tr>
                <th className="expiry-check"><input aria-label="Select visible batches" type="checkbox" checked={allVisibleSelected} onChange={toggleVisibleSelection} /></th>
                <th>#</th><th>Product</th><th>Batch ID</th><th>Category</th><th>Expiry Date</th>
                <th>Days Left</th><th>Quantity</th><th>Risk Level</th><th>Suggested Action</th>
                <th>Location</th><th>Supplier</th><th>Action</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((item, index) => (
                <tr key={item.batch_id}>
                  <td className="expiry-check"><input aria-label={`Select batch ${item.batch_code}`} type="checkbox" checked={selectedIds.includes(item.batch_id)} onChange={() => toggleBatch(item.batch_id)} /></td>
                  <td>{(page - 1) * pageSize + index + 1}</td>
                  <td><span className="expiry-product"><i><ProductSymbolIcon symbol={productSymbol(item.product_name, item.category)} /></i>{item.product_name}{item.unit ? ` (${item.unit})` : ""}</span></td>
                  <td>{item.batch_code}</td>
                  <td>{item.category}</td>
                  <td className={item.risk === "high" || item.risk === "expired" ? "expiry-date-urgent" : item.risk === "safe" ? "expiry-date-safe" : ""}>{formatDate(item.expiry_date)}<small className="form-field-note">{item.expiry_date_source === "estimated" ? "Estimated" : item.expiry_date_source === "manufacturer_verified" ? "Manufacturer verified" : item.expiry_date_source === "manual_verified" ? "Manually verified" : item.expiry_date_source === "imported" ? "Imported" : "Unverified legacy date"}</small></td>
                  <td className={item.risk === "high" || item.risk === "expired" ? "expiry-days-urgent" : item.risk === "safe" ? "expiry-days-safe" : ""}>{item.days_to_expiry < 0 ? `${Math.abs(item.days_to_expiry)} overdue` : item.days_to_expiry}</td>
                  <td>{Number(item.quantity_remaining).toLocaleString()} {item.unit}</td>
                  <td><span className={`expiry-risk-pill ${item.risk}`}>{item.risk === "medium" && <i>◆</i>}{formatRiskLabel(item.risk)}</span></td>
                  <td><span className="expiry-suggestion" title={item.suggested_action}>{item.suggested_action}</span></td>
                  <td>{item.location}</td><td>{item.supplier}</td>
                  <td><div className="expiry-row-actions">
                    <button className="apply-expiry-action" type="button" title="Review suggested action; no inventory changes are made" onClick={() => void openBatch(item.batch_id)}>Review</button>
                    <button type="button" aria-label={`View ${item.batch_code} details`} title="View batch details" onClick={() => void openBatch(item.batch_id)}><Eye size={16} /></button>
                  </div></td>
                </tr>
              ))}
              {unavailable && <tr><td className="expiry-empty" colSpan={13}><AlertTriangle size={22} /><b>Expiry data could not be loaded.</b><span>Review the API/database error above and retry.</span></td></tr>}
              {!loading && !unavailable && data?.items.length === 0 && (
                <tr><td className="expiry-empty" colSpan={13}><CalendarDays size={22} /><b>No expiry alerts match these filters.</b><span>Try changing the search or filters.</span></td></tr>
              )}
              {loading && <tr><td className="expiry-empty" colSpan={13}>Loading live inventory batches…</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="expiry-table-footer">
          <span>{unavailable ? "Inventory data unavailable" : data?.total ? `Showing ${(page - 1) * pageSize + 1} to ${Math.min(page * pageSize, data.total)} of ${data.total} batches` : "Showing 0 batches"} <em>· live MySQL inventory</em></span>
          <nav className="expiry-pagination" aria-label="Expiry alert pages">
            <button type="button" aria-label="Previous page" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={14} /></button>
            {visiblePageNumbers(page, totalPages, 4).map((pageNumber) => <button type="button" key={pageNumber} className={page === pageNumber ? "current" : ""} aria-current={page === pageNumber ? "page" : undefined} onClick={() => setPage(pageNumber)} disabled={loading}>{pageNumber}</button>)}
            <button type="button" aria-label="Next page" disabled={page >= totalPages || loading} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}><ChevronRight size={14} /></button>
          </nav>
        </div>
      </section>

      <section className="expiry-charts-grid" aria-label="Expiry alert charts">
        <article className="expiry-chart-card">
          <div className="expiry-chart-title"><h2>Expiry Risk Distribution</h2></div>
          <div className="expiry-distribution">
            <div className="expiry-donut" style={{ background: donutGradient(charts, totalForDonut) }}>
              <div><b>{loading || unavailable ? "—" : totalForDonut}</b><span>{unavailable ? "Unavailable" : "Batches"}</span></div>
            </div>
            <div className="expiry-legend">
              {charts.risk_distribution.map(({ risk: level, count }) => (
                <div key={level}>
                  <i style={{ background: RISK_COLORS[level] }} />
                  <span>{formatRiskLabel(level)}{level === "high" ? " (0–3 days)" : level === "medium" ? " (4–7 days)" : level === "low" ? " (8–14 days)" : level === "safe" ? " (>14 days)" : ""}</span>
                  <b>{count} ({totalForDonut ? Math.round(count / totalForDonut * 100) : 0}%)</b>
                </div>
              ))}
            </div>
          </div>
        </article>
        <article className="expiry-chart-card">
          <div className="expiry-chart-title"><h2>Items Expiring in Next 14 Days</h2></div>
          <div className="expiry-bar-chart">
            <div className="expiry-chart-y"><span>{maxRangeCount}</span><span>{Math.round(maxRangeCount / 2)}</span><span>0</span></div>
            <div className="expiry-bar-plot">
              <div className="expiry-bar-grid"><i /><i /><i /></div>
              {charts.expiring_next_14_days.map(({ range, count }, index) => (
                <div className="expiry-bar-column" key={range}>
                  <b>{count}</b>
                  <span className={index === 0 ? "high" : index === 1 ? "medium" : "low"} style={{ height: `${Math.max(5, count / maxRangeCount * 75)}%` }} />
                  <small>{range}<br />days</small>
                </div>
              ))}
            </div>
          </div>
        </article>
        <article className="expiry-chart-card expiry-category-chart">
          <div className="expiry-chart-title"><h2>Top Categories by Expiring Items</h2></div>
          <div className="expiry-category-bars">
            {charts.top_categories.map(({ category: name, count }, index) => (
              <div className="expiry-category-row" key={name}>
                <span title={name}>{name}</span>
                <i><b style={{ width: `${count / maxCategoryCount * 100}%`, background: ["#fb565c", "#ffad1c", "#398df3", "#41c78c", "#9359ed", "#398df3"][index % 6] }} /></i>
                <strong>{count}</strong>
              </div>
            ))}
            {charts.top_categories.length === 0 && <span className="expiry-chart-empty">{unavailable ? "Chart data unavailable; see API/database error above." : "No batches expiring in the next 14 days."}</span>}
          </div>
        </article>
      </section>

      {detail && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setDetail(null); }}>
          <section className="batch-detail-modal expiry-detail-modal" role="dialog" aria-modal="true" aria-labelledby="expiry-detail-heading">
            <div className="modal-heading">
              <div><span className="modal-icon"><CalendarDays size={20} /></span><div><h2 id="expiry-detail-heading">Batch Details</h2><p>{detail.batch_code}</p></div></div>
              <button type="button" aria-label="Close batch details" onClick={() => setDetail(null)}><X size={20} /></button>
            </div>
            <div className="batch-detail-product">
              <span><ProductSymbolIcon symbol={productSymbol(detail.product_name, detail.category)} /></span>
              <div><b>{detail.product_name}</b><small>{detail.category} · SKU {detail.sku}</small></div>
              <span className={`expiry-risk-pill ${detail.risk}`}>{formatRiskLabel(detail.risk)}</span>
            </div>
            <div className="batch-detail-grid">
              <span>Quantity<b>{Number(detail.quantity_remaining).toLocaleString()} {detail.unit}</b></span>
              <span>Received date<b>{formatDate(detail.received_at)}</b></span>
              <span>Expiry date<b>{formatDate(detail.expiry_date)} · {detail.expiry_date_source === "estimated" ? "Estimated" : detail.expiry_date_source === "manufacturer_verified" ? "Manufacturer verified" : detail.expiry_date_source === "manual_verified" ? "Manually verified" : detail.expiry_date_source === "imported" ? "Imported" : "Unverified legacy date"}</b></span>
              <span>Days remaining<b>{detail.days_to_expiry}</b></span>
              <span>Storage location<b>{detail.location}</b></span>
              <span>Supplier<b>{detail.supplier}</b></span>
              <span>Suggested action<b>{detail.suggested_action}</b></span>
            </div>
            <p className="form-field-note">Suggested actions are informational; this review does not modify inventory or apply a discount.</p>
            <button type="button" className="save-button batch-detail-close" onClick={() => setDetail(null)}>{detailLoading ? "Loading…" : "Close"}</button>
          </section>
        </div>
      )}

      {showRules && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowRules(false); }}>
          <section className="product-modal expiry-rule-modal" role="dialog" aria-modal="true" aria-labelledby="expiry-rule-heading">
            <div className="modal-heading">
              <div><span className="modal-icon"><ShieldAlert size={20} /></span><div><h2 id="expiry-rule-heading">Expiry Alert Rules</h2><p>Rules are saved in the audit log; no inventory actions are triggered.</p></div></div>
              <button type="button" aria-label="Close alert rules" onClick={() => setShowRules(false)}><X size={20} /></button>
            </div>
            {canManageRules && (
              <form onSubmit={(event) => void saveRule(event)}>
                <label>Rule name<input required maxLength={120} value={ruleForm.name} onChange={(event) => setRuleForm({ ...ruleForm, name: event.target.value })} placeholder="e.g. Notify for near-expiry dairy" /></label>
                <div className="form-row">
                  <label>Days before expiry<input required type="number" min="0" max="365" value={ruleForm.days_before_expiry} onChange={(event) => setRuleForm({ ...ruleForm, days_before_expiry: Number(event.target.value) })} /></label>
                  <label>Risk level<select value={ruleForm.risk_level ?? ""} onChange={(event) => setRuleForm({ ...ruleForm, risk_level: (event.target.value || null) as ExpiryRisk | null })}><option value="">Any risk</option>{(["expired", "high", "medium", "low", "safe"] as ExpiryRisk[]).map((level) => <option key={level} value={level}>{formatRiskLabel(level)}</option>)}</select></label>
                </div>
                <div className="form-row">
                  <label>Category<select value={ruleForm.category ?? ""} onChange={(event) => setRuleForm({ ...ruleForm, category: event.target.value || null })}><option value="">All categories</option>{filters.categories.map((value) => <option key={value}>{value}</option>)}</select></label>
                  <label>Location<select value={ruleForm.location ?? ""} onChange={(event) => setRuleForm({ ...ruleForm, location: event.target.value || null })}><option value="">All locations</option>{filters.locations.map((value) => <option key={value}>{value}</option>)}</select></label>
                </div>
                <label>Supplier<select value={ruleForm.supplier ?? ""} onChange={(event) => setRuleForm({ ...ruleForm, supplier: event.target.value || null })}><option value="">All suppliers</option>{filters.suppliers.map((value) => <option key={value}>{value}</option>)}</select></label>
                <div className="modal-actions">
                  {editingRule && <button type="button" className="cancel-button" onClick={() => { setEditingRule(null); setRuleForm(NEW_RULE); }}>Cancel edit</button>}
                  <button type="submit" className="save-button" disabled={savingRule}>{savingRule ? "Saving…" : editingRule ? "Save Rule" : "Add Rule"}</button>
                </div>
              </form>
            )}
            <div className="expiry-rule-list">
              <h3>Saved rules</h3>
              {rulesLoading && <p>Loading rules…</p>}
              {!rulesLoading && rules.length === 0 && <p>No alert rules have been created.</p>}
              {rules.map((rule) => (
                <article key={rule.rule_id} className={!rule.enabled ? "disabled" : ""}>
                  <div><b>{rule.name}</b><small>Within {rule.days_before_expiry} days{rule.risk_level ? ` · ${formatRiskLabel(rule.risk_level)} risk` : ""}{rule.category ? ` · ${rule.category}` : ""}</small></div>
                  {canManageRules && <div className="expiry-rule-actions">
                    <button type="button" onClick={() => editRule(rule)}>Edit</button>
                    <button type="button" onClick={() => void toggleRule(rule)}>{rule.enabled ? "Disable" : "Enable"}</button>
                    <button type="button" aria-label={`Archive ${rule.name}`} onClick={() => void removeRule(rule)}><Trash2 size={14} /></button>
                  </div>}
                </article>
              ))}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
