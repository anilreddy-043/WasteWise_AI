import { useEffect, useMemo, useState } from "react";
import type { CheckoutTransaction, ProductRecord, SaleRecord } from "../services/business";
import { listProducts, listSales, listSalesTransactions } from "../services/business";
import { visiblePageNumbers } from "../services/pagination";
import { useGeneralSettings } from "../services/generalSettings";
import { formatAppDate, formatAppTime } from "../services/generalSettings";
import {
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  Search,
  ShoppingCart,
  Users,
  Box,
  ClipboardList,
  X,
} from "lucide-react";
import CategoryFilterChips from "../components/CategoryFilterChips";

type Transaction = {
  rowId: string;
  id: string;
  timestamp: string;
  date: string;
  time: string;
  product: string;
  category: string;
  quantity: string;
  unitPrice: number;
  total: number;
  payment: string;
  location: string;
};

type Order = {
  id: string;
  timestamp: string;
  date: string;
  time: string;
  total: number;
  payment: string;
  customerName: string;
  customerPhone: string;
  products: string;
  quantity: string;
  categories: string[];
  checkout?: CheckoutTransaction;
};

const categoryColors = ["green", "blue", "orange", "red", "pink", "purple"];
const categoryHexColors = ["#18a557", "#438ff1", "#ffb530", "#ff635f", "#f34b75", "#a17afb"];

function numericValue(value: number | string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error("Sales history contains an invalid numeric value.");
  }
  return parsed;
}

function toTransaction(sale: SaleRecord, product: ProductRecord | undefined): Transaction {
  return {
    rowId: `SALE${String(sale.sale_id).padStart(5, "0")}`,
    id: `SALE${String(sale.sale_id).padStart(5, "0")}`,
    timestamp: sale.sold_at,
    date: formatAppDate(sale.sold_at),
    time: formatAppTime(sale.sold_at),
    product: product?.name ?? `Product #${sale.product_id}`,
    category: product?.category ?? "Uncategorized",
    quantity: `${numericValue(sale.quantity)} ${product?.unit ?? ""}`.trim(),
    unitPrice: numericValue(sale.unit_price),
    total: numericValue(sale.total_amount),
    payment: "Not recorded",
    location: "Not recorded",
  };
}

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toCheckoutRows(checkout: CheckoutTransaction, productsById: Map<number, ProductRecord>): Transaction[] {
  return checkout.items.map((item) => {
    const product = productsById.get(item.product_id);
    return {
      rowId: `${checkout.transaction_number}-${item.sale_item_id}`,
      id: checkout.transaction_number,
      timestamp: checkout.sold_at,
      date: formatAppDate(checkout.sold_at),
      time: formatAppTime(checkout.sold_at),
      product: product?.name ?? `Product #${item.product_id}`,
      category: product?.category ?? "Uncategorized",
      quantity: `${numericValue(item.quantity)} ${product?.unit ?? ""}`.trim(),
      unitPrice: numericValue(item.unit_price),
      total: numericValue(item.line_total),
      payment: checkout.payment_method.toUpperCase(),
      location: "Not recorded",
    };
  });
}

export default function SalesHistory({ onNotify, canExport = false }: { onNotify: (message: string) => void; canExport?: boolean }) {
  const { items_per_page: pageSize } = useGeneralSettings();
  const [productCatalog, setProductCatalog] = useState<ProductRecord[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All Categories");
  const [payment, setPayment] = useState("All Payment Methods");
  const [location, setLocation] = useState("All Locations");
  const [viewingOrder, setViewingOrder] = useState<Order | null>(null);
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [pageSize]);
  const [period, setPeriod] = useState("Last 30 Days");
  useEffect(() => {
    let active = true;
    Promise.all([listSales(), listSalesTransactions(), listProducts()])
      .then(([sales, salesTransactions, products]) => {
        if (!active) return;
        const productsById = new Map(products.map((product) => [product.product_id, product]));
        setProductCatalog(products);
        const completedSales = salesTransactions.filter((transaction) => transaction.status === "completed");
        const legacySales = sales.filter((sale) => sale.source !== "pos");
        setTransactions([
          ...completedSales.flatMap((transaction) => toCheckoutRows(transaction, productsById)),
          ...legacySales.map((sale) => toTransaction(sale, productsById.get(sale.product_id))),
        ].sort((a, b) => b.timestamp.localeCompare(a.timestamp)));
        setOrders([
          ...completedSales.map((transaction) => {
            const productNames = transaction.items.map((item) => productsById.get(item.product_id)?.name ?? `Product #${item.product_id}`);
            const quantity = transaction.items.reduce((total, item) => total + numericValue(item.quantity), 0);
            return {
              id: transaction.transaction_number,
              timestamp: transaction.sold_at,
              date: formatAppDate(transaction.sold_at),
              time: formatAppTime(transaction.sold_at),
              total: numericValue(transaction.total_amount),
              payment: transaction.payment_method.toUpperCase(),
              customerName: transaction.customer_name?.trim() || "Walk-in customer",
              customerPhone: transaction.customer_phone?.trim() || "Not recorded",
              products: productNames.join(", "),
              quantity: quantity.toLocaleString("en-IN", { maximumFractionDigits: 3 }),
              categories: [...new Set(transaction.items.map((item) => productsById.get(item.product_id)?.category ?? "Uncategorized"))],
              checkout: transaction,
            };
          }),
          ...legacySales.map((sale) => {
            const product = productsById.get(sale.product_id);
            return {
              id: `SALE${String(sale.sale_id).padStart(5, "0")}`,
              timestamp: sale.sold_at,
              date: formatAppDate(sale.sold_at),
              time: formatAppTime(sale.sold_at),
              total: numericValue(sale.total_amount),
              payment: "Not recorded",
              customerName: "Not recorded",
              customerPhone: "Not recorded",
              products: product?.name ?? `Product #${sale.product_id}`,
              quantity: numericValue(sale.quantity).toLocaleString("en-IN", { maximumFractionDigits: 3 }),
              categories: [product?.category ?? "Uncategorized"],
            };
          }),
        ].sort((a, b) => b.timestamp.localeCompare(a.timestamp)));
      })
      .catch((error: unknown) => {
        if (active) onNotify(error instanceof Error ? error.message : "Could not load sales history.");
      });
    return () => { active = false; };
  }, [onNotify]);

  const periodTransactions = useMemo(() => {
    const now = new Date();
    const start = new Date(now);
    if (period === "Last 7 Days") start.setDate(now.getDate() - 6);
    else if (period === "Last 30 Days") start.setDate(now.getDate() - 29);
    else start.setDate(1);
    start.setHours(0, 0, 0, 0);
    return transactions.filter((transaction) => {
      const timestamp = new Date(transaction.timestamp);
      return timestamp >= start && timestamp <= now;
    });
  }, [period, transactions]);

  const periodOrders = useMemo(() => {
    const now = new Date();
    const start = new Date(now);
    if (period === "Last 7 Days") start.setDate(now.getDate() - 6);
    else if (period === "Last 30 Days") start.setDate(now.getDate() - 29);
    else start.setDate(1);
    start.setHours(0, 0, 0, 0);
    return orders.filter((order) => {
      const timestamp = new Date(order.timestamp);
      return timestamp >= start && timestamp <= now;
    });
  }, [orders, period]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return periodOrders.filter((order) => {
      const matchesQuery = !term || [
        order.products,
        order.id,
        order.payment,
        order.customerName,
        order.customerPhone,
        ...order.categories,
      ].some((value) => value.toLowerCase().includes(term));
      return matchesQuery && (category === "All Categories" || order.categories.includes(category)) &&
        (payment === "All Payment Methods" || order.payment === payment) &&
        (location === "All Locations" || location === "Not recorded");
    });
  }, [periodOrders, query, category, payment, location]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visibleOrders = filtered.slice((page - 1) * pageSize, page * pageSize);
  const totalSales = periodOrders.reduce((sum, order) => sum + order.total, 0);
  const itemsSold = periodTransactions.reduce((sum, transaction) => sum + Number.parseFloat(transaction.quantity), 0);
  const averageOrder = periodOrders.length ? totalSales / periodOrders.length : 0;
  const productTotals = new Map<string, number>();
  const categoryTotals = new Map<string, number>();
  const dailyTotals = new Map<string, number>();
  for (const transaction of periodTransactions) {
    productTotals.set(transaction.product, (productTotals.get(transaction.product) ?? 0) + Number.parseFloat(transaction.quantity));
    categoryTotals.set(transaction.category, (categoryTotals.get(transaction.category) ?? 0) + transaction.total);
    const day = dateKey(new Date(transaction.timestamp));
    dailyTotals.set(day, (dailyTotals.get(day) ?? 0) + transaction.total);
  }
  const topProduct = [...productTotals.entries()].sort((a, b) => b[1] - a[1])[0];
  const topCategoryValue = Math.max(0, ...categoryTotals.values());
  const categoryAxisMaximum = topCategoryValue || 1;
  const categoryBars = [...categoryTotals.entries()].sort((a, b) => b[1] - a[1]).map(([label, total]) => ({
    label,
    current: total / categoryAxisMaximum * 100,
    currentValue: total.toLocaleString("en-IN", { maximumFractionDigits: 2 }),
  }));
  const sortedCategoryTotals = [...categoryTotals.entries()].sort((a, b) => b[1] - a[1]);
  const rawCategoryShares = sortedCategoryTotals.map(([, total]) => totalSales ? total / totalSales * 100 : 0);
  const roundedCategoryShares = rawCategoryShares.map(Math.floor);
  let sharesToDistribute = totalSales
    ? 100 - roundedCategoryShares.reduce((sum, share) => sum + share, 0)
    : 0;
  const shareRemainderOrder = rawCategoryShares
    .map((share, index) => ({ index, remainder: share - roundedCategoryShares[index] }))
    .sort((a, b) => b.remainder - a.remainder);
  for (let index = 0; index < sharesToDistribute; index += 1) {
    roundedCategoryShares[shareRemainderOrder[index].index] += 1;
  }
  let accumulatedPercentage = 0;
  const categorySegments = sortedCategoryTotals.map(([label], index) => {
    const percentage = rawCategoryShares[index];
    const segment = {
      label,
      percentage: `${roundedCategoryShares[index]}%`,
      color: categoryColors[index % categoryColors.length],
      hex: categoryHexColors[index % categoryHexColors.length],
      start: accumulatedPercentage,
      end: accumulatedPercentage + percentage,
    };
    accumulatedPercentage += percentage;
    return segment;
  });
  const categorySales = categorySegments.map(({ label, percentage, color }) => ({
    label,
    percentage,
    color,
  }));
  const now = new Date();
  const startDate = new Date(now);
  if (period === "Last 7 Days") startDate.setDate(now.getDate() - 6);
  else if (period === "Last 30 Days") startDate.setDate(now.getDate() - 29);
  else startDate.setDate(1);
  startDate.setHours(0, 0, 0, 0);
  const dailySeries: Array<[string, number]> = [];
  for (const date = new Date(startDate); date <= now; date.setDate(date.getDate() + 1)) {
    const key = dateKey(date);
    dailySeries.push([key, dailyTotals.get(key) ?? 0]);
  }
  const maxDailyTotal = Math.max(1, ...dailySeries.map(([, total]) => total));
  const dailyAxisLabels = [1, 0.75, 0.5, 0.25, 0].map((fraction) =>
    (maxDailyTotal * fraction).toLocaleString("en-IN", { maximumFractionDigits: 0 }),
  );
  const linePoints: number[][] = dailySeries.map(([, total], index) => [
    dailySeries.length > 1 ? index / (dailySeries.length - 1) * 100 : 50,
    90 - total / maxDailyTotal * 80,
  ]);
  const dateRange = periodOrders.length
    ? `${formatAppDate(periodOrders.reduce((earliest, order) => order.timestamp < earliest ? order.timestamp : earliest, periodOrders[0].timestamp))} - ${formatAppDate(periodOrders.reduce((latest, order) => order.timestamp > latest ? order.timestamp : latest, periodOrders[0].timestamp))}`
    : "No recorded sales";

  function exportTransactions() {
    const header = ["Transaction ID", "Date", "Time", "Customer", "Contact", "Products", "Categories", "Quantity", "Total", "Payment Method"];
    const rows = filtered.map((transaction) =>
      [transaction.id, transaction.date, transaction.time, transaction.customerName, transaction.customerPhone, transaction.products, transaction.categories.join(", "), transaction.quantity, transaction.total, transaction.payment]
        .map((value) => `"${String(value).replace(/"/g, '""')}"`).join(","),
    );
    const blob = new Blob([[header.join(","), ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "wastewise-sales-history.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="sales-history-page">
      <header className="sales-hero">
        <div className="sales-hero-copy"><h1>Sales History</h1><p>Analyze your sales, understand trends, and make better inventory decisions</p></div>
        <div className="sales-hero-art" aria-hidden="true">
          <span className="sales-art-bars"><i /><i /><i /><i /><i /></span>
          <span className="sales-art-trend">↗</span>
          <span className="sales-basket">🧺</span>
          <span className="sales-basket-produce">🥕🍅🥬</span>
          <span className="sales-leaf sales-leaf-right">⌁</span>
        </div>
        <button className="sales-date-button" type="button"><CalendarDays size={15} /> {dateRange} <ChevronDown size={14} /></button>
      </header>

      <section className="sales-kpis" aria-label="Sales summary">
        <SalesKpi icon={<ShoppingCart size={25} fill="currentColor" />} color="green" label="Total Sales" value={`₹ ${totalSales.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`} change="" note="Actual recorded sales" />
        <SalesKpi icon={<Box size={25} />} color="blue" label="Items Sold" value={itemsSold.toLocaleString("en-IN", { maximumFractionDigits: 2 })} change="" note="Recorded quantity" />
        <SalesKpi icon={<ClipboardList size={25} />} color="purple" label="Average Order Value" value={`₹ ${averageOrder.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`} change="" note="Per completed order" />
        <SalesKpi icon={<Users size={25} fill="currentColor" />} color="orange" label="Transactions" value={String(periodOrders.length)} change="" note="In selected period" />
        <SalesKpi icon={<ShoppingCart size={25} />} color="red" label="Top Selling Product" value={topProduct?.[0] ?? "—"} change={topProduct ? `${topProduct[1]} recorded qty` : ""} note="By recorded quantity" />
      </section>

      <section className="sales-analytics" aria-label="Sales analytics">
        <article className="sales-chart-card sales-trend-card">
          <div className="sales-card-heading"><h2>Daily Sales Trend</h2><label className="sales-period-select"><select aria-label="Sales trend period" value={period} onChange={(event) => { setPeriod(event.target.value); setPage(1); }}><option>Last 30 Days</option><option>Last 7 Days</option><option>This Month</option></select><ChevronDown size={13} /></label></div>
          <div className="sales-chart-legend"><span><i /> Actual daily sales</span></div>
          <div className="sales-line-chart">
            <span className="sales-axis-title">Sales (₹)</span><div className="sales-y-axis">{dailyAxisLabels.map((label, index) => <span key={index}>{label}</span>)}</div>
            <svg viewBox="0 0 400 100" preserveAspectRatio="none" role="img" aria-label={`Daily sales trend, peak ₹${maxDailyTotal.toLocaleString("en-IN")}`} data-testid="daily-sales-chart">
              <defs><linearGradient id="sales-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#48c979" stopOpacity=".4" /><stop offset="100%" stopColor="#48c979" stopOpacity=".04" /></linearGradient></defs>
              {[10, 30, 50, 70, 90].map((y) => <line key={y} x1="0" x2="400" y1={y} y2={y} stroke="#e7edf2" strokeWidth="1" />)}
              <polygon points={`0,100 ${linePoints.map(([x, y]) => `${x * 4},${y}`).join(" ")} 400,100`} fill="url(#sales-fill)" />
              <polyline points={linePoints.map(([x, y]) => `${x * 4},${y}`).join(" ")} fill="none" stroke="#16a454" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
              {linePoints.map(([x, y], index) => <circle key={dailySeries[index][0]} cx={x * 4} cy={y} r="3.5" fill="#0e9e4b" data-date={dailySeries[index][0]} />)}
            </svg>
            {periodOrders.length === 0 && <span className="sales-chart-empty">No sales in this period</span>}
            <div className="sales-x-axis"><span>{dailySeries[0]?.[0] ? formatAppDate(dailySeries[0][0]) : ""}</span><span>{dailySeries.length ? formatAppDate(dailySeries[dailySeries.length - 1][0]) : ""}</span></div>
          </div>
        </article>
        <article className="sales-chart-card sales-category-card">
          <div className="sales-card-heading"><h2>Sales by Category</h2></div>
          <div className="sales-bar-legend"><span><i /> Actual net sales</span></div>
          <div className="sales-category-chart">
            <div className="sales-category-y-axis"><span>₹ {Math.round(categoryAxisMaximum).toLocaleString("en-IN")}</span><span>₹ {Math.round(categoryAxisMaximum * .75).toLocaleString("en-IN")}</span><span>₹ {Math.round(categoryAxisMaximum * .5).toLocaleString("en-IN")}</span><span>₹ {Math.round(categoryAxisMaximum * .25).toLocaleString("en-IN")}</span><span>₹ 0</span></div>
            <div className="sales-category-plot" style={{ gridTemplateColumns: `repeat(${Math.max(categoryBars.length, 1)}, minmax(0, 1fr))` }}>
              {categoryBars.map((item) => <div className="sales-category-group" key={item.label}>
                <div className="sales-category-pair">
                  <span className="sales-bar-value" style={{ bottom: `${item.current}%` }}>{item.currentValue}</span><i className="current" style={{ height: `${item.current}%` }} title={`${item.label}: ₹${item.currentValue}`} />
                </div>
                <span className="sales-category-label">{item.label}</span>
              </div>)}
            </div>
          </div>
        </article>
        <article className="sales-chart-card sales-products-card">
          <div className="sales-card-heading"><h2>Sales Distribution</h2></div>
          <div className="sales-donut-content"><div className="sales-donut" data-testid="sales-distribution-chart" style={{ background: categorySegments.length ? `conic-gradient(${categorySegments.map((item) => `${item.hex} ${item.start}% ${item.end}%`).join(", ")})` : "#e9eef2" }}><div><b>₹ {totalSales.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</b><span>Total Sales</span></div></div><div className="sales-category-legend">
            {categorySales.length ? categorySales.map((item) => <div className="sales-legend-row" key={item.label}><i className={item.color} /><span>{item.label}</span><b>{item.percentage}</b></div>) : <span className="sales-no-category-data">No sales data</span>}
          </div></div>
        </article>
      </section>

      <section className="sales-table-panel">
        <div className="sales-filter-toolbar">
          <label className="sales-table-search"><Search size={17} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Search customer, contact, product, or transaction..." />{query && <button aria-label="Clear search" onClick={() => { setQuery(""); setPage(1); }}><X size={14} /></button>}</label>
          <CategoryFilterChips
            categories={[...new Set(transactions.map((item) => item.category))]}
            value={category}
            onChange={(value) => { setCategory(value); setPage(1); }}
            ariaLabel="Filter sales by category"
            allLabel="All"
          />
          <SalesFilter value={payment} onChange={(value) => { setPayment(value); setPage(1); }} options={["All Payment Methods", ...new Set(transactions.map((item) => item.payment))]} label="Filter by payment method" />
          <SalesFilter value={location} onChange={(value) => { setLocation(value); setPage(1); }} options={["All Locations", "Not recorded"]} label="Filter by location" />
          {canExport && <button className="sales-export-button" onClick={exportTransactions}><Download size={16} /> Export</button>}
        </div>
        <div className="sales-table-scroll"><table className="sales-table">
          <thead><tr><th>#</th><th>Customer</th><th>Contact Number</th><th>Products Purchased</th><th>Quantity</th><th>Total (₹)</th><th>Date &amp; Time</th><th>Transaction ID</th><th>Payment Method</th><th>Action</th></tr></thead>
          <tbody>
            {visibleOrders.map((order, index) => <tr key={order.id}>
              <td>{(page - 1) * pageSize + index + 1}</td><td>{order.customerName}</td><td>{order.customerPhone}</td>
              <td title={order.products}>{order.products}</td><td>{order.quantity}</td><td>{order.total.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</td><td>{order.date} {order.time}</td><td>{order.id}</td><td>{order.payment}</td>
              <td><button className="sales-view-button" aria-label={`View transaction ${order.id}`} title={`View ${order.id}`} onClick={() => setViewingOrder(order)}><Eye size={15} /></button></td>
            </tr>)}
            {visibleOrders.length === 0 && <tr><td className="sales-empty" colSpan={10}>No transactions found. Try adjusting your search or filters.</td></tr>}
          </tbody>
        </table></div>
        <footer className="sales-table-footer"><span>Showing {filtered.length ? (page - 1) * pageSize + 1 : 0} to {Math.min(page * pageSize, filtered.length)} of {filtered.length} orders</span>
          <div className="sales-pagination" aria-label="Transaction pages">
            <button aria-label="Previous page" disabled={page === 1} onClick={() => setPage((current) => Math.max(1, current - 1))}><ChevronLeft size={17} /></button>
            {visiblePageNumbers(page, totalPages, 5).map((pageNumber) => <button key={pageNumber} className={page === pageNumber ? "current" : ""} aria-current={page === pageNumber ? "page" : undefined} onClick={() => setPage(pageNumber)}>{pageNumber}</button>)}
            <button aria-label="Next page" disabled={page === totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}><ChevronRight size={17} /></button>
          </div>
        </footer>
      </section>
      {viewingOrder && <div className="sales-detail-backdrop" role="presentation" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setViewingOrder(null);
      }}>
        <section className="sales-detail-modal" role="dialog" aria-modal="true" aria-labelledby="sales-detail-title">
          <header className="sales-detail-heading">
            <div><h2 id="sales-detail-title">Purchase Details</h2><p>{viewingOrder.id}</p></div>
            <button type="button" aria-label="Close purchase details" onClick={() => setViewingOrder(null)}><X size={20} /></button>
          </header>
          <div className="sales-detail-customer">
            <div><span>Customer</span><strong>{viewingOrder.customerName}</strong></div>
            <div><span>Contact number</span><strong>{viewingOrder.customerPhone}</strong></div>
            <div><span>Purchased</span><strong>{viewingOrder.date} at {viewingOrder.time}</strong></div>
            <div><span>Payment method</span><strong>{viewingOrder.payment}</strong></div>
          </div>
          {viewingOrder.checkout ? <>
            <div className="sales-detail-items">
              <h3>Products ({viewingOrder.checkout.items.length})</h3>
              <div className="sales-detail-table-scroll"><table>
                <thead><tr><th>Product</th><th>Quantity</th><th>Unit price</th><th>Discount</th><th>Line total</th></tr></thead>
                <tbody>{viewingOrder.checkout.items.map((item) => {
                  const productRecord = productCatalog.find((entry) => entry.product_id === item.product_id);
                  return <tr key={item.sale_item_id}>
                    <td>{productRecord?.name ?? `Product #${item.product_id}`}<small>{productRecord?.category ?? "Uncategorized"}</small></td>
                    <td>{numericValue(item.quantity)} {productRecord?.unit ?? ""}</td>
                    <td>₹ {numericValue(item.unit_price).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</td>
                    <td>₹ {numericValue(item.discount_amount).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</td>
                    <td>₹ {numericValue(item.line_total).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</td>
                  </tr>;
                })}</tbody>
              </table></div>
            </div>
            <div className="sales-detail-totals">
              <div><span>Subtotal</span><strong>₹ {numericValue(viewingOrder.checkout.subtotal).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</strong></div>
              <div><span>Discount</span><strong>- ₹ {numericValue(viewingOrder.checkout.discount_amount).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</strong></div>
              <div className="sales-detail-grand-total"><span>Total paid</span><strong>₹ {numericValue(viewingOrder.checkout.total_amount).toLocaleString("en-IN", { maximumFractionDigits: 2 })}</strong></div>
            </div>
          </> : <p className="sales-detail-legacy-note">Itemized checkout details are not available for this legacy sale.</p>}
        </section>
      </div>}
    </div>
  );
}

function SalesKpi({ icon, color, label, value, change, note }: { icon: React.ReactNode; color: string; label: string; value: string; change: string; note: string }) {
  return <article className="sales-kpi"><span className={`sales-kpi-icon ${color}`}>{icon}</span><div className="sales-kpi-copy"><span>{label}</span><div><strong>{value}</strong><i>{change}</i></div><small>{note}</small></div></article>;
}

function SalesFilter({ value, onChange, options, label }: { value: string; onChange: (value: string) => void; options: string[]; label: string }) {
  return <label className="sales-filter"><select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option}>{option}</option>)}</select><ChevronDown size={13} /></label>;
}