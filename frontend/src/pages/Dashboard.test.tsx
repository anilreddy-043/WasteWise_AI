import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import Dashboard from "./Dashboard";
import { loadDashboardData, loadDashboardHighlights } from "../services/dashboard";
import type { DashboardPayload } from "../services/dashboard";

vi.mock("../services/dashboard", () => ({
  loadDashboardData: vi.fn(),
  loadDashboardHighlights: vi.fn(),
  markRecommendationApplied: vi.fn(),
}));

const payload: DashboardPayload = {
  summary: {
    start_date: "2026-01-01",
    end_date: "2026-11-04",
    product_count: 40,
    active_product_count: 30,
    imported_product_count: 10,
    user_product_count: 30,
    imported_catalog: {
      status: "available",
      message: "CSV catalog is separate from application products.",
      source: "products.csv",
    },
    available_inventory: [
      { unit: "kg", quantity: 24 },
      { unit: "L", quantity: 12 },
      { unit: "piece", quantity: 6 },
    ],
    active_batch_count: 3,
    sales_revenue: 125,
    sales_record_count: 2,
    currency: "INR",
    waste_quantity_by_unit: [{ unit: "kg", quantity: 0 }],
    waste_cost: 0,
    waste_record_count: 0,
    expired_batch_count: 2,
    expiring_soon_batch_count: 2,
    expiry_window_days: 7,
    application_expired_batch_count: 1,
    application_expiring_soon_batch_count: 1,
    snapshot_expired_batch_count: 1,
    snapshot_expiring_soon_batch_count: 1,
  },
  salesDemand: {
    start_date: "2026-01-01",
    end_date: "2026-11-04",
    prediction_start_date: null,
    prediction_end_date: null,
    imported_history_status: {
      status: "available",
      message: "Imported sales are separate.",
      source: "perishable_inventory.csv",
    },
    units: [],
    actual_sales: [],
    imported_history: [],
    predicted_demand: [],
    prediction: { status: "unavailable", source: "demand_forecasts", message: "No saved forecasts." },
  },
  categoryDistribution: {
    measure: "share_of_distinct_catalog_products",
    total_products: 40,
    categories: [{
      category: "Fruits",
      product_count: 40,
      live_stocked_product_count: 3,
      product_share_percent: 100,
      available_quantity_by_unit: [
        { unit: "kg", quantity: 24 },
        { unit: "L", quantity: 12 },
      ],
    }],
  },
  wasteTrend: {
    start_date: "2026-05-04",
    end_date: "2026-11-04",
    granularity: "month",
    actual_record_count: 0,
    actual: [],
    expired_inventory: [{ period: "2026-10-01", unit: "kg", quantity: 3, cost: 12 }],
    imported_history: [{ period: "2026-10-01", unit: "kg", quantity: 7, cost: null }],
    imported_history_status: {
      status: "available",
      message: "Imported training waste is separate from recorded waste.",
      source: "perishable_inventory.csv",
    },
    units: ["kg"],
  },
  expiryAlerts: [
    {
      source: "application",
      batch_id: 1,
      product_id: 1,
      product_name: "Orange Juice",
      category: "Beverages",
      unit: "L",
      batch_code: "LIVE-1",
      expiry_date: "2026-11-02",
      snapshot_date: null,
      days_to_expiry: -2,
      quantity_remaining: 3,
      status: "expired",
      risk: "high",
    },
    {
      source: "inventory_snapshot",
      batch_id: 2,
      product_id: 2,
      product_name: "Orange Juice",
      category: "Beverages",
      unit: "unit",
      batch_code: "CSV-2",
      expiry_date: "2026-11-08",
      snapshot_date: "2026-11-01",
      days_to_expiry: 7,
      quantity_remaining: 5,
      status: "expiring_soon",
      risk: "medium",
    },
  ],
  recommendations: [],
  topProducts: [],
  lowStock: [],
  recentActivities: [],
};

describe("Dashboard data provenance and summaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadDashboardData).mockResolvedValue(payload);
    vi.mocked(loadDashboardHighlights).mockReturnValue({
      expiryAlerts: Promise.resolve({ status: "fulfilled", value: payload.expiryAlerts }),
      recommendations: Promise.resolve({ status: "fulfilled", value: payload.recommendations }),
    });
  });

  it("keeps live and snapshot expiry counts explicit and shows overdue rows", async () => {
    render(<Dashboard userName="Test" onNotify={vi.fn()} />);

    await screen.findByText("Total Products");
    const overview = document.querySelector(".dashboard-kpis");
    expect(overview).not.toBeNull();
    const expiryCard = within(overview as HTMLElement).getAllByText("Expiry Alerts")[0].closest("article");
    expect(expiryCard).not.toBeNull();
    expect(expiryCard).toHaveTextContent("4");
    expect(expiryCard).toHaveTextContent(
      /1 live overdue.*1 live within 7d.*1 snapshot overdue.*1 snapshot within 7d/,
    );
    expect(screen.getByText("2d overdue")).toBeInTheDocument();
    expect(screen.getByText("Snapshot · 01 Nov 2026")).toBeInTheDocument();
  });

  it("renders dashboard summaries while slow alert and recommendation data is pending", async () => {
    let resolveAlerts!: (value: PromiseSettledResult<DashboardPayload["expiryAlerts"]>) => void;
    let resolveRecommendations!: (value: PromiseSettledResult<DashboardPayload["recommendations"]>) => void;
    vi.mocked(loadDashboardData).mockResolvedValue({ ...payload, expiryAlerts: [], recommendations: [] });
    vi.mocked(loadDashboardHighlights).mockReturnValue({
      expiryAlerts: new Promise((resolve) => { resolveAlerts = resolve; }),
      recommendations: new Promise((resolve) => { resolveRecommendations = resolve; }),
    });

    render(<Dashboard userName="Test" onNotify={vi.fn()} />);

    await screen.findByText("Total Products");
    expect(screen.getByText("Loading expiry alerts…")).toBeInTheDocument();
    expect(screen.getByText("Loading recommendations…")).toBeInTheDocument();

    resolveAlerts({ status: "fulfilled", value: payload.expiryAlerts });
    resolveRecommendations({ status: "fulfilled", value: payload.recommendations });
    expect(await screen.findByText("2d overdue")).toBeInTheDocument();
  });

  it("distinguishes CSV catalog products and wraps each native inventory unit", async () => {
    render(<Dashboard userName="Test" onNotify={vi.fn()} />);

    const productCard = (await screen.findByText("Total Products")).closest("article");
    const inventoryCard = screen.getByText("Available Inventory").closest("article");
    expect(productCard).toHaveTextContent("40");
    expect(productCard).toHaveTextContent("10 CSV catalog · 30 application");
    expect(inventoryCard).toHaveTextContent("Mixed");
    expect(inventoryCard).toHaveTextContent(/24 kg.*12 L.*6 piece/);
    expect(inventoryCard?.querySelector(".dashboard-kpi-note-wrap")).not.toBeNull();
  });

  it("labels imported waste training as non-operational and keeps it off the recorded-waste KPI", async () => {
    render(<Dashboard userName="Test" onNotify={vi.fn()} />);

    expect(await screen.findByText("Expired inventory")).toBeInTheDocument();
    expect(await screen.findByText("Training history · not actual waste")).toBeInTheDocument();
    expect(screen.getByText(/Expired inventory is counted on its expiry date.*Imported training waste is shown separately/)).toBeInTheDocument();
    const wasteCard = screen.getByText("Waste Recorded").closest("article");
    expect(wasteCard?.querySelector(".dashboard-kpi-value-row > b")).toHaveTextContent("0");
    expect(wasteCard).toHaveTextContent(/0kg/);
  });

  it("shows recorded waste values for each period and the selected-period record count", async () => {
    vi.mocked(loadDashboardData).mockResolvedValue({
      ...payload,
      summary: { ...payload.summary, waste_record_count: 20 },
      wasteTrend: {
        ...payload.wasteTrend,
        actual_record_count: 3,
        actual: [{ period: "2026-10-01", unit: "kg", quantity: 2.5, cost: 8 }],
      },
    });

    render(<Dashboard userName="Test" onNotify={vi.fn()} />);

    const wasteRecordsLabel = await screen.findByText("Waste records");
    expect(wasteRecordsLabel.parentElement).toHaveTextContent(/^3/);
    expect(screen.getByText("3 records")).toBeInTheDocument();
    expect(screen.getByLabelText("2026-10-01: 2.5 kg recorded waste")).toBeInTheDocument();
  });
});
