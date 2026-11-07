import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BatchManagement from "./BatchManagement";
import * as business from "../services/business";
import { calculateSuggestedExpiryDate } from "../services/expiryDates";
import { productSymbol } from "../services/productSymbols";

vi.mock("../services/business", () => ({
  createBatch: vi.fn(),
  confirmInventoryBatchImport: vi.fn(),
  deleteBatch: vi.fn(),
  getExpirySuggestion: vi.fn(),
  listInventoryBatchImports: vi.fn(),
  listBatches: vi.fn(),
  listProducts: vi.fn(),
  previewInventoryBatchImport: vi.fn(),
  updateBatch: vi.fn(),
  uploadProductImage: vi.fn(),
  deleteProductImage: vi.fn(),
}));

vi.mock("../services/productImageUpload", () => ({
  prepareProductImage: vi.fn(async (file: File) =>
    new File([file], `optimized-${file.name}.webp`, { type: "image/webp" })),
}));

const savedProduct: business.ProductRecord = {
  product_id: 14,
  name: "Saved Milk",
  category: "Dairy",
  sku: "MILK-14",
  unit: "Litre",
  price: 65,
  supplier: "Local Dairy",
  created_at: "",
  updated_at: "",
};

describe("BatchManagement existing product details", () => {
  beforeEach(() => {
    vi.mocked(business.listProducts).mockResolvedValue([savedProduct]);
    vi.mocked(business.listBatches).mockResolvedValue([]);
    vi.mocked(business.getExpirySuggestion).mockImplementation(async (productId, receivedAt) => ({
      product_id: productId,
      category: savedProduct.category,
      received_at: receivedAt,
      default_shelf_life_days: 9,
      expiry_date: calculateSuggestedExpiryDate(savedProduct.category, receivedAt) ?? null,
    }));
  });

  it("uses the saved category and unit when selecting an existing product", async () => {
    render(<BatchManagement onNotify={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /add batch/i }));

    fireEvent.change(screen.getByLabelText("Product name"), {
      target: { value: "  saved milk " },
    });

    expect(await screen.findByText("Saved product details · SKU MILK-14 · Dairy · Litre")).toBeInTheDocument();
    expect(document.querySelector(".batch-form-product-icon")).toHaveTextContent(productSymbol(savedProduct.name, savedProduct.category));
    expect(screen.getByLabelText("Category")).toHaveValue("Dairy");
  });

  it("renders received and remaining quantities from the live batch record", async () => {
    const batch: business.InventoryBatchRecord = {
      batch_id: 100,
      product_id: savedProduct.product_id,
      batch_code: "LOT-100",
      quantity_received: 12.5,
      quantity_remaining: 8,
      unit_cost: 0,
      received_at: "2030-01-02",
      expiry_date: "2030-02-02",
      expiry_date_source: "manufacturer_verified",
      status: "active",
      location: "Cold Room",
      supplier: savedProduct.supplier,
    };
    vi.mocked(business.listBatches).mockResolvedValue([batch]);
    render(<BatchManagement onNotify={vi.fn()} />);

    const row = await screen.findByText("LOT-100");
    const batchRow = row.closest("tr");
    expect(batchRow).toHaveTextContent("12.5");
    expect(batchRow).toHaveTextContent("8");
    expect(batchRow).toHaveTextContent("Fresh");
    expect(batchRow?.querySelector(".batch-product-icon")).toHaveTextContent(productSymbol(savedProduct.name, savedProduct.category));

    fireEvent.click(screen.getByRole("button", { name: "View LOT-100" }));
    expect(screen.getByText("Quantity received").parentElement).toHaveTextContent("12.5 units");
    expect(screen.getByText("Quantity remaining").parentElement).toHaveTextContent("8 units");
    expect(screen.getByText("Expiry date").parentElement).toHaveTextContent("Feb");
    expect(screen.getByText("Storage location").parentElement).toHaveTextContent("Cold Room");
    expect(screen.getByLabelText("Products at Cold Room: Saved Milk")).toHaveTextContent(productSymbol(savedProduct.name, savedProduct.category));
  });

  it("shows unique pagination numbers on the last batch page", async () => {
    vi.mocked(business.listBatches).mockResolvedValue(Array.from({ length: 60 }, (_, index) => ({
      batch_id: index + 1,
      product_id: savedProduct.product_id,
      batch_code: `LOT-${index + 1}`,
      quantity_received: 12,
      quantity_remaining: 8,
      unit_cost: 0,
      received_at: "2030-01-02",
      expiry_date: "2030-02-02",
      expiry_date_source: "manufacturer_verified",
      status: "active",
      location: "Cold Room",
      supplier: savedProduct.supplier,
    })));
    render(<BatchManagement onNotify={vi.fn()} />);
    await screen.findByText("LOT-1");

    for (let index = 0; index < 5; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Next batch page" }));
    }

    expect(await screen.findByText("LOT-51")).toBeInTheDocument();
    expect(screen.getByText("Showing 51 to 60 of 60 batches")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^[1-6]$/ }).map((button) => button.textContent))
      .toEqual(["2", "3", "4", "5", "6"]);
  });

  it("uploads a product image from batch edit without replacing its symbol", async () => {
    const batch: business.InventoryBatchRecord = {
      batch_id: 101,
      product_id: savedProduct.product_id,
      batch_code: "LOT-101",
      quantity_received: 12,
      quantity_remaining: 8,
      unit_cost: 0,
      received_at: "2030-01-02",
      expiry_date: "2030-02-02",
      expiry_date_source: "manufacturer_verified",
      status: "active",
      location: "Cold Room",
      supplier: savedProduct.supplier,
    };
    vi.mocked(business.listBatches).mockResolvedValue([batch]);
    vi.mocked(business.uploadProductImage).mockResolvedValue({
      image_url: "/api/v1/products/14/image?v=updated",
    });
    render(<BatchManagement onNotify={vi.fn()} />);
    await screen.findByText("LOT-101");
    fireEvent.click(screen.getByRole("button", { name: "Edit LOT-101" }));

    expect(screen.getByText(/Any image dimensions or shape are accepted/)).toBeInTheDocument();
    const file = new File(["image"], "milk.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Upload product image"), { target: { files: [file] } });

    await waitFor(() => expect(business.uploadProductImage).toHaveBeenCalledWith(
      savedProduct.product_id,
      expect.objectContaining({ name: "optimized-milk.png.webp", type: "image/webp" }),
    ));
    expect(await screen.findByText("Image saved")).toBeInTheDocument();
    expect(document.querySelector(".batch-form-product-icon")).toHaveTextContent(productSymbol(savedProduct.name, savedProduct.category));
    expect(document.querySelector(".batch-modal img")).toBeNull();
  });

  it("suggests the category expiry and keeps a manual override when dates change", async () => {
    vi.mocked(business.createBatch).mockResolvedValue({
      batch_id: 7,
      product_id: savedProduct.product_id,
      batch_code: "LOT-7",
      quantity_received: 2,
      quantity_remaining: 2,
      unit_cost: 0,
      received_at: "2026-10-01",
      expiry_date: "2026-10-20",
      status: "active",
      location: "Unassigned",
      supplier: savedProduct.supplier,
    });
    render(<BatchManagement onNotify={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /add batch/i }));

    const received = screen.getByLabelText("Received date");
    const expiry = screen.getByLabelText("Batch expiry date");

    fireEvent.change(screen.getByLabelText("Product name"), { target: { value: savedProduct.name } });
    await waitFor(() => expect(expiry).toHaveValue(calculateSuggestedExpiryDate("Dairy", (received as HTMLInputElement).value) ?? ""));
    fireEvent.change(expiry, { target: { value: "2026-11-20" } });
    fireEvent.change(received, { target: { value: "2026-10-01" } });
    expect(expiry).toHaveValue("2026-11-20");

    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /save batch/i }));

    await waitFor(() => expect(business.createBatch).toHaveBeenCalledWith(expect.objectContaining({
        received_at: "2026-10-01",
        expiry_date: "2026-11-20",
        expiry_date_source: "manual_verified",
      })));
  });

  it("previews a CSV and confirms import only after validation", async () => {
    const csvText = "product_name,sku,batch_code,quantity_received,received_at,expiry_date,location\nSaved Milk,MILK-14,LOT-8,5,2026-10-01,2026-10-10,Cold Room";
    vi.mocked(business.listInventoryBatchImports).mockResolvedValue([]);
    vi.mocked(business.previewInventoryBatchImport).mockResolvedValue({
      row_count: 1,
      valid_count: 1,
      invalid_count: 0,
      missing_product_count: 0,
      rows: [{
        row_number: 2,
        values: {
          product_name: "Saved Milk",
          sku: "MILK-14",
          category: "Dairy",
          unit: "Litre",
          price: "65",
          batch_code: "LOT-8",
          quantity_received: "5",
          quantity_remaining: "",
          unit_cost: "",
          received_at: "2026-10-01",
          expiry_date: "2026-10-10",
          location: "Cold Room",
          supplier: "Local Dairy",
        },
        errors: [],
        product_status: "matched_by_sku",
        matched_product: { product_id: 14, name: "Saved Milk", sku: "MILK-14" },
        can_create_product: false,
      }],
    });
    vi.mocked(business.confirmInventoryBatchImport).mockResolvedValue({
      import_id: "import-1",
      inserted: 1,
      products_created: 0,
      batches: [],
    });
    render(<BatchManagement onNotify={vi.fn()} canImport />);

    fireEvent.click(await screen.findByRole("button", { name: /import batches csv/i }));
    await waitFor(() => expect(business.listInventoryBatchImports).toHaveBeenCalled());
    const file = new File([csvText], "batches.csv", { type: "text/csv" });
    Object.defineProperty(file, "text", { value: vi.fn().mockResolvedValue(csvText) });
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(await screen.findByLabelText("CSV validation summary")).toHaveTextContent("1 valid");
    fireEvent.click(screen.getByRole("button", { name: /import 1 valid batches/i }));
    await waitFor(() => expect(business.confirmInventoryBatchImport).toHaveBeenCalledWith(
      expect.stringContaining("LOT-8"),
      expect.any(String),
      false,
    ));
  });
});
