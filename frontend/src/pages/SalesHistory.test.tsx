import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SalesHistory from "./SalesHistory";
import * as business from "../services/business";

vi.mock("../services/business", () => ({
  listProducts: vi.fn(),
  listSales: vi.fn(),
  listSalesTransactions: vi.fn(),
}));

const products = [
  { product_id: 1, name: "Rice", category: "Grains", sku: "RICE", unit: "kg", price: 120, supplier: "Farm", created_at: "", updated_at: "" },
  { product_id: 2, name: "Milk", category: "Dairy", sku: "MILK", unit: "L", price: 520, supplier: "Farm", created_at: "", updated_at: "" },
  { product_id: 3, name: "Apple", category: "Fruits", sku: "APPLE", unit: "kg", price: 100, supplier: "Farm", created_at: "", updated_at: "" },
];

const localTimestamp = (daysAgo = 0) => {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(date.getHours() - 1, 0, 0, 0);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
};

const sale = {
  sale_id: 8,
  product_id: 3,
  batch_id: null,
  sold_at: localTimestamp(),
  quantity: 1,
  unit_price: 100,
  total_amount: 100,
  source: "manual",
};

const checkout = (id: number, number: string, total: number, item: { product_id: number; line_total: number; discount_amount?: number }, soldAt = localTimestamp()) => ({
  sale_transaction_id: id,
  transaction_number: number,
  subtotal: total + (item.discount_amount ?? 0),
  discount_type: item.discount_amount ? "amount" as const : "none" as const,
  discount_value: item.discount_amount ?? 0,
  discount_amount: item.discount_amount ?? 0,
  total_amount: total,
  payment_method: "cash" as const,
  customer_name: null as string | null,
  customer_phone: null as string | null,
  sold_at: soldAt,
  processed_by: 1,
  status: "completed",
  idempotency_key: `key-${id}`,
  created_at: "",
  updated_at: "",
  items: [{
    sale_item_id: id,
    product_id: item.product_id,
    quantity: 1,
    unit_price: item.line_total + (item.discount_amount ?? 0),
    line_subtotal: item.line_total + (item.discount_amount ?? 0),
    discount_amount: item.discount_amount ?? 0,
    line_total: item.line_total,
    allocations: [],
  }],
});

function renderHistory() {
  return render(<SalesHistory onNotify={vi.fn()} />);
}

function summaryValue(summary: HTMLElement, label: string): string | null {
  return within(summary).getByText(label).closest(".sales-kpi")?.querySelector("strong")?.textContent ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(business.listProducts).mockResolvedValue(products);
  vi.mocked(business.listSales).mockResolvedValue([
    { ...sale, sale_id: 1, source: "pos", total_amount: 120 },
    sale,
  ]);
  vi.mocked(business.listSalesTransactions).mockResolvedValue([
    checkout(1, "WW-ORDER-1", 120, { product_id: 1, line_total: 120 }),
    checkout(2, "WW-ORDER-2", 92.4, { product_id: 1, line_total: 92.4, discount_amount: 27.6 }),
    checkout(3, "WW-ORDER-3", 2080, { product_id: 2, line_total: 2080 }),
    checkout(4, "WW-OLD-ORDER", 999, { product_id: 1, line_total: 999 }, localTimestamp(40)),
  ]);
});

describe("SalesHistory", () => {
  it("uses completed order totals for KPIs and data-driven category charts", async () => {
    renderHistory();

    await screen.findByText("WW-ORDER-1");
    const summary = screen.getByRole("region", { name: "Sales summary" });
    expect(summaryValue(summary, "Total Sales")).toBe("₹ 2,392.4");
    expect(summaryValue(summary, "Average Order Value")).toBe("₹ 598.1");
    expect(summaryValue(summary, "Transactions")).toBe("4");
    expect(screen.getAllByText("2,080").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Grains").length).toBeGreaterThan(0);
    expect(screen.getByTestId("sales-distribution-chart").getAttribute("style")).toContain("conic-gradient");
    const categoryShares = Array.from(document.querySelectorAll(".sales-legend-row b"))
      .map((share) => Number.parseInt(share.textContent ?? "0", 10));
    expect(categoryShares.reduce((sum, share) => sum + share, 0)).toBe(100);

    const chart = screen.getByTestId("daily-sales-chart");
    expect(chart.querySelectorAll("circle")).toHaveLength(30);
    expect(chart.getAttribute("aria-label")).toContain("peak ₹2,392.4");
    expect(screen.getByText(/of 4 orders/)).toBeInTheDocument();
  });

  it("adjusts the daily chart to the selected seven-day range", async () => {
    renderHistory();
    await screen.findByText("WW-ORDER-1");

    fireEvent.change(screen.getByLabelText("Sales trend period"), { target: { value: "Last 7 Days" } });

    await waitFor(() => {
      expect(screen.getByTestId("daily-sales-chart").querySelectorAll("circle")).toHaveLength(7);
    });
    expect(screen.getByRole("region", { name: "Sales summary" })).toHaveTextContent("₹ 2,392.4");
  });

  it("filters sales history orders with category chips", async () => {
    renderHistory();
    await screen.findByText("WW-ORDER-1");

    fireEvent.click(screen.getByRole("button", { name: "Dairy" }));

    expect(screen.getByText("WW-ORDER-3")).toBeInTheDocument();
    expect(screen.queryByText("WW-ORDER-1")).not.toBeInTheDocument();
    expect(screen.getByText(/of 1 orders/)).toBeInTheDocument();
  });

  it("renders a zero state when there are no sales", async () => {
    vi.mocked(business.listSales).mockResolvedValue([]);
    vi.mocked(business.listSalesTransactions).mockResolvedValue([]);
    renderHistory();

    await screen.findByText("No sales data");
    const summary = screen.getByRole("region", { name: "Sales summary" });
    expect(summaryValue(summary, "Total Sales")).toBe("₹ 0");
    expect(summaryValue(summary, "Average Order Value")).toBe("₹ 0");
    expect(summaryValue(summary, "Transactions")).toBe("0");
    expect(screen.getByTestId("sales-distribution-chart").getAttribute("style")).not.toContain("conic-gradient");
    expect(screen.getByText("No transactions found. Try adjusting your search or filters.")).toBeInTheDocument();
  });

  it("normalizes MySQL decimal strings before calculating sales metrics and charts", async () => {
    const decimalCheckout = {
      ...checkout(21, "WW-DECIMAL-21", 1234.5, { product_id: 1, line_total: 1234.5 }),
      subtotal: "1234.50",
      total_amount: "1234.50",
      items: [{
        sale_item_id: 21,
        product_id: 1,
        quantity: "2.500",
        unit_price: "493.80",
        line_subtotal: "1234.50",
        discount_amount: "0.00",
        line_total: "1234.50",
        allocations: [],
      }],
    };
    vi.mocked(business.listSales).mockResolvedValue([]);
    vi.mocked(business.listSalesTransactions).mockResolvedValue([decimalCheckout]);
    renderHistory();

    await screen.findByText("WW-DECIMAL-21");

    const summary = screen.getByRole("region", { name: "Sales summary" });
    expect(summaryValue(summary, "Total Sales")).toBe("₹ 1,234.5");
    expect(summaryValue(summary, "Items Sold")).toBe("2.5");
    expect(summaryValue(summary, "Average Order Value")).toBe("₹ 1,234.5");
    expect(screen.getByTestId("daily-sales-chart").getAttribute("aria-label")).toContain("peak ₹1,234.5");
    expect(document.body).not.toHaveTextContent("NaN");
    expect(screen.getByRole("combobox", { name: "Filter by payment method" })).toHaveTextContent("CASH");
  });

  it("shows each checkout as one row and opens all items with the saved customer details", async () => {
    vi.mocked(business.listSales).mockResolvedValue([]);
    const multiItemCheckout = checkout(31, "WW-MULTI-31", 640, { product_id: 1, line_total: 120 });
    multiItemCheckout.customer_name = "Asha Patel";
    multiItemCheckout.customer_phone = "9876543210";
    multiItemCheckout.items.push({
      sale_item_id: 32,
      product_id: 2,
      quantity: 1,
      unit_price: 520,
      line_subtotal: 520,
      discount_amount: 0,
      line_total: 520,
      allocations: [],
    });
    vi.mocked(business.listSalesTransactions).mockResolvedValue([multiItemCheckout]);
    renderHistory();

    await screen.findByText("WW-MULTI-31");
    const rows = document.querySelectorAll(".sales-table tbody tr");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Asha Patel");
    expect(rows[0]).toHaveTextContent("9876543210");
    expect(rows[0]).toHaveTextContent("Rice, Milk");

    fireEvent.click(screen.getByRole("button", { name: "View transaction WW-MULTI-31" }));

    const details = screen.getByRole("dialog", { name: "Purchase Details" });
    expect(within(details).getByText("Asha Patel")).toBeInTheDocument();
    expect(within(details).getByText("9876543210")).toBeInTheDocument();
    expect(within(details).getByText("Rice")).toBeInTheDocument();
    expect(within(details).getByText("Milk")).toBeInTheDocument();
    expect(within(details).getByText("Total paid")).toBeInTheDocument();
  });
});
