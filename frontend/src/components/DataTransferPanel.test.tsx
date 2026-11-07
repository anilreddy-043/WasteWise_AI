import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DataTransferPanel from "./DataTransferPanel";
import * as dataTransfer from "../services/dataTransfer";

vi.mock("../services/dataTransfer", () => ({
  importCsv: vi.fn(),
  downloadExport: vi.fn(),
}));

const successfulImport: dataTransfer.ImportSummary = {
  dataset: "products",
  import_id: "c".repeat(64),
  total_records: 2,
  successful_records: 1,
  skipped_records: 1,
  failed_records: 0,
  errors: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  vi.mocked(dataTransfer.importCsv).mockResolvedValue(successfulImport);
  vi.mocked(dataTransfer.downloadExport).mockResolvedValue(new Blob(["data"]));
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:test"),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DataTransferPanel", () => {
  it("uploads a selected CSV and displays the returned import totals", async () => {
    const onNotify = vi.fn();
    render(<DataTransferPanel onNotify={onNotify} canImport canExport />);

    const file = new File(["product_name,category,sku,unit,price,supplier"], "products.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("Choose Products CSV file"), { target: { files: [file] } });
    expect(await screen.findByText("products.csv")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Import Products" }));

    expect(await screen.findByText("Successful: 1")).toBeInTheDocument();
    expect(screen.getByText("Skipped: 1")).toBeInTheDocument();
    expect(dataTransfer.importCsv).toHaveBeenCalledWith("products", file);
    expect(onNotify).toHaveBeenCalledWith("Import complete: 1 record(s) imported, 1 skipped.");
  });

  it("reports row validation errors and offers an error CSV download", async () => {
    vi.mocked(dataTransfer.importCsv).mockResolvedValueOnce({
      ...successfulImport,
      successful_records: 0,
      skipped_records: 0,
      failed_records: 1,
      errors: [{ row: 3, errors: ["SKU is required."] }],
    });
    render(<DataTransferPanel onNotify={vi.fn()} canImport canExport />);
    const file = new File(["invalid"], "products.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("Choose Products CSV file"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Import Products" }));

    expect(await screen.findByText("Row 3: SKU is required.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download error report" })).toBeInTheDocument();
  });

  it("downloads authenticated exports in the selected format", async () => {
    render(<DataTransferPanel onNotify={vi.fn()} canImport={false} canExport />);
    fireEvent.click(screen.getAllByRole("button", { name: "Excel" })[0]);

    await waitFor(() => {
      expect(dataTransfer.downloadExport).toHaveBeenCalledWith("products", "xlsx");
    });
  });

  it("does not allow imports for unauthorized roles", () => {
    render(<DataTransferPanel onNotify={vi.fn()} canImport={false} canExport={false} />);

    expect(screen.getAllByRole("button", { name: "Choose CSV" })[0]).toBeDisabled();
    expect(screen.getByText(/Imports are available to administrators/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "CSV" })[0]).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Excel" })[0]).toBeDisabled();
  });
});
