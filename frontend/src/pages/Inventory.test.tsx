import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Inventory from "./Inventory";
import * as business from "../services/business";
import ExpandedContentOverlay from "../components/ExpandedContentOverlay";

vi.mock("../services/business", () => ({
  deleteProduct: vi.fn(),
  listBatches: vi.fn(),
  listInventorySummary: vi.fn(),
  updateBatch: vi.fn(),
}));

const summary: business.InventorySummaryRecord[] = [{
  product_id: 1,
  product_name: "Apples",
  category: "Fruits",
  sku: "APP-1",
  unit: "kg",
  price: 2,
  supplier: "Farm",
  quantity: 5,
  inventory_value: 10,
  active_batch_count: 1,
  source: "actual",
}];

const initialBatch: business.InventoryBatchRecord = {
  batch_id: 8,
  product_id: 1,
  batch_code: "LOT-8",
  quantity_received: 5,
  quantity_remaining: 5,
  unit_cost: 1,
  received_at: "2026-10-01",
  expiry_date: "2026-12-01",
  status: "active",
  location: "Cold Room",
  supplier: "Farm",
};

function dateOffset(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function batchRecord(index: number, expiryDate: string): business.InventoryBatchRecord {
  return {
    ...initialBatch,
    batch_id: index,
    batch_code: `LOT-${String(index).padStart(2, "0")}`,
    received_at: "2026-10-01",
    expiry_date: expiryDate,
    expiry_date_source: "manufacturer_verified",
  };
}

describe("Inventory batch expiry editor", () => {
  beforeEach(() => {
    vi.mocked(business.listInventorySummary).mockResolvedValue(summary);
    vi.mocked(business.listBatches).mockResolvedValue([initialBatch]);
  });

  it("expands the category value chart and scales each bar to its actual value", async () => {
    vi.mocked(business.listInventorySummary).mockResolvedValue([
      { ...summary[0], inventory_value: 2000 },
      { ...summary[0], product_id: 2, product_name: "Milk", category: "Dairy", inventory_value: 1000 },
      { ...summary[0], product_id: 3, product_name: "Bread", category: "Bakery", inventory_value: 0 },
    ]);

    render(
      <main>
        <Inventory onNotify={vi.fn()} canEditBatchDates />
        <ExpandedContentOverlay />
      </main>,
    );

    const heading = await screen.findByRole("heading", { name: "Inventory Value by Category" });
    const chart = heading.closest("article") as HTMLElement;
    const columns = chart.querySelectorAll(".category-bar-column");
    expect(columns[0].querySelector("span")).toHaveStyle({ height: "100%" });
    expect(columns[1].querySelector("span")).toHaveStyle({ height: "50%" });
    expect(columns[2].querySelector("span")).toHaveStyle({ height: "0%" });
    expect(columns[0]).toHaveAttribute("aria-label", "Fruits: ₹ 2,000");

    fireEvent.doubleClick(chart.querySelector(".category-plot") as HTMLElement);

    expect(await screen.findByRole("dialog", { name: "Inventory Value by Category" })).toBe(chart);
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("persists received and expiry dates and reflects the changed expiry status", async () => {
    const updatedBatch = { ...initialBatch, received_at: "2019-12-31", expiry_date: "2020-01-01", status: "expired" };
    vi.mocked(business.updateBatch).mockResolvedValue(updatedBatch);
    vi.mocked(business.listBatches)
      .mockResolvedValueOnce([initialBatch])
      .mockResolvedValueOnce([updatedBatch]);

    render(<Inventory onNotify={vi.fn()} canEditBatchDates />);
    const batchRow = await screen.findByRole("row", { name: /LOT-8/ });
    expect(within(batchRow).getByText("Apples")).toBeInTheDocument();
    expect(batchRow.querySelector(".inventory-batch-product .product-symbol")).toHaveTextContent("🍎");
    expect(within(batchRow).getByText("Fruits")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Edit dates for LOT-8" }));
    fireEvent.change(screen.getByLabelText("Received date"), { target: { value: "2019-12-31" } });
    fireEvent.change(screen.getByLabelText("Expiry date"), { target: { value: "2020-01-01" } });
    fireEvent.click(screen.getByRole("button", { name: /save dates/i }));

    await waitFor(() => expect(business.updateBatch).toHaveBeenCalledWith(8, {
      received_at: "2019-12-31",
      expiry_date: "2020-01-01",
      expiry_date_source: "manual_verified",
    }));
    expect(await screen.findByRole("row", { name: /Expired/ })).toBeInTheDocument();
    expect(screen.getByText("01 Jan 2020")).toBeInTheDocument();
  });

  it("renders stored batch expiry provenance and shows batch details", async () => {
    vi.mocked(business.listBatches).mockResolvedValue([{
      ...initialBatch,
      expiry_date_source: "manufacturer_verified",
    }]);

    render(<Inventory onNotify={vi.fn()} canEditBatchDates />);
    const row = await screen.findByRole("row", { name: /LOT-8/ });
    expect(within(row).getByText("01 Dec 2026")).toBeInTheDocument();
    expect(within(row).getByText("Manufacturer verified")).toBeInTheDocument();
    expect(within(row).getByText("5")).toBeInTheDocument();

    fireEvent.click(within(row).getByRole("button", { name: "View details for LOT-8" }));
    expect(await screen.findByRole("dialog", { name: "Batch Details" })).toHaveTextContent("Cold Room");
    expect(screen.getByRole("dialog")).toHaveTextContent("Manufacturer verified");
  });

  it("filters, sorts, and paginates batch rows", async () => {
    const batchRows = Array.from({ length: 12 }, (_, index) => {
      const expiry = new Date(Date.UTC(2031, 0, index + 1)).toISOString().slice(0, 10);
      return batchRecord(12 - index, expiry);
    });
    vi.mocked(business.listBatches).mockResolvedValue(batchRows);
    render(<Inventory onNotify={vi.fn()} canEditBatchDates />);

    const firstRow = await screen.findByRole("row", { name: /LOT-12/ });
    expect(firstRow).toBeInTheDocument();
    expect(screen.getByText("Showing 1 to 10 of 12 batches")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next batch page" }));
    expect(screen.getByText("Showing 11 to 12 of 12 batches")).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /LOT-02/ })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search batches"), { target: { value: "LOT-12" } });
    expect(screen.getByText("Showing 1 to 1 of 1 batches")).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /LOT-12/ })).toBeInTheDocument();
  });

  it("filters batches by expiry status and sorts in the selected direction", async () => {
    vi.mocked(business.listBatches).mockResolvedValue([
      batchRecord(1, dateOffset(3)),
      batchRecord(2, "2020-01-01"),
      batchRecord(3, "2031-02-01"),
    ]);
    render(<Inventory onNotify={vi.fn()} canEditBatchDates />);

    fireEvent.change(screen.getByLabelText("Filter batch status"), { target: { value: "Expiring Soon" } });
    expect(await screen.findByRole("row", { name: /LOT-01/ })).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /LOT-02/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /LOT-03/ })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Filter batch status"), { target: { value: "All statuses" } });
    fireEvent.click(screen.getByRole("button", { name: "Sort batches descending" }));
    const rows = within(document.querySelector(".inventory-batches-card") as HTMLElement).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("LOT-03");
    expect(rows[1]).toHaveTextContent("Fresh");
    expect(rows[2]).toHaveTextContent("LOT-01");
    expect(rows[2]).toHaveTextContent("Expiring Soon");
    expect(rows[3]).toHaveTextContent("LOT-02");
    expect(rows[3]).toHaveTextContent("Expired");
  });
});
