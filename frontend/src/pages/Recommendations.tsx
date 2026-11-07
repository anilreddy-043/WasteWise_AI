import { useEffect, useMemo, useState } from "react";
import { applyRuleRecommendation, listDashboardRecommendations, markRecommendationApplied, recordRecommendationPurchase, receiveRecommendationStock } from "../services/dashboard";
import ProductSymbolIcon from "../components/ProductSymbol";
import { productSymbol } from "../services/productSymbols";
import { visiblePageNumbers } from "../services/pagination";
import { useGeneralSettings } from "../services/generalSettings";
import { calculateSuggestedExpiryDate, getShelfLifeDays, localDateIso } from "../services/expiryDates";
import type { ReactNode } from "react";
import {
  BarChart3,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  IndianRupee,
  Leaf,
  Lightbulb,
  PackageCheck,
  Search,
  Tag,
  Trash2,
  X,
} from "lucide-react";

type RecommendationType = "Discount" | "Reorder" | "Restock Soon" | "Remove/Dispose";
type Priority = "High" | "Medium" | "Low";

type Recommendation = {
  id: number;
  productId?: number;
  batchId?: number;
  emoji: string;
  name: string;
  category: string;
  stock: number;
  expiry: number | null;
  expiryDateSource: "estimated" | "manufacturer_verified" | "manual_verified" | "imported" | null;
  type: RecommendationType;
  action: string;
  impact: string;
  priority: Priority;
  status: "Pending" | "Approved" | "Ordered" | "Received" | "Rejected" | "Cancelled" | "Dismissed" | "Applied";
  backendType?: string;
  recommendedQuantity?: number;
};

const categoryNames = ["Fruits", "Bakery", "Dairy", "Vegetables", "Beverages", "Snacks"];
type DiscountImpactCategory = { name: string; current: number; expected: number };
const typeStats: { type: RecommendationType; count: number; share: number; color: string }[] = [
  { type: "Discount", count: 12, share: 60, color: "#09a05a" },
  { type: "Reorder", count: 8, share: 20, color: "#3989f5" },
  { type: "Restock Soon", count: 5, share: 10, color: "#ffad19" },
  { type: "Remove/Dispose", count: 3, share: 10, color: "#ff625d" },
];

function DiscountImpactChart({ recommendations }: { recommendations: Recommendation[] }) {
  const impactCategories = recommendations
    .filter((item) => item.type === "Discount")
    .reduce<DiscountImpactCategory[]>((categories, item) => {
      const category = categories.find((entry) => entry.name === item.category);
      const current = item.stock * 0;
      const expected = item.stock;
      if (category) {
        category.current += current;
        category.expected += expected;
      } else {
        categories.push({ name: item.category, current, expected });
      }
      return categories;
    }, []);
  const maxUnits = Math.max(1, ...impactCategories.map((item) => item.expected));
  const chartTicks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => maxUnits * fraction);
  return (
    <svg className="recommendation-impact-chart" viewBox="0 0 430 170" role="img" aria-label="Eligible discount units by category">
      {chartTicks.map((value) => {
        const y = 128 - (value / maxUnits) * 100;
        return <g key={value}><line x1="43" x2="397" y1={y} y2={y} stroke="#e8eef3" strokeDasharray="3 4" /><text x="36" y={y + 3} textAnchor="end">{Number(value.toFixed(1))}</text></g>;
      })}
      <text className="recommendation-axis-label" transform="translate(11 78) rotate(-90)" textAnchor="middle">Units</text>
      {impactCategories.map((item, index) => {
        const x = 57 + index * 54;
        const eligibleHeight = item.expected / maxUnits * 100;
        return <g key={item.name}>
          <rect x={x - 7} y={128 - eligibleHeight} width="28" height={eligibleHeight} rx="3" fill="#0c9d59" />
          <text x={x + 7} y="145" textAnchor="middle">{item.name}</text>
        </g>;
      })}
      {impactCategories.length === 0 && <text x="220" y="82" textAnchor="middle">No verified discount batches</text>}
    </svg>
  );
}

function RecommendationTypeChart({ recommendations }: { recommendations: Recommendation[] }) {
  const counts = typeStats.map((item) => ({ ...item, count: recommendations.filter((row) => row.type === item.type).length }));
  const total = counts.reduce((sum, item) => sum + item.count, 0);
  return (
    <div className="recommendation-type-layout">
      <div className="recommendation-donut" role="img" aria-label={`Recommendation types: ${total} total`}>
        <div><strong>{total}</strong><span>Total</span></div>
      </div>
      <ul className="recommendation-type-legend">
        {counts.map((item) => <li key={item.type}><i style={{ backgroundColor: item.color }} /><span>{item.type}</span><b>{item.count} ({total ? Math.round(item.count / total * 100) : 0}%)</b></li>)}
      </ul>
    </div>
  );
}

function ImpactTile({ variant, title, value, note, icon }: { variant: string; title: string; value: string; note: string; icon: ReactNode }) {
  return <article className={`recommendation-impact-tile ${variant}`}><span>{icon}</span><div><b>{title}</b><strong>{value}</strong><small>{note}</small></div></article>;
}

export default function Recommendations({ onNotify, canApply = false }: { onNotify: (message: string) => void; canApply?: boolean }) {
  const { items_per_page: pageSize } = useGeneralSettings();
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [recommendationsLoading, setRecommendationsLoading] = useState(true);
  const [recommendationsError, setRecommendationsError] = useState("");
  useEffect(() => {
    let active = true;
    listDashboardRecommendations(100)
      .then((rows) => {
        if (!active) return;
        const operational = rows.filter((item) => item.source !== "simulated_scenario").map((item): Recommendation => ({
          id: item.recommendation_id ?? 100000 + item.product_id * 10 + (item.batch_id ?? 0),
          productId: item.product_id,
          batchId: item.batch_id ?? undefined,
          emoji: productSymbol(item.product_name, item.product_category ?? undefined),
          name: item.product_name,
          category: item.product_category ?? "Inventory",
          stock: item.remaining_stock ?? 0,
          expiry: item.expiry_days ?? null,
          expiryDateSource: item.expiry_date_source ?? null,
          type: item.recommendation_type === "discount" ? "Discount"
            : item.recommendation_type === "reorder" ? "Reorder"
            : item.recommendation_type === "restock" || item.recommendation_type === "restock_soon" ? "Restock Soon"
            : "Remove/Dispose",
          action: item.discount_percent ? `Apply ${item.discount_percent}% discount` : item.reason,
          impact: item.expected_impact ?? (item.estimated_financial_impact != null ? `Estimated impact: ₹${item.estimated_financial_impact.toFixed(2)}` : "Impact unavailable – insufficient verified cost or sales data."),
          priority: (item.priority as Priority | null) ?? "Low",
          status: ({ pending: "Pending", approved: "Approved", ordered: "Ordered", received: "Received", rejected: "Rejected", cancelled: "Cancelled", dismissed: "Dismissed", applied: "Applied" } as Record<string, Recommendation["status"]>)[item.status] ?? "Pending",

          backendType: item.recommendation_type,
          recommendedQuantity: item.recommended_quantity ?? undefined,
        }));
        setRecommendations(operational);
        setRecommendationsLoading(false);
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : "Could not load recommendations";
        setRecommendationsError(message);
        setRecommendationsLoading(false);
        console.error(message);
      });
    return () => { active = false; };
  }, []);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("All Recommendation Types");
  const [category, setCategory] = useState("All Categories");
  const [priority, setPriority] = useState("All Priorities");
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [pageSize]);

  const filteredRecommendations = useMemo(() => recommendations.filter((item) => {
    const matchesQuery = `${item.name} ${item.category} ${item.type} ${item.action}`.toLowerCase().includes(query.trim().toLowerCase());
    return matchesQuery &&
      (type === "All Recommendation Types" || item.type === type) &&
      (category === "All Categories" || item.category === category) &&
      (priority === "All Priorities" || item.priority === priority);
  }), [category, priority, query, recommendations, type]);
  const pageCount = Math.max(1, Math.ceil(filteredRecommendations.length / pageSize));
  const visibleRecommendations = filteredRecommendations.slice((page - 1) * pageSize, page * pageSize);
  const discountCount = recommendations.filter((item) => item.type === "Discount").length;
  const reorderCount = recommendations.filter((item) => item.type === "Reorder" || item.type === "Restock Soon").length;
  const removeCount = recommendations.filter((item) => item.type === "Remove/Dispose").length;
  const wastePotential = recommendations.reduce((total, item) => item.type === "Remove/Dispose" || item.type === "Discount" ? total + item.stock : total, 0);

  function updateFilter(action: () => void) {
    action();
    setPage(1);
  }

  async function applyRecommendation(item: Recommendation) {
    if (!canApply) {
      onNotify("You do not have permission to apply discounts");
      return;
    }
    try {
      const discountMatch = item.action.match(/(\d+(?:\.\d+)?)%/);
      const backendType = item.backendType === "restock" || item.backendType === "restock_soon" ? "restock"
        : item.backendType === "remove" ? "remove"
        : item.backendType === "reorder" ? "reorder" : "discount";
      const replenishment = backendType === "restock" || backendType === "reorder";
      const originalId = item.id;
      let nextStatus: Recommendation["status"] = "Approved";
      if (item.status === "Pending") {
        if (!item.productId) throw new Error("Recommendation has no product.");
        const approval = await applyRuleRecommendation({ product_id: item.productId, batch_id: item.batchId, recommendation_type: backendType,
          discount_percent: discountMatch ? Number(discountMatch[1]) : undefined, recommended_quantity: item.recommendedQuantity });
        if (replenishment) item.id = approval.recommendation_id;
      } else if (item.status === "Approved" && replenishment) {
        await recordRecommendationPurchase(item.id);
        nextStatus = "Ordered";
      } else if ((item.status === "Approved" || item.status === "Ordered") && replenishment) {
        const batchCode = window.prompt("Received batch code")?.trim();
        const quantity = window.prompt("Actual quantity received", String(item.recommendedQuantity ?? ""));
        const receivedAt = window.prompt("Received date (YYYY-MM-DD)", localDateIso());
        const suggestedExpiry = receivedAt
          ? calculateSuggestedExpiryDate(item.category, receivedAt) ?? ""
          : "";
        const expiryLabel = getShelfLifeDays(item.category)
          ? `Expiry date (YYYY-MM-DD; suggested from ${item.category}, verify the batch label)`
          : "Expiry date (YYYY-MM-DD; no category default, verify the batch label)";
        const expiryDate = window.prompt(expiryLabel, suggestedExpiry);
        if (!batchCode || !quantity || !receivedAt || !expiryDate) throw new Error("Batch receipt details are required.");
        const expiryDateSource = expiryDate === suggestedExpiry && window.confirm(
          "Use this category-based expiry as an estimate? Choose Cancel if this is a verified manufacturer or manually confirmed date.",
        ) ? "estimated" : "manual_verified";
        await receiveRecommendationStock(item.id, {
          batch_code: batchCode,
          quantity_received: Number(quantity),
          received_at: receivedAt,
          expiry_date: expiryDate,
          expiry_date_source: expiryDateSource,
        });
        nextStatus = "Received";
      } else {
        await markRecommendationApplied(item.id);
      }
      setRecommendations((current) => current.map((recommendation) =>
        recommendation.id === originalId ? { ...recommendation, id: replenishment && item.status === "Pending" ? item.id : recommendation.id, status: replenishment && item.status !== "Pending" ? nextStatus : "Approved" } : recommendation,
      ));
      onNotify(replenishment && nextStatus !== "Approved" ? `${nextStatus}: ${item.name}` : `${item.type} recommendation approved for ${item.name}`);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "Could not apply recommendation");
    }
  }

  function exportRecommendations() {
    const rows = [
      ["Product", "Category", "Current Stock", "Days to Expiry", "Recommendation Type", "Suggested Action", "Expected Impact", "Priority", "Status"],
      ...filteredRecommendations.map((item) => [item.name, item.category, item.stock, item.expiry, item.type, item.action, item.impact, item.priority, item.status]),
    ];
    const csv = rows.map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "wastewise-recommendations.csv";
    anchor.click();
    URL.revokeObjectURL(url);
    onNotify("Recommendations exported");
  }

  return (
    <div className="recommendations-page">
      <section className="recommendations-banner">
        <div className="recommendations-banner-copy">
          <h1>AI Recommendations</h1>
          <p>Get intelligent suggestions to reduce waste and maximize profits</p>
        </div>
        <div className="recommendations-banner-art" aria-hidden="true">
          <span className="recommendation-plant plant-left">🌿</span>
          <span className="recommendation-plant plant-middle">🌱</span>
          <span className="recommendation-robot"><i /><b>••</b><em /></span>
          <span className="recommendation-plant plant-right">🌿</span>
          <div className="recommendation-speech"><Lightbulb size={17} /><b>AI Suggestions<br />for a Smarter,<br />Greener Store</b></div>
        </div>
      </section>
      {recommendationsError && <div className="dashboard-inline-error" role="alert">Recommendations unavailable: {recommendationsError}</div>}

      <section className="recommendations-stats" aria-label="Recommendation summary">
        <article className="recommendation-stat-card"><div className="recommendation-stat-icon green"><Tag size={28} /></div><div><span>Discount Recommendations</span><strong>{discountCount}</strong><small>Products to discount</small></div></article>
        <article className="recommendation-stat-card"><div className="recommendation-stat-icon blue"><PackageCheck size={28} /></div><div><span>Reorder Recommendations</span><strong>{reorderCount}</strong><small>Products to reorder or restock</small></div></article>
        <article className="recommendation-stat-card"><div className="recommendation-stat-icon red"><Trash2 size={28} /></div><div><span>Waste Reduction Potential</span><strong>{wastePotential.toFixed(0)}</strong><small>Units covered by verified actions</small></div></article>
        <article className="recommendation-stat-card"><div className="recommendation-stat-icon purple"><IndianRupee size={29} /></div><div><span>Additional Revenue Potential</span><strong>{removeCount} disposal batches</strong><small>Financial impact requires verified cost and demand</small></div></article>
      </section>

      <section className="recommendation-insights" aria-label="Recommendation insights">
        <article className="recommendation-insight-card discount-impact-card">
          <h2>Recommended Discount Impact</h2>
          <div className="recommendation-chart-legend"><span><i className="revenue-expected" />Verified discount batch units</span></div>
          <DiscountImpactChart recommendations={recommendations} />
        </article>
        <article className="recommendation-insight-card recommendation-types-card">
          <h2>Recommendation Types</h2>
          <RecommendationTypeChart recommendations={recommendations} />
        </article>
        <article className="recommendation-insight-card estimated-impact-card">
          <h2>Estimated Impact</h2>
          <div className="recommendation-impact-grid">
            <ImpactTile variant="waste" title="Reduce Waste" value={`${wastePotential.toFixed(0)} units`} note="Covered by verified actions" icon={<BarChart3 size={25} />} />
            <ImpactTile variant="revenue" title="Discount Batches" value={`${discountCount}`} note="Rule-based suggestions" icon={<IndianRupee size={25} />} />
            <ImpactTile variant="co2" title="Expiry removals" value={`${removeCount}`} note="Expired batches only" icon={<Leaf size={25} />} />
            <ImpactTile variant="turnover" title="Stock actions" value={`${reorderCount}`} note="Demand forecast signals" icon={<BarChart3 size={25} />} />
          </div>
        </article>
      </section>

      <section className="recommendations-table-panel" aria-label="Product recommendations">
        <div className="recommendations-toolbar">
          <label className="recommendations-search"><Search size={16} /><input value={query} onChange={(event) => updateFilter(() => setQuery(event.target.value))} placeholder="Search products by name, category, or SKU..." />{query && <button type="button" aria-label="Clear search" onClick={() => updateFilter(() => setQuery(""))}><X size={14} /></button>}</label>
          <label className="recommendation-filter"><select aria-label="Filter by recommendation type" value={type} onChange={(event) => updateFilter(() => setType(event.target.value))}><option>All Recommendation Types</option>{typeStats.map((item) => <option key={item.type}>{item.type}</option>)}</select><ChevronDown size={13} /></label>
          <label className="recommendation-filter"><select aria-label="Filter by category" value={category} onChange={(event) => updateFilter(() => setCategory(event.target.value))}><option>All Categories</option>{categoryNames.map((item) => <option key={item}>{item}</option>)}</select><ChevronDown size={13} /></label>
          <label className="recommendation-filter"><select aria-label="Filter by priority" value={priority} onChange={(event) => updateFilter(() => setPriority(event.target.value))}><option>All Priorities</option><option>High</option><option>Medium</option><option>Low</option></select><ChevronDown size={13} /></label>
          <button className="recommendations-export" type="button" onClick={exportRecommendations}><Download size={15} /> Export</button>
        </div>
        <div className="recommendations-table-scroll">
          <table className="recommendations-table">
            <thead><tr><th>#</th><th>Product</th><th>Category</th><th>Current Stock</th><th>Days to Expiry</th><th>Recommendation Type</th><th>Suggested Action</th><th>Expected Impact</th><th>Priority</th><th>Status</th><th>Action</th></tr></thead>
            <tbody>{visibleRecommendations.length ? visibleRecommendations.map((item, index) => (
              <tr key={item.id}>
                <td>{(page - 1) * pageSize + index + 1}</td>
                <td><span className="recommendation-product-emoji"><ProductSymbolIcon symbol={item.emoji} /></span><b>{item.name}</b></td>
                <td>{item.category}</td><td>{item.stock}</td><td className={item.expiry !== null && item.expiry <= 5 ? "recommendation-expiry-soon" : ""}>{item.expiry === null ? "—" : <>{item.expiry}<small className="form-field-note">{item.expiryDateSource === "estimated" ? "Estimated" : item.expiryDateSource === "manufacturer_verified" ? "Manufacturer verified" : item.expiryDateSource === "manual_verified" ? "Manually verified" : item.expiryDateSource === "imported" ? "Imported" : "Unverified legacy date"}</small></>}</td>
                <td><span className={`recommendation-type-pill ${item.type.toLowerCase().replace(/[^a-z]+/g, "-")}`}>{item.type}</span></td>
                <td>{item.action}</td><td>{item.impact}</td>
                <td><span className={`recommendation-priority ${item.priority.toLowerCase()}`}>{item.priority}</span></td>
                <td><span className={`recommendation-status ${item.status.toLowerCase()}`}>{item.status}</span></td>
                <td><button className={`recommendation-apply ${item.status.toLowerCase()}`} type="button" disabled={["Received", "Rejected", "Cancelled", "Dismissed", "Applied"].includes(item.status) || !canApply} onClick={() => applyRecommendation(item)}>{
                  item.status === "Pending" ? ((item.type === "Reorder" || item.type === "Restock Soon") ? "Approve Restock" : "Approve")
                  : item.status === "Approved" && (item.type === "Reorder" || item.type === "Restock Soon") ? "Record Purchase"
                  : item.status === "Ordered" ? "Receive Stock"
                  : item.status
                }</button></td>
              </tr>
            )) : <tr><td className="recommendations-empty" colSpan={11}>{recommendationsLoading ? "Loading recommendations..." : "No recommendations match these filters."}</td></tr>}</tbody>
          </table>
        </div>
        <footer className="recommendations-table-footer">
          <span>Showing {filteredRecommendations.length ? (page - 1) * pageSize + 1 : 0} to {Math.min(page * pageSize, filteredRecommendations.length)} of {filteredRecommendations.length} recommendations</span>
          <nav aria-label="Recommendations pagination">
            <button type="button" aria-label="Previous page" disabled={page === 1} onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronLeft size={16} /></button>
            {visiblePageNumbers(page, pageCount, 5).map((number) => <button key={number} type="button" aria-current={page === number ? "page" : undefined} className={page === number ? "current" : ""} onClick={() => setPage(number)}>{number}</button>)}
            <button type="button" aria-label="Next page" disabled={page === pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))}><ChevronRight size={16} /></button>
          </nav>
        </footer>
      </section>
    </div>
  );
}
