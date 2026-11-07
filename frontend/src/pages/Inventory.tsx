import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  AlertTriangle,
  Archive,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Database,
  Download,
  Eye,
  MapPin,
  Package,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { deleteProduct, listBatches, listInventorySummary, updateBatch } from "../services/business";
import type { InventoryBatchRecord, InventorySummaryRecord } from "../services/business";
import ProductSymbolIcon from "../components/ProductSymbol";
import { productSymbol } from "../services/productSymbols";
import { useGeneralSettings } from "../services/generalSettings";
import { formatAppDate } from "../services/generalSettings";

type InventoryItem = {
  id: number;
  emoji: string;
  product: string;
  sku: string;
  category: string;
  unit: string;
  supplier: string;
  stock: number;
  reserved: number | null;
  reorder: number;
  location: string;
  value: number;
};

type InventoryProps = { onNotify: (message: string) => void; canEditBatchDates: boolean; canDeleteProducts?: boolean };

const categoryColors: Record<string, string> = {
  fruits: "fruit",
  dairy: "dairy",
  bakery: "bakery",
  vegetables: "vegetable",
  beverages: "beverage",
};

function inventoryItem(
  row: InventorySummaryRecord,
  batches: InventoryBatchRecord[],
): InventoryItem {
  const locations = [...new Set(
    batches.filter((batch) => batch.product_id === row.product_id).map((batch) => batch.location),
  )];
  return {
    id: row.product_id,
    emoji: productSymbol(row.product_name, row.category),
    product: row.product_name,
    sku: row.sku,
    category: row.category,
    unit: row.unit,
    supplier: row.supplier,
    stock: row.quantity,
    reserved: null,
    reorder: 10,
    location: locations.length === 0 ? "Unassigned" : locations.length === 1 ? locations[0] : "Multiple",
    value: row.inventory_value,
  };
}

function formatInventoryDate(value: string): string {
  return formatAppDate(value);
}

export default function Inventory({ onNotify, canEditBatchDates, canDeleteProducts = true }: InventoryProps) {
  const { items_per_page: pageSize } = useGeneralSettings();
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [batches, setBatches] = useState<InventoryBatchRecord[]>([]);
  const [editingBatch, setEditingBatch] = useState<InventoryBatchRecord | null>(null);
  const [viewingBatch, setViewingBatch] = useState<InventoryBatchRecord | null>(null);
  const [receivedDate, setReceivedDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [expiryDateSource, setExpiryDateSource] = useState<InventoryBatchRecord["expiry_date_source"] | "">("");
  const [savingBatch, setSavingBatch] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All Categories");
  const [status, setStatus] = useState("All Status");
  const [location, setLocation] = useState("All Locations");
  const [currentPage, setCurrentPage] = useState(1);
  const [selected, setSelected] = useState<number[]>([]);
  const [batchQuery, setBatchQuery] = useState("");
  const [batchStatusFilter, setBatchStatusFilter] = useState("All statuses");
  const [batchSortBy, setBatchSortBy] = useState<"expiry" | "received" | "product">("expiry");
  const [batchSortDirection, setBatchSortDirection] = useState<"asc" | "desc">("asc");
  const [batchPage, setBatchPage] = useState(1);
  useEffect(() => {
    setCurrentPage(1);
    setBatchPage(1);
  }, [pageSize]);

  useEffect(() => {
    let active = true;
    Promise.all([listInventorySummary(), listBatches()])
      .then(([summary, batches]) => {
        if (active) {
          setItems(summary.map((row) => inventoryItem(row, batches)));
          setBatches(batches);
        }
      })
      .catch((error: unknown) => {
        if (active) onNotify(error instanceof Error ? error.message : "Could not load inventory.");
      });
    return () => { active = false; };
  }, [onNotify]);

  const filteredItems = useMemo(() => items.filter((item) => {
    const needle = query.trim().toLowerCase();
    const matchesQuery = !needle || [item.product, item.sku, item.category, item.location].some((value) => value.toLowerCase().includes(needle));
    const isOut = item.stock === 0;
    const isLow = !isOut && item.stock <= item.reorder;
    const matchesStatus = status === "All Status" || (status === "In Stock" ? !isLow && !isOut : status === "Low Stock" ? isLow : isOut);
    return matchesQuery && (category === "All Categories" || item.category === category) && matchesStatus && (location === "All Locations" || item.location === location);
  }), [items, query, category, status, location]);

  const totalPages = Math.max(1, Math.ceil(filteredItems.length / pageSize));
  const visibleItems = filteredItems.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const productById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const filteredBatches = useMemo(() => {
    const needle = batchQuery.trim().toLowerCase();
    return batches
      .filter((batch) => {
        const product = productById.get(batch.product_id);
        const productName = product?.product ?? `Product #${batch.product_id}`;
        const matchesSearch = !needle || [batch.batch_code, productName, batch.location, batch.supplier ?? ""]
          .some((value) => value.toLowerCase().includes(needle));
        const daysRemaining = daysUntilExpiry(batch.expiry_date);
        const statusValue = Number(batch.quantity_remaining) <= 0
          ? "Consumed/Sold"
          : daysRemaining < 0 ? "Expired" : daysRemaining <= 7 ? "Expiring Soon" : "Fresh";
        return matchesSearch && (batchStatusFilter === "All statuses" || statusValue === batchStatusFilter);
      })
      .sort((first, second) => {
        const firstValue = batchSortBy === "expiry" ? first.expiry_date
          : batchSortBy === "received" ? first.received_at
          : productById.get(first.product_id)?.product ?? `Product #${first.product_id}`;
        const secondValue = batchSortBy === "expiry" ? second.expiry_date
          : batchSortBy === "received" ? second.received_at
          : productById.get(second.product_id)?.product ?? `Product #${second.product_id}`;
        const comparison = firstValue.localeCompare(secondValue, undefined, { numeric: true, sensitivity: "base" });
        return batchSortDirection === "asc" ? comparison : -comparison;
      });
  }, [batches, batchQuery, batchStatusFilter, batchSortBy, batchSortDirection, productById]);
  const batchTotalPages = Math.max(1, Math.ceil(filteredBatches.length / pageSize));
  const visibleBatches = filteredBatches.slice((batchPage - 1) * pageSize, batchPage * pageSize);
  const totalQuantity = items.reduce((sum, item) => sum + item.stock, 0);
  const inventoryValue = items.reduce((sum, item) => sum + item.value, 0);
  const lowStockItems = items.filter((item) => item.stock > 0 && item.stock <= item.reorder);
  const outOfStockItems = items.filter((item) => item.stock === 0);
  const inStockCount = items.filter((item) => item.stock > item.reorder).length;
  const lowStockCount = lowStockItems.length;
  const outOfStockCount = outOfStockItems.length;
  const stockCount = Math.max(1, items.length);
  const stockSlices = [
    { count: inStockCount, color: "#18a65a" },
    { count: lowStockCount, color: "#f7b52d" },
    { count: outOfStockCount, color: "#ed5a5a" },
  ];
  const stockGradient = items.length === 0
    ? "conic-gradient(#e9eef2 0% 100%)"
    : `conic-gradient(${stockSlices.map((slice, index) => {
      const start = stockSlices.slice(0, index).reduce((sum, item) => sum + item.count, 0) / stockCount * 100;
      return `${slice.color} ${start}% ${start + slice.count / stockCount * 100}%`;
    }).join(", ")})`;
  const categoryBars = [...new Set(items.map((item) => item.category))].map((name) => ({
    name,
    value: items.filter((item) => item.category === name).reduce((sum, item) => sum + item.value, 0),
    color: categoryColors[name.toLowerCase()] ?? "fruit",
  }));
  const maxCategoryValue = Math.max(1, ...categoryBars.map((bar) => bar.value));
  const categoryChartMax = Math.max(1000, Math.ceil(maxCategoryValue / 1000) * 1000);

  function resetFilters() {
    setQuery("");
    setCategory("All Categories");
    setStatus("All Status");
    setLocation("All Locations");
    setCurrentPage(1);
  }

  async function removeProducts(ids: number[]) {
    if (!canDeleteProducts) {
      onNotify("Your role cannot delete products.");
      return;
    }
    let removed = 0;
    try {
      for (const id of ids) {
        await deleteProduct(id);
        removed += 1;
      }
      const [summary, batches] = await Promise.all([listInventorySummary(), listBatches()]);
      setItems(summary.map((row) => inventoryItem(row, batches)));
      setBatches(batches);
      onNotify(`${removed} product${removed === 1 ? "" : "s"} deleted`);
    } catch (error) {
      try {
        const [summary, batches] = await Promise.all([listInventorySummary(), listBatches()]);
        setItems(summary.map((row) => inventoryItem(row, batches)));
        setBatches(batches);
      } catch (refreshError) {
        onNotify(refreshError instanceof Error ? refreshError.message : "The inventory list could not be refreshed.");
      }
      onNotify(
        removed
          ? `${removed} product${removed === 1 ? "" : "s"} deleted. ${error instanceof Error ? error.message : "The remaining products could not be deleted."}`
          : error instanceof Error ? error.message : "Could not delete product.",
      );
    } finally {
      setSelected([]);
      setCurrentPage(1);
    }
  }

  function exportInventory() {
    const header = ["Product", "Category", "Current Stock", "Reserved", "Available", "Reorder Level", "Status", "Location"];
    const rows = filteredItems.map((item) => {
      const available = item.stock;
      const stockStatus = item.stock === 0 ? "Out of Stock" : item.stock <= item.reorder ? "Low Stock" : "In Stock";
      return [item.product, item.category, item.stock, "Not tracked", available, item.reorder, stockStatus, item.location]
        .map((value) => `"${String(value).replace(/"/g, '""')}"`)
        .join(",");
    });
    const url = URL.createObjectURL(new Blob([[header.join(","), ...rows].join("\n")], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "wastewise-inventory.csv";
    anchor.click();
    URL.revokeObjectURL(url);
    onNotify("Inventory exported");
  }

  function toggleAll() {
    const visibleIds = visibleItems.map((item) => item.id);
    setSelected((current) => visibleIds.every((id) => current.includes(id)) ? current.filter((id) => !visibleIds.includes(id)) : [...new Set([...current, ...visibleIds])]);
  }

  function openBatchEdit(batch: InventoryBatchRecord) {
    setEditingBatch(batch);
    setReceivedDate(batch.received_at);
    setExpiryDate(batch.expiry_date);
    setExpiryDateSource(batch.expiry_date_source ?? "");
  }

  async function saveBatchDates(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingBatch || savingBatch) return;
    if (expiryDate < receivedDate) {
      onNotify("Expiry date cannot be before received date.");
      return;
    }
    setSavingBatch(true);
    try {
      const updatedBatch = await updateBatch(editingBatch.batch_id, {
        received_at: receivedDate,
        expiry_date: expiryDate,
        expiry_date_source: expiryDateSource || null,
      });
      setBatches((current) => current.map((batch) => (
        batch.batch_id === updatedBatch.batch_id ? updatedBatch : batch
      )));
      setEditingBatch(null);
      let refreshedSummary: InventorySummaryRecord[];
      let refreshedBatches: InventoryBatchRecord[];
      try {
        [refreshedSummary, refreshedBatches] = await Promise.all([listInventorySummary(), listBatches()]);
      } catch (refreshError) {
        onNotify(`Batch dates saved, but inventory could not be refreshed: ${refreshError instanceof Error ? refreshError.message : "Refresh failed."}`);
        return;
      }
      setItems(refreshedSummary.map((row) => inventoryItem(row, refreshedBatches)));
      setBatches(refreshedBatches);
      onNotify("Batch dates updated");
    } catch (error) {
      onNotify(error instanceof Error ? error.message : "Could not update batch dates.");
    } finally {
      setSavingBatch(false);
    }
  }

  function daysUntilExpiry(value: string): number {
    const [year, month, day] = value.split("-").map(Number);
    const todayDate = new Date();
    const todayYear = todayDate.getFullYear();
    const todayMonth = todayDate.getMonth() + 1;
    const todayDay = todayDate.getDate();
    const target = Date.UTC(year, month - 1, day);
    const today = Date.UTC(todayYear, todayMonth - 1, todayDay);
    return Math.round((target - today) / 86400000);
  }

  return (
    <div className="inventory-page">
      <section className="inventory-banner">
        <div className="inventory-banner-copy">
          <span className="inventory-eyebrow">STOCK CONTROL</span>
          <h1>Inventory</h1>
          <p>Track and manage your current stock levels</p>
        </div>
        <div className="warehouse-art" aria-hidden="true">
          <span className="warehouse-plant plant-left">🌿</span><span className="warehouse-box box-left">📦</span>
          <span className="warehouse-shelf"><i>🧃 🥫 🥛</i><i>🥫 🧃 🥫</i><i>📦 🥫 🧃</i></span>
          <span className="warehouse-box box-right">📦</span><span className="warehouse-plant plant-right">🌱</span>
        </div>
        <button className="inventory-add-button" onClick={() => onNotify("Add dated stock batches in Batch Management.")}><Plus size={18} /> Add Inventory</button>
      </section>

      <section className="inventory-stats" aria-label="Inventory summary">
        <InventoryStat icon={<Package size={25} />} color="green" title="Total Inventory" value={totalQuantity.toLocaleString("en-IN")} change="" note="Aggregated product quantities" />
        <InventoryStat icon={<Database size={25} />} color="blue" title="Inventory Value" value={`₹ ${inventoryValue.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`} change="" note="At product selling prices" />
        <InventoryStat icon={<AlertTriangle size={25} />} color="amber" title="Low Stock Items" value={String(lowStockCount)} change="" alert note="Default threshold: 10 units" />
        <InventoryStat icon={<Archive size={25} />} color="red" title="Out of Stock" value={String(outOfStockCount)} change="" neutral note="Currently unavailable" />
      </section>

      <section className="inventory-content-grid">
        <article className="inventory-table-card">
          <div className="inventory-toolbar">
            <label className="inventory-search"><Search size={17} /><input value={query} onChange={(event) => { setQuery(event.target.value); setCurrentPage(1); }} placeholder="Search inventory by product name, SKU, or category..." />{query && <button aria-label="Clear inventory search" onClick={() => setQuery("")}><X size={14} /></button>}</label>
            <select aria-label="Inventory category" value={category} onChange={(event) => { setCategory(event.target.value); setCurrentPage(1); }}><option>All Categories</option>{[...new Set(items.map((item) => item.category))].map((name) => <option key={name}>{name}</option>)}</select>
            <select aria-label="Inventory status" value={status} onChange={(event) => { setStatus(event.target.value); setCurrentPage(1); }}><option>All Status</option><option>In Stock</option><option>Low Stock</option><option>Out of Stock</option></select>
            <select aria-label="Inventory location" value={location} onChange={(event) => { setLocation(event.target.value); setCurrentPage(1); }}><option>All Locations</option>{[...new Set(items.map((item) => item.location))].map((name) => <option key={name}>{name}</option>)}</select>
            <button className="inventory-export-button" onClick={exportInventory}><Download size={16} /> Export</button>
          </div>
          {canDeleteProducts && selected.length > 0 && <div className="inventory-selection"><span>{selected.length} selected</span><button onClick={() => { void removeProducts(selected); }}>Remove selected</button></div>}
          <div className="inventory-table-scroll">
            <table className="inventory-table">
              <thead><tr><th className="inventory-check"><input type="checkbox" aria-label="Select all inventory rows" checked={visibleItems.length > 0 && visibleItems.every((item) => selected.includes(item.id))} onChange={toggleAll} /></th><th>#</th><th>Product</th><th>Category</th><th>Current Stock</th><th>Reserved</th><th>Available</th><th>Reorder Level</th><th>Status</th><th>Location</th><th>Action</th></tr></thead>
              <tbody>
                {visibleItems.map((item, index) => {
                  const available = item.stock;
                  const itemStatus = item.stock === 0 ? "Out of Stock" : item.stock <= item.reorder ? "Low Stock" : "In Stock";
                  return <tr key={item.id}><td className="inventory-check"><input type="checkbox" aria-label={`Select ${item.product}`} checked={selected.includes(item.id)} onChange={() => setSelected((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])} /></td><td>{(currentPage - 1) * pageSize + index + 1}</td><td><span className="inventory-product"><i><ProductSymbolIcon symbol={item.emoji} /></i>{item.product}</span></td><td>{item.category}</td><td className={item.stock === 0 ? "inventory-zero" : ""}>{item.stock}</td><td>{item.reserved === null ? "—" : item.reserved}</td><td className={available === 0 ? "inventory-zero" : "inventory-available"}>{available}</td><td>{item.reorder}</td><td><span className={`inventory-status ${itemStatus.toLowerCase().replace(/ /g, "-")}`}>{itemStatus}</span></td><td>{item.location}</td><td><div className="inventory-row-actions"><button aria-label={`Edit ${item.product}`} title="Edit stock in Batch Management" onClick={() => onNotify("Stock quantities and locations are managed in Batch Management.")}><Pencil size={14} /></button><button aria-label={`Duplicate ${item.product}`} title="Duplicate product in Products" onClick={() => onNotify("Use Products to create or duplicate catalog items.")}><Copy size={14} /></button><button className="inventory-delete" aria-label={`Delete ${item.product}`} title="Delete product" onClick={() => { void removeProducts([item.id]); }}><Trash2 size={14} /></button></div></td></tr>;
                })}
                {visibleItems.length === 0 && <tr><td colSpan={11} className="inventory-empty"><Search size={22} /><b>No inventory items found</b><span>Try a different search or filter.</span><button onClick={resetFilters}>Clear filters</button></td></tr>}
              </tbody>
            </table>
          </div>
          <footer className="inventory-table-footer"><span>Showing {filteredItems.length ? (currentPage - 1) * pageSize + 1 : 0} to {Math.min(currentPage * pageSize, filteredItems.length)} of {filteredItems.length} inventory items <em>· Actual data</em></span><div className="inventory-pagination"><button aria-label="Previous inventory page" disabled={currentPage === 1} onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}><ChevronLeft size={16} /></button><button className="selected-page">{currentPage}</button><button aria-label="Next inventory page" disabled={currentPage === totalPages} onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}><ChevronRight size={16} /></button></div></footer>
        </article>

        <aside className="inventory-side-panels">
          <article className="inventory-side-card distribution-card">
            <div className="inventory-side-heading"><h2>Stock Status Distribution</h2><button className="inventory-side-export" onClick={exportInventory}><Download size={14} /> Export</button></div>
            <div className="stock-distribution">
              <div className="inventory-donut" style={{ background: stockGradient }}><div><b>{items.length}</b><span>Products</span></div></div>
              <div className="stock-legend">
                <div><i className="stock-in" /><span>In Stock</span><b>{Math.round(inStockCount / stockCount * 100)}%</b></div>
                <div><i className="stock-low" /><span>Low Stock</span><b>{Math.round(lowStockCount / stockCount * 100)}%</b></div>
                <div><i className="stock-out" /><span>Out of Stock</span><b>{Math.round(outOfStockCount / stockCount * 100)}%</b></div>
                <div><i className="stock-reserved" /><span>Reserved</span><b>Not tracked</b></div>
              </div>
            </div>
          </article>

          <article className="inventory-side-card category-value-card" tabIndex={0} title="Double-click to expand chart">
          <div className="inventory-side-heading"><h2>Inventory Value by Category</h2><span className="inventory-chart-expand-hint">Double-click to expand</span></div>
          <div className="category-value-chart" role="img" aria-label="Inventory value by category"><div className="category-axis">{[4, 3, 2, 1, 0].map((step) => <span key={step}>₹ {Math.round(categoryChartMax * step / 4).toLocaleString("en-IN")}</span>)}</div><div className="category-plot">{categoryBars.map((bar) => <div className="category-bar-column" key={bar.name} aria-label={`${bar.name}: ₹ ${bar.value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`} title={`${bar.name}: ₹ ${bar.value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`}><b style={{ bottom: `calc(${bar.value / categoryChartMax * 100}% + 4px)` }}>₹ {bar.value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</b><span className={bar.color} style={{ height: `${bar.value / categoryChartMax * 100}%` }} /><small>{bar.name}</small></div>)}</div></div>
          </article>

          <article className="inventory-side-card low-stock-side-card">
            <div className="inventory-side-heading"><h2>Low Stock &amp; Out of Stock</h2><button className="inventory-view-link" onClick={() => { setStatus("Low Stock"); setCurrentPage(1); }}>View All</button></div>
            <div className="low-stock-list"><div className="low-stock-head"><b>Product</b><b>Current Stock</b><b>Reorder Level</b><b>Status</b></div>
              {[...lowStockItems, ...outOfStockItems].slice(0, 4).map((item) => <div className="low-stock-row" key={item.id}><span><i><ProductSymbolIcon symbol={item.emoji} /></i>{item.product}</span><b className={item.stock === 0 ? "inventory-zero" : "inventory-available"}>{item.stock}</b><span>{item.reorder}</span><span className={`inventory-status ${item.stock === 0 ? "out-of-stock" : "low-stock"}`}>{item.stock === 0 ? "Out of Stock" : "Low Stock"}</span></div>)}
              {[...lowStockItems, ...outOfStockItems].length === 0 && <p className="no-low-stock"><Check size={15} /> No products meet the default threshold</p>}
            </div>
          </article>
          <div className="inventory-location-note"><MapPin size={13} /> Multiple indicates stock in more than one batch location</div>
        </aside>
      </section>

      <section className="inventory-table-card inventory-batches-card" aria-labelledby="inventory-batches-heading">
        <div className="inventory-side-heading">
          <div><h2 id="inventory-batches-heading">Batch expiry dates</h2><p>Actual expiry dates are stored per batch and drive expiry alerts.</p></div>
        </div>
        <div className="inventory-batch-toolbar">
        <label className="inventory-batch-search"><Search size={16} /><input aria-label="Search batches" value={batchQuery} onChange={(event) => { setBatchQuery(event.target.value); setBatchPage(1); }} placeholder="Search product, batch, location, or supplier" /></label>
        <select aria-label="Filter batch status" value={batchStatusFilter} onChange={(event) => { setBatchStatusFilter(event.target.value); setBatchPage(1); }}>
          <option>All statuses</option><option>Fresh</option><option>Expiring Soon</option><option>Expired</option><option>Consumed/Sold</option>
        </select>
        <label className="inventory-batch-sort">Sort by
          <select aria-label="Sort batches by" value={batchSortBy} onChange={(event) => { setBatchSortBy(event.target.value as typeof batchSortBy); setBatchPage(1); }}>
            <option value="expiry">Expiry date</option><option value="received">Received date</option><option value="product">Product</option>
          </select>
        </label>
        <button type="button" className="inventory-batch-sort-direction" aria-label={`Sort batches ${batchSortDirection === "asc" ? "descending" : "ascending"}`} onClick={() => setBatchSortDirection((direction) => direction === "asc" ? "desc" : "asc")}>{batchSortDirection === "asc" ? "Ascending" : "Descending"}</button>
        </div>
        <div className="batch-table-scroll">
          <table className="batch-table">
          <thead><tr><th>Batch ID</th><th>Product</th><th>Received Date</th><th>Expiry Date</th><th>Days Remaining</th><th>Quantity</th><th>Batch Status</th><th>Actions</th></tr></thead>
          <tbody>
            {visibleBatches.map((batch) => {
              const daysRemaining = daysUntilExpiry(batch.expiry_date);
              const product = productById.get(batch.product_id);
              const productName = product?.product ?? `Product #${batch.product_id}`;
                const batchStatus = Number(batch.quantity_remaining) <= 0
                  ? "Consumed/Sold"
                  : daysRemaining < 0 ? "Expired" : daysRemaining <= 7 ? "Expiring Soon" : "Fresh";
                return <tr key={batch.batch_id}>
                  <td><span className="inventory-batch-code">{batch.batch_code}</span></td>
                  <td>
                    <span className="inventory-product inventory-batch-product">
                      <i className="product-symbol" aria-hidden="true"><ProductSymbolIcon symbol={productSymbol(productName, product?.category)} /></i>
                      <span>{productName}<small>{product?.category ?? "Category unavailable"}</small></span>
                    </span>
                  </td>
                  <td>{formatInventoryDate(batch.received_at)}</td>
                  <td className={daysRemaining < 0 ? "batch-expired-date" : daysRemaining <= 7 ? "batch-expiry-soon" : "batch-expiry-fresh"}>
                    <span>{formatInventoryDate(batch.expiry_date)}</span>
                    <small className="inventory-expiry-source">{batch.expiry_date_source === "estimated" ? "Estimated" : batch.expiry_date_source === "manufacturer_verified" ? "Manufacturer verified" : batch.expiry_date_source === "manual_verified" ? "Manually verified" : batch.expiry_date_source === "imported" ? "Imported" : "Unverified legacy date"}</small>
                  </td>
                  <td className={daysRemaining < 0 ? "batch-days-expired" : daysRemaining <= 7 ? "batch-days-soon" : "batch-days-fresh"}>{Number(batch.quantity_remaining) <= 0 ? "—" : daysRemaining < 0 ? `${Math.abs(daysRemaining)}d overdue` : `${daysRemaining}d left`}</td>
                  <td>{Number(batch.quantity_remaining).toLocaleString()} <small>{product?.unit ?? ""}</small></td>
                  <td><span className={`batch-status ${batchStatus.toLowerCase().replace(/ /g, "-").replace("/", "-")}`}>{batchStatus}</span></td>
                  <td><div className="inventory-batch-actions"><button className="inventory-batch-view" aria-label={`View details for ${batch.batch_code}`} title="View batch details" onClick={() => setViewingBatch(batch)}><Eye size={14} /></button>{canEditBatchDates && <button className="inventory-batch-edit" aria-label={`Edit dates for ${batch.batch_code}`} title="Edit received and expiry dates" onClick={() => openBatchEdit(batch)}><Pencil size={14} /></button>}</div></td>
                </tr>;
              })}
              {visibleBatches.length === 0 && <tr><td colSpan={8} className="inventory-empty">{batches.length === 0 ? "No inventory batches found." : "No batches match your search and filters."}</td></tr>}
            </tbody>
          </table>
        </div>
        <footer className="inventory-batch-footer"><span>Showing {filteredBatches.length ? (batchPage - 1) * pageSize + 1 : 0} to {Math.min(batchPage * pageSize, filteredBatches.length)} of {filteredBatches.length} batches</span><div className="inventory-pagination"><button aria-label="Previous batch page" disabled={batchPage === 1} onClick={() => setBatchPage((page) => Math.max(1, page - 1))}><ChevronLeft size={16} /></button><span>{batchPage} / {batchTotalPages}</span><button aria-label="Next batch page" disabled={batchPage === batchTotalPages} onClick={() => setBatchPage((page) => Math.min(batchTotalPages, page + 1))}><ChevronRight size={16} /></button></div></footer>
      </section>

      {viewingBatch && (() => {
        const product = productById.get(viewingBatch.product_id);
        const daysRemaining = daysUntilExpiry(viewingBatch.expiry_date);
        const status = Number(viewingBatch.quantity_remaining) <= 0
          ? "Consumed/Sold"
          : daysRemaining < 0 ? "Expired" : daysRemaining <= 7 ? "Expiring Soon" : "Fresh";
        return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setViewingBatch(null); }}>
          <section className="batch-detail-modal" role="dialog" aria-modal="true" aria-labelledby="inventory-batch-detail-heading">
            <div className="modal-heading"><div><span className="modal-icon"><Package size={20} /></span><div><h2 id="inventory-batch-detail-heading">Batch Details</h2><p>{viewingBatch.batch_code}</p></div></div><button type="button" aria-label="Close batch details" onClick={() => setViewingBatch(null)}><X size={20} /></button></div>
            <div className="batch-detail-product"><span aria-hidden="true"><ProductSymbolIcon symbol={productSymbol(product?.product ?? `Product #${viewingBatch.product_id}`, product?.category)} /></span><div><b>{product?.product ?? `Product #${viewingBatch.product_id}`}</b><small>{product?.category ?? "Category unavailable"} · SKU {product?.sku ?? "Unavailable"}</small></div><span className={`batch-status ${status.toLowerCase().replace(/ /g, "-").replace("/", "-")}`}>{status}</span></div>
            <div className="batch-detail-grid">
              <span>Received date<b>{formatInventoryDate(viewingBatch.received_at)}</b></span>
              <span>Expiry date<b>{formatInventoryDate(viewingBatch.expiry_date)}</b><small>{viewingBatch.expiry_date_source === "estimated" ? "Estimated" : viewingBatch.expiry_date_source === "manufacturer_verified" ? "Manufacturer verified" : viewingBatch.expiry_date_source === "manual_verified" ? "Manually verified" : viewingBatch.expiry_date_source === "imported" ? "Imported" : "Unverified legacy date"}</small></span>
              <span>Days remaining<b>{Number(viewingBatch.quantity_remaining) <= 0 ? "—" : daysRemaining < 0 ? `${Math.abs(daysRemaining)}d overdue` : `${daysRemaining}d left`}</b></span>
              <span>Quantity remaining<b>{Number(viewingBatch.quantity_remaining).toLocaleString()} {product?.unit ?? ""}</b></span>
              <span>Quantity received<b>{Number(viewingBatch.quantity_received).toLocaleString()} {product?.unit ?? ""}</b></span>
              <span>Location<b>{viewingBatch.location}</b></span>
              <span>Supplier<b>{viewingBatch.supplier ?? product?.supplier ?? "Not recorded"}</b></span>
            </div>
            <div className="modal-actions"><button type="button" className="cancel-button" onClick={() => setViewingBatch(null)}>Close</button>{canEditBatchDates && <button type="button" className="save-button" onClick={() => { setViewingBatch(null); openBatchEdit(viewingBatch); }}><Pencil size={15} /> Edit Dates</button>}</div>
          </section>
        </div>;
      })()}

      {canEditBatchDates && editingBatch && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditingBatch(null); }}>
        <form className="product-modal batch-modal" onSubmit={saveBatchDates}>
          <div className="modal-heading"><div><span className="modal-icon"><CalendarDays size={20} /></span><div><h2>Edit Batch Dates</h2><p>{editingBatch.batch_code}</p></div></div><button type="button" aria-label="Close batch date editor" onClick={() => setEditingBatch(null)}><X size={20} /></button></div>
          <label>Received date<input type="date" required value={receivedDate} onChange={(event) => setReceivedDate(event.target.value)} /></label>
          <label>Expiry date<input type="date" required min={receivedDate} value={expiryDate} onChange={(event) => { setExpiryDate(event.target.value); setExpiryDateSource("manual_verified"); }} /></label>
          <label>Expiry date basis<select value={expiryDateSource ?? ""} onChange={(event) => setExpiryDateSource(event.target.value as InventoryBatchRecord["expiry_date_source"] | "")}>
            <option value="">Unverified / legacy</option>
            <option value="estimated">Category-based estimate</option>
            <option value="manufacturer_verified">Manufacturer verified</option>
            <option value="manual_verified">Manually verified</option>
            <option value="imported">Imported</option>
          </select></label>
          <small className="form-field-note">Estimated dates are suggestions. Manufacturer and imported dates take priority. Estimated dates are recalculated if their received date changes.</small>
          <div className="modal-actions"><button type="button" className="cancel-button" onClick={() => setEditingBatch(null)}>Cancel</button><button type="submit" className="save-button" disabled={savingBatch}><Check size={16} /> {savingBatch ? "Saving…" : "Save Dates"}</button></div>
        </form>
      </div>}

    </div>
  );
}

function InventoryStat({ icon, color, title, value, change, alert = false, neutral = false, note }: { icon: ReactNode; color: string; title: string; value: string; change: string; alert?: boolean; neutral?: boolean; note: string }) {
  return <article className="inventory-stat-card"><span className={`inventory-stat-icon ${color}`}>{icon}</span><div className="inventory-stat-body"><span>{title}</span><div><b>{value}</b><i className={`${alert ? "alert" : ""} ${neutral ? "neutral" : ""}`}>{change}</i></div><small>{note}</small></div></article>;
}
