import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SalesPos from "./SalesPos";
import * as business from "../services/business";

vi.mock("../services/business", () => ({
  listProducts: vi.fn(),
  listInventorySummary: vi.fn(),
  listBatches: vi.fn(),
  listRecommendations: vi.fn(),
  checkoutSale: vi.fn(),
}));

const product = {
  product_id: 1,
  name: "Fresh Mangoes",
  category: "Fruits",
  sku: "MANGO-1",
  unit: "kg",
  price: 120,
  supplier: "Fresh Farm",
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
};

const inventory = {
  product_id: 1,
  product_name: "Fresh Mangoes",
  category: "Fruits",
  sku: "MANGO-1",
  unit: "kg",
  price: 120,
  supplier: "Fresh Farm",
  quantity: 10,
  inventory_value: 1200,
  active_batch_count: 1,
  source: "actual" as const,
};

const transaction = {
  sale_transaction_id: 5,
  transaction_number: "POS-20261103-0005",
  subtotal: 120,
  discount_type: "percentage" as const,
  discount_value: 0,
  discount_amount: 0,
  total_amount: 120,
  payment_method: "cash" as const,
  sold_at: "2026-11-03T10:00:00Z",
  processed_by: 7,
  status: "completed",
  idempotency_key: "test-key",
  created_at: "2026-11-03T10:00:00Z",
  updated_at: "2026-11-03T10:00:00Z",
  items: [{
    sale_item_id: 1,
    product_id: 1,
    quantity: 1,
    unit_price: 120,
    line_subtotal: 120,
    discount_amount: 0,
    line_total: 120,
    allocations: [],
  }],
};

function renderPos() {
  return render(<SalesPos onNotify={vi.fn()} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(business.listProducts).mockResolvedValue([product]);
  vi.mocked(business.listInventorySummary).mockResolvedValue([inventory]);
  vi.mocked(business.listBatches).mockResolvedValue([]);
  vi.mocked(business.listRecommendations).mockResolvedValue([]);
  let key = 0;
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    value: () => `00000000-0000-4000-8000-${String(++key).padStart(12, "0")}`,
  });
});

describe("SalesPos checkout", () => {
  it("submits cart without client prices and displays server totals", async () => {
    vi.mocked(business.checkoutSale).mockResolvedValue(transaction);
    renderPos();
    await screen.findByText("Fresh Mangoes");
    const productPhoto = screen.getByRole("img", { name: "Fresh Mangoes product photo" });
    expect(productPhoto.querySelector("img")).toHaveAttribute("src", "/images/products/3-mangoes.jpg");
    expect(document.querySelector(".pos-product-category")).toHaveTextContent("Fruits");
    fireEvent.click(screen.getByRole("button", { name: /add/i }));
    fireEvent.click(screen.getByRole("button", { name: /complete sale/i }));

    await screen.findByText(/Sale completed: POS-20261103-0005/i);
    expect(business.checkoutSale).toHaveBeenCalledTimes(1);
    expect(business.checkoutSale).toHaveBeenCalledWith(expect.objectContaining({
      items: [{ product_id: 1, quantity: 1 }],
      discount: { type: "percentage", value: 0 },
      payment_method: "cash",
      idempotency_key: expect.any(String),
    }));
    expect(screen.getByText(/Total ₹120/i)).toBeInTheDocument();
    expect(screen.getByText(/Your bill is empty/i)).toBeInTheDocument();
    const receipt = document.querySelector(".pos-receipt-print");
    expect(receipt).not.toBeNull();
    expect(receipt).toHaveTextContent("Fresh Mangoes");
    expect(receipt).toHaveTextContent("POS-20261103-0005");
    expect(receipt?.querySelector(".pos-receipt-photo img")).toHaveAttribute("src", "/images/products/3-mangoes.jpg");
    const print = vi.fn();
    Object.defineProperty(window, "print", { configurable: true, value: print });
    fireEvent.click(screen.getByRole("button", { name: "Print receipt" }));
    expect(print).toHaveBeenCalledOnce();
  });

  it("uses an uploaded product image in the POS card", async () => {
    vi.mocked(business.listProducts).mockResolvedValue([{
      ...product,
      image_url: "/api/v1/products/1/image?v=123",
    }]);
    renderPos();

    const photo = await screen.findByRole("img", { name: "Fresh Mangoes product photo" });
    expect(photo.querySelector("img")).toHaveAttribute("src", "/api/v1/products/1/image?v=123");
  });

  it("filters POS products with category chips", async () => {
    const grainProduct = { ...product, product_id: 2, name: "Rice", category: "Grains", sku: "RICE-2" };
    vi.mocked(business.listProducts).mockResolvedValue([product, grainProduct]);
    vi.mocked(business.listInventorySummary).mockResolvedValue([
      inventory,
      { ...inventory, product_id: 2, product_name: "Rice", category: "Grains", sku: "RICE-2" },
    ]);
    renderPos();

    await screen.findByText("Fresh Mangoes");
    expect(screen.getByText("Rice")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fruits" }));

    expect(screen.getByText("Fresh Mangoes")).toBeInTheDocument();
    expect(screen.queryByText("Rice")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("Rice")).toBeInTheDocument();
  });

  it("shows approved discounts for active batches in the product hero", async () => {
    vi.mocked(business.listBatches).mockResolvedValue([{
      batch_id: 10,
      product_id: 1,
      batch_code: "LOT-MANGO-10",
      quantity_received: 8,
      quantity_remaining: 5,
      unit_cost: 60,
      received_at: "2026-10-01",
      expiry_date: "2099-12-31",
      status: "active",
      location: "Front shelf",
      supplier: "Fresh Farm",
    }]);
    vi.mocked(business.listRecommendations).mockResolvedValue([{
      recommendation_id: 23,
      product_id: 1,
      batch_id: 10,
      recommendation_type: "discount",
      recommended_quantity: null,
      discount_percent: 15,
      reason: "Approved promotion",
      status: "approved",
      created_at: "2026-11-06T00:00:00Z",
      updated_at: "2026-11-06T00:00:00Z",
      applied_by: 1,
    }]);
    renderPos();

    const hero = await screen.findByRole("region", { name: "Current product discounts" });
    expect(within(hero).getByText("15% OFF")).toBeInTheDocument();
    expect(within(hero).getByText("LOT-MANGO-10 · APPROVED OFFER")).toBeInTheDocument();
    expect(within(hero).getByText("Eligible batch discount applies at checkout")).toBeInTheDocument();
    fireEvent.click(within(hero).getByRole("button", { name: "Add to bill" }));
    expect(screen.getByText("1 item")).toBeInTheDocument();
  });

  it("preserves the cart and shows checkout API failures", async () => {
    vi.mocked(business.checkoutSale).mockRejectedValue(new Error("Insufficient stock for Fresh Mangoes."));
    renderPos();
    await screen.findByText("Fresh Mangoes");
    fireEvent.click(screen.getByRole("button", { name: /add/i }));
    fireEvent.click(screen.getByRole("button", { name: /complete sale/i }));

    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("Insufficient stock for Fresh Mangoes.");
    expect(screen.getByText("Fresh Mangoes", { selector: "b" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /complete sale/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /add/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /increase fresh mangoes/i })).toBeEnabled();
    expect(screen.getByLabelText("Discount type")).toBeEnabled();
    expect(screen.getByLabelText(/payment method/i)).toBeEnabled();
  });

  it("prevents a second submission while checkout is processing", async () => {
    let resolveCheckout!: (value: typeof transaction) => void;
    vi.mocked(business.checkoutSale).mockImplementation(() => new Promise((resolve) => { resolveCheckout = resolve; }));
    renderPos();
    await screen.findByText("Fresh Mangoes");
    fireEvent.click(screen.getByRole("button", { name: /add/i }));
    const button = screen.getByRole("button", { name: /complete sale/i });
    fireEvent.click(button);

    await screen.findByRole("button", { name: /processing sale/i });
    expect(screen.getByRole("button", { name: /processing sale/i })).toBeDisabled();
    expect(business.checkoutSale).toHaveBeenCalledTimes(1);
    await act(async () => { resolveCheckout(transaction); });
  });

  it("keeps checkout success visible and warns when post-sale inventory refresh fails", async () => {
    vi.mocked(business.checkoutSale).mockResolvedValue(transaction);
    vi.mocked(business.listProducts)
      .mockResolvedValueOnce([product])
      .mockRejectedValueOnce(new Error("Inventory refresh failed"));
    vi.mocked(business.listInventorySummary).mockResolvedValue([inventory]);
    renderPos();
    await screen.findByText("Fresh Mangoes");
    fireEvent.click(screen.getByRole("button", { name: /add/i }));
    const key = vi.mocked(business.checkoutSale);
    fireEvent.click(screen.getByRole("button", { name: /complete sale/i }));

    await screen.findByText(/Sale completed: POS-20261103-0005/i);
    expect(await screen.findByRole("alert")).toHaveTextContent("Sale completed successfully, but inventory could not be refreshed. Please refresh the page.");
    expect(screen.queryByText(/sale could not be completed/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Your bill is empty/i)).toBeInTheDocument();
    expect(key).toHaveBeenCalledTimes(1);
    expect(vi.mocked(business.listProducts)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(business.listInventorySummary)).toHaveBeenCalledTimes(2);
  });

  it("locks cart and payment controls while checkout is processing", async () => {
    let resolveCheckout!: (value: typeof transaction) => void;
    vi.mocked(business.checkoutSale).mockImplementation(() => new Promise((resolve) => { resolveCheckout = resolve; }));
    renderPos();
    await screen.findByText("Fresh Mangoes");
    fireEvent.click(screen.getByRole("button", { name: /add/i }));
    fireEvent.click(screen.getByRole("button", { name: /complete sale/i }));

    await screen.findByRole("button", { name: /processing sale/i });
    expect(screen.getByRole("button", { name: /add/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /clear cart/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /increase fresh mangoes/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /decrease fresh mangoes/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /remove fresh mangoes/i })).toBeDisabled();
    expect(screen.getByLabelText("Discount type")).toBeDisabled();
    expect(screen.getByLabelText("Discount value")).toBeDisabled();
    expect(screen.getByLabelText(/payment method/i)).toBeDisabled();
    await act(async () => { resolveCheckout(transaction); });
  });

  it("reuses the idempotency key after a retry and rotates it after an attempt changes", async () => {
    vi.mocked(business.checkoutSale)
      .mockRejectedValueOnce(new Error("Network failure"))
      .mockResolvedValueOnce(transaction);
    renderPos();
    await screen.findByText("Fresh Mangoes");
    fireEvent.click(screen.getByRole("button", { name: /add/i }));
    fireEvent.click(screen.getByRole("button", { name: /complete sale/i }));
    await screen.findByRole("alert");
    const firstKey = vi.mocked(business.checkoutSale).mock.calls[0][0].idempotency_key;

    fireEvent.click(screen.getByRole("button", { name: /complete sale/i }));
    await screen.findByText(/Sale completed: POS-20261103-0005/i);
    const retryKey = vi.mocked(business.checkoutSale).mock.calls[1][0].idempotency_key;
    expect(retryKey).toBe(firstKey);

    fireEvent.click(screen.getByRole("button", { name: /add/i }));
    await waitFor(() => expect(screen.getByText("Fresh Mangoes", { selector: "b" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /complete sale/i }));
    await waitFor(() => expect(business.checkoutSale).toHaveBeenCalledTimes(3));
    expect(vi.mocked(business.checkoutSale).mock.calls[2][0].idempotency_key).not.toBe(retryKey);
  });
});
