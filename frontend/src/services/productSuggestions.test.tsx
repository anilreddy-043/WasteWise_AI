import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ProductSuggestionAction from "../components/ProductSuggestionAction";
import {
  findExistingProduct,
  getProductSuggestion,
  PRODUCT_CATEGORIES,
  PRODUCT_UNITS,
} from "./productSuggestions";

vi.mock("./business", () => ({
  suggestProductSku: vi.fn(),
}));

import * as business from "./business";

beforeEach(() => {
  vi.mocked(business.suggestProductSku).mockClear();
  vi.mocked(business.suggestProductSku).mockImplementation(async (category) => {
    const prefix = category === "Vegetables" ? "VEG" : category === "Snacks" ? "SNK" : "FRU";
    return { category, prefix, sku: `${prefix}001` };
  });
});

describe("product suggestions", () => {
  it("uses the supplied 18 categories and 20 units", () => {
    expect(PRODUCT_CATEGORIES).toHaveLength(19);
    expect(PRODUCT_UNITS).toHaveLength(20);
  });

  it.each([
    ["Banana", "Fruits", "Piece (pcs)"],
    ["Apple", "Fruits", "Kilogram (kg)"],
    ["Fresh Milk", "Dairy Products", "Litre (L)"],
    ["Butter", "Dairy Products", "Pack"],
    ["Basmati Rice", "Grains & Cereals", "Kilogram (kg)"],
    ["Wheat Flour", "Grains & Cereals", "Kilogram (kg)"],
    ["Tomato", "Vegetables", "Kilogram (kg)"],
    ["Potato", "Vegetables", "Kilogram (kg)"],
    ["Brown Bread", "Bakery Products", "Pack"],
    ["Chicken", "Meat & Poultry", "Kilogram (kg)"],
    ["Fish", "Seafood", "Kilogram (kg)"],
    ["Fresh Fish", "Seafood", "Kilogram (kg)"],
    ["Fresh Juice", "Fresh Juices", "Litre (L)"],
    ["Orange Juice", "Beverages", "Litre (L)"],
    ["Potato Chips", "Snacks", "Packet (pkt)"],
    ["Turmeric Powder", "Spices & Masalas", "Packet (pkt)"],
    ["Sunflower Oil", "Cooking Essentials", "Litre (L)"],
    ["Frozen Peas", "Frozen Foods", "Packet (pkt)"],
    ["Tomato Ketchup", "Condiments & Sauces", "Bottle (btl)"],
    ["Shampoo", "Personal Care", "Bottle (btl)"],
    ["Detergent", "Household Essentials", "Packet (pkt)"],
  ])("suggests the requested category and unit for %s", (name, category, unit) => {
    expect(getProductSuggestion(name)).toEqual({ category, unit });
  });

  it("normalizes case, partial names, spelling variants, and punctuation", () => {
    expect(getProductSuggestion("FRESH mi")).toEqual({
      category: "Dairy Products",
      unit: "Litre (L)",
    });
    expect(getProductSuggestion("bannana")).toEqual({
      category: "Fruits",
      unit: "Piece (pcs)",
    });
    expect(getProductSuggestion("  tomato-ketchup  ")).toEqual({
      category: "Condiments & Sauces",
      unit: "Bottle (btl)",
    });
  });

  it("returns no suggestion for unclear names or options outside the approved lists", () => {
    expect(getProductSuggestion("Unlisted mystery item")).toBeNull();
    expect(getProductSuggestion("Ba")).toBeNull();
    expect(getProductSuggestion("Banana", ["Other"], PRODUCT_UNITS)).toBeNull();
    expect(getProductSuggestion("Banana", PRODUCT_CATEGORIES, ["Unit"])).toBeNull();
  });

  it("matches an existing saved product case-insensitively", () => {
    const savedProduct = { name: "Fresh Milk", category: "Dairy", unit: "Litre" };
    expect(findExistingProduct([savedProduct], "  fresh MILK ")).toBe(savedProduct);
    expect(findExistingProduct([savedProduct], "Milk")).toBeUndefined();
  });
});

describe("ProductSuggestionAction", () => {
  it("refreshes all suggestions by name but only applies them on explicit request", async () => {
    const onApply = vi.fn();
    const onApplySku = vi.fn();
    const { rerender } = render(
      <ProductSuggestionAction
        productName="Banana"
        selectedCategory="Fruits"
        onApply={onApply}
        onApplySku={onApplySku}
      />,
    );

    expect(screen.getByText("Fruits")).toBeInTheDocument();
    expect(await screen.findByText("FRU001")).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();

    rerender(
      <ProductSuggestionAction
        productName="Potato"
        selectedCategory="Vegetables"
        onApply={onApply}
        onApplySku={onApplySku}
      />,
    );
    expect(await screen.findByText("VEG001")).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Apply Suggestions/ }));
    expect(onApply).toHaveBeenCalledWith(
      { category: "Vegetables", unit: "Kilogram (kg)" },
      "VEG001",
    );
    expect(onApplySku).not.toHaveBeenCalled();
  });

  it("allows explicit SKU generation from the selected category for an unknown name", async () => {
    const onApply = vi.fn();
    const onApplySku = vi.fn();
    render(
      <ProductSuggestionAction
        productName="Mystery item"
        selectedCategory="Snacks"
        onApply={onApply}
        onApplySku={onApplySku}
      />,
    );
    expect(screen.getByText(/No category or unit suggestion available/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Generate SKU from selected category/ }));

    await waitFor(() => expect(onApplySku).toHaveBeenCalledWith("SNK001"));
    expect(onApply).not.toHaveBeenCalled();
    expect(business.suggestProductSku).toHaveBeenCalledWith("Snacks");
  });

  it("preserves the saved SKU unless the user explicitly generates a replacement", async () => {
    const onApply = vi.fn();
    const onApplySku = vi.fn();
    render(
      <ProductSuggestionAction
        productName="Banana"
        selectedCategory="Fruits"
        savedSku="FRU005"
        onApply={onApply}
        onApplySku={onApplySku}
      />,
    );

    expect(screen.getByText("FRU005")).toBeInTheDocument();
    expect(business.suggestProductSku).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Apply Suggestions/ }));
    expect(onApply).toHaveBeenCalledWith(
      { category: "Fruits", unit: "Piece (pcs)" },
      undefined,
    );
    expect(onApplySku).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Generate a different SKU/ }));
    await waitFor(() => expect(onApplySku).toHaveBeenCalledWith("FRU001"));
  });
});
