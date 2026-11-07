import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WasteReports from "./WasteReports";
import DemandForecast from "./DemandForecast";
import ExpiryAlerts from "./ExpiryAlerts";
import * as business from "../services/business";
import * as expiryApi from "../services/expiryAlerts";
import * as dashboardApi from "../services/dashboard";

vi.mock("../services/business", () => ({
  createWaste: vi.fn(),
  getModelRegistry: vi.fn(),
  generateForecasts: vi.fn(),
  listBatches: vi.fn(),
  listForecasts: vi.fn(),
  listInventorySummary: vi.fn(),
  listModelMetrics: vi.fn(),
  listProducts: vi.fn(),
  listSales: vi.fn(),
  listWaste: vi.fn(),
}));

vi.mock("../services/expiryAlerts", () => ({
  createExpiryAlertRule: vi.fn(),
  deleteExpiryAlertRule: vi.fn(),
  exportExpiryAlerts: vi.fn(),
  getExpiryAlertBatch: vi.fn(),
  getExpiryAlertCharts: vi.fn(),
  getExpiryAlertFilters: vi.fn(),
  listExpiryAlerts: vi.fn(),
  listExpiryAlertRules: vi.fn(),
  updateExpiryAlertRule: vi.fn(),
}));

vi.mock("../services/dashboard", () => ({
  loadWasteTrend: vi.fn(),
}));

const product = {
  product_id: 7, name: "Lettuce", category: "Vegetables", sku: "LET-7", unit: "kg",
  price: 42, supplier: "Local farm", created_at: "", updated_at: "",
};

function dateOffset(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dateMonthOffset(months: number): string {
  const date = new Date();
  date.setMonth(date.getMonth() + months);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(business.listProducts).mockResolvedValue([product]);
  vi.mocked(business.listBatches).mockResolvedValue([]);
  vi.mocked(business.listInventorySummary).mockResolvedValue([{
    product_id: 7, product_name: "Lettuce", category: "Vegetables", sku: "LET-7",
    unit: "kg", price: 42, supplier: "Local farm", quantity: 14, inventory_value: 588,
    active_batch_count: 2, source: "actual",
  }]);
  vi.mocked(business.listSales).mockResolvedValue([{
    sale_id: 2, product_id: 7, batch_id: null, sold_at: `${dateOffset(-1)}T10:00:00`,
    quantity: "3.000", unit_price: "42.00", total_amount: "126.00", source: "pos",
  }]);
  vi.mocked(business.listWaste).mockResolvedValue([{
    waste_id: 2, product_id: 7, batch_id: null, quantity: "1.5", reason: "spoilage",
    waste_cost: "63.00", recorded_at: `${dateOffset(-2)}T10:00:00`, notes: null,
  }]);
  vi.mocked(dashboardApi.loadWasteTrend).mockResolvedValue({
    start_date: dateOffset(-180), end_date: dateOffset(0), granularity: "month",
    actual_record_count: 1,
    actual: [], expired_inventory: [], imported_history: [{ period: dateMonthOffset(-1), unit: "unit", quantity: 12, cost: null }],
    imported_history_status: {
      status: "available", message: "Imported training history is separate from application records.",
      source: "fixture",
    },
    units: ["unit"],
  });
  vi.mocked(business.listForecasts).mockResolvedValue([{
    forecast_id: 5, product_id: 7, forecast_date: dateOffset(1), predicted_demand: 3,
    lower_bound: 2, upper_bound: 4, model_version: "test-v1", created_at: "2026-10-25T10:00:00",
  }]);
  vi.mocked(business.generateForecasts).mockResolvedValue([]);
  vi.mocked(business.listModelMetrics).mockResolvedValue([]);
  vi.mocked(business.getModelRegistry).mockResolvedValue({ active_models: {} });
  vi.mocked(expiryApi.listExpiryAlerts).mockResolvedValue({
    items: [{
      batch_id: 11, product_id: 7, product_name: "Lettuce", sku: "LET-7",
      category: "Vegetables", unit: "kg", batch_code: "LOT-11", expiry_date: "2026-10-27",
      received_at: "2026-10-01", days_to_expiry: 2, quantity_remaining: 3,
      status: "active", risk: "high", suggested_action: "Review batch immediately; consider markdown",
      location: "Cold Room", supplier: "Local farm",
    }],
    total: 1, page: 1, page_size: 10, total_pages: 1,
    summary: {
      total_batches: 1, expired: 0, high: 1, medium: 0, low: 0, safe: 0,
      risk_counts: { expired: 0, high: 1, medium: 0, low: 0, safe: 0 },
    },
  });
  vi.mocked(expiryApi.getExpiryAlertCharts).mockResolvedValue({
    risk_distribution: [{ risk: "high", count: 1 }, { risk: "expired", count: 0 }, { risk: "medium", count: 0 }, { risk: "low", count: 0 }, { risk: "safe", count: 0 }],
    expiring_next_14_days: [{ range: "0-3", count: 1 }, { range: "4-7", count: 0 }, { range: "8-14", count: 0 }],
    top_categories: [{ category: "Vegetables", count: 1 }],
  });
  vi.mocked(expiryApi.getExpiryAlertFilters).mockResolvedValue({
    categories: ["Vegetables"], locations: ["Cold Room"], suppliers: ["Local farm"],
  });
  vi.mocked(expiryApi.listExpiryAlertRules).mockResolvedValue([]);
  vi.mocked(expiryApi.createExpiryAlertRule).mockResolvedValue({
    rule_id: 25, name: "Dairy warning", days_before_expiry: 3, risk_level: "high",
    category: "Dairy", location: null, supplier: null, enabled: true, created_by: 1,
    created_at: "2026-10-01T10:00:00", updated_at: "2026-10-01T10:00:00",
  });
});

describe("API-backed operational pages", () => {
  it("shows saved waste records and database-derived totals", async () => {
    render(<WasteReports onNotify={vi.fn()} canManage />);

    expect(await screen.findByRole("row", { name: /Lettuce/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Lettuce/ })).toHaveTextContent("Spoilage");
    expect(screen.getAllByText("₹63.00")).toHaveLength(2);
    expect(screen.getByText("Waste Trend")).toBeInTheDocument();
    expect(screen.getByText("Recorded Waste by Category")).toBeInTheDocument();
    expect(dashboardApi.loadWasteTrend).toHaveBeenCalledOnce();
  });

  it("clearly separates imported training waste from an empty operational record set", async () => {
    vi.mocked(business.listWaste).mockResolvedValue([]);
    render(<WasteReports onNotify={vi.fn()} />);

    expect(await screen.findByRole("status")).toHaveTextContent("No operational waste has been recorded");
    expect(screen.getByText("Imported Training History").closest(".waste-report-stat")).toHaveTextContent("12 unit");
    expect(screen.getByText("No operational waste records in this period. Training history is shown separately above.")).toBeInTheDocument();
    expect(screen.getByText("Waste Records").closest(".waste-report-stat")).toHaveTextContent("0");
  });

  it("filters waste records by search and reason", async () => {
    const recordedWaste = {
      waste_id: 2, product_id: 7, batch_id: null, quantity: "1.5", reason: "spoilage",
      waste_cost: "63.00", recorded_at: `${dateOffset(-2)}T10:00:00`, notes: null,
    };
    vi.mocked(business.listWaste).mockResolvedValue([
      recordedWaste,
      { ...recordedWaste, waste_id: 3, reason: "expired", quantity: "0.5" },
    ]);
    render(<WasteReports onNotify={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByRole("row", { name: /Lettuce/ })).toHaveLength(2));

    fireEvent.change(screen.getByLabelText("Search waste records"), { target: { value: "not found" } });
    expect(await screen.findByText("No records match the selected filters.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search waste records"), { target: { value: "" } });
    await waitFor(() => expect(screen.getAllByRole("row", { name: /Lettuce/ })).toHaveLength(2));
    fireEvent.change(screen.getByLabelText("Filter waste by reason"), { target: { value: "spoilage" } });
    await waitFor(() => expect(screen.getAllByRole("row", { name: /Lettuce/ })).toHaveLength(1));
  });

  it("submits a waste entry only after the user explicitly records it", async () => {
    render(<WasteReports onNotify={vi.fn()} canManage />);
    fireEvent.click(await screen.findByRole("button", { name: /Record Waste/ }));
    fireEvent.change(screen.getByLabelText("Product"), { target: { value: "7" } });
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "0.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Waste Record" }));

    await waitFor(() => expect(business.createWaste).toHaveBeenCalledWith({
      product_id: 7, batch_id: null, quantity: 0.5, reason: "spoilage", waste_cost: 0, notes: null,
    }));
  });

  it("renders a live-data forecast dashboard without generating or persisting records on page load", async () => {
    render(<DemandForecast onNotify={vi.fn()} canGenerate />);

    expect(await screen.findByRole("row", { name: /Lettuce/ })).toBeInTheDocument();
    expect(screen.getByText("Demand Forecast Trend")).toBeInTheDocument();
    expect(screen.getByText("Forecasted Demand by Category")).toBeInTheDocument();
    expect(screen.getByText("Forecast Distribution")).toBeInTheDocument();
    expect(screen.getByText("Total Forecasted Demand").closest(".forecast-stat-card")).toHaveTextContent("3");
    expect(business.listInventorySummary).toHaveBeenCalledOnce();
    expect(business.listSales).toHaveBeenCalledOnce();
    expect(business.listForecasts).toHaveBeenCalledOnce();
    expect(business.generateForecasts).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Generate Forecast" }));
    await waitFor(() => expect(business.generateForecasts).toHaveBeenCalledOnce());
    expect(business.listForecasts).toHaveBeenCalledTimes(2);
  });

  it("shows product forecast details and applies forecast table filters", async () => {
    render(<DemandForecast onNotify={vi.fn()} />);
    await screen.findByRole("row", { name: /Lettuce/ });

    fireEvent.change(screen.getByLabelText("Filter forecasts by product"), { target: { value: "7" } });
    await waitFor(() => expect(business.listForecasts).toHaveBeenLastCalledWith(7));
    fireEvent.click(screen.getByRole("button", { name: "View Lettuce forecast details" }));
    const dialog = await screen.findByRole("dialog", { name: "Lettuce" });
    expect(dialog).toHaveTextContent("test-v1");
    expect(dialog).toHaveTextContent("14 kg");
    fireEvent.click(screen.getByRole("button", { name: "Close forecast details" }));

    fireEvent.change(screen.getByLabelText("Search forecast products"), { target: { value: "not present" } });
    expect(screen.getByText("No products match these filters.")).toBeInTheDocument();
  });

  it("shows paginated live batch alerts and the risk charts", async () => {
    render(<ExpiryAlerts onNotify={vi.fn()} canManageRules />);

    expect(await screen.findByText("LOT-11")).toBeInTheDocument();
    expect(screen.getByText("Review batch immediately; consider markdown")).toBeInTheDocument();
    expect(screen.getByText("Expiry Risk Distribution")).toBeInTheDocument();
    expect(screen.getByText("Items Expiring in Next 14 Days")).toBeInTheDocument();
    expect(expiryApi.listExpiryAlerts).toHaveBeenCalledWith(expect.objectContaining({ page: 1, page_size: 10 }));
    expect(screen.queryByText("BCH1023")).not.toBeInTheDocument();
  });

  it("filters server-side and opens batch detail without applying suggested actions", async () => {
    vi.mocked(expiryApi.getExpiryAlertBatch).mockResolvedValue({
      batch_id: 11, product_id: 7, product_name: "Lettuce", sku: "LET-7",
      category: "Vegetables", unit: "kg", batch_code: "LOT-11", expiry_date: "2026-10-27",
      received_at: "2026-10-01", days_to_expiry: 2, quantity_remaining: 3,
      status: "active", risk: "high", suggested_action: "Review batch immediately; consider markdown",
      location: "Cold Room", supplier: "Local farm",
    });
    render(<ExpiryAlerts onNotify={vi.fn()} canManageRules={false} />);

    await screen.findByText("LOT-11");
    fireEvent.change(screen.getByLabelText("Filter expiry alerts by location"), { target: { value: "Cold Room" } });
    await waitFor(() => expect(expiryApi.listExpiryAlerts).toHaveBeenLastCalledWith(
      expect.objectContaining({ location: "Cold Room", page: 1 }),
    ));
    fireEvent.click(screen.getByRole("button", { name: "View LOT-11 details" }));
    expect(await screen.findByRole("dialog", { name: "Batch Details" })).toHaveTextContent("does not modify inventory");
    expect(expiryApi.createExpiryAlertRule).not.toHaveBeenCalled();
  });

  it("allows managers to create alert rules", async () => {
    render(<ExpiryAlerts onNotify={vi.fn()} canManageRules />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Alert Rule/ }));
    fireEvent.change(screen.getByLabelText("Rule name"), { target: { value: "Dairy warning" } });
    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "Vegetables" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Rule" }));

    await waitFor(() => expect(expiryApi.createExpiryAlertRule).toHaveBeenCalledWith(expect.objectContaining({
      name: "Dairy warning", days_before_expiry: 3, category: "Vegetables",
    })));
  });

  it("shows API/database errors instead of presenting failed loads as zero batches", async () => {
    vi.mocked(expiryApi.listExpiryAlerts).mockRejectedValue(new Error("Database unavailable"));
    render(<ExpiryAlerts onNotify={vi.fn()} canManageRules={false} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Database unavailable");
    expect(screen.getByText("Expiry data unavailable")).toBeInTheDocument();
    expect(screen.getByText("Inventory data unavailable")).toBeInTheDocument();
    expect(screen.getByText("Expiry data could not be loaded.")).toBeInTheDocument();
    expect(screen.queryByText("Showing 0 batches")).not.toBeInTheDocument();
  });
});
