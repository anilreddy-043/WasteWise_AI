import { describe, expect, it } from "vitest";
import { CAULIFLOWER_SYMBOL, PAPAYA_SYMBOL, productSymbol } from "./productSymbols";

describe("productSymbol", () => {
  it("uses product-specific icons for the products currently in the catalog", () => {
    const catalogIcons: Array<[string, string]> = [
      ["Brown Bread", "🍞"],
      ["Pav Bread", "🥯"],
      ["Jaggery", "🟫"],
      ["Sunflower Oil", "🫙"],
      ["Butter", "🧈"],
      ["Buttermilk", "🥛"],
      ["Cheese", "🧀"],
      ["Fresh Cream", "🥛"],
      ["Fresh Milk", "🥛"],
      ["Paneer", "🧀"],
      ["Milk", "🥛"],
      ["Bananas", "🍌"],
      ["Green Grapes", "🍇"],
      ["Mangoes", "🥭"],
      ["Oranges", "🍊"],
      ["Papaya", PAPAYA_SYMBOL],
      ["Pineapple", "🍍"],
      ["Potatoes", "🥔"],
      ["Tomatoes", "🍅"],
      ["Watermelon", "🍉"],
      ["Basmati Rice", "🍚"],
      ["Moong Dal", "🫘"],
      ["Toor Dal", "🫘"],
      ["Wheat Flour", "🌾"],
      ["Fish", "🐟"],
      ["Broccoli", "🥦"],
      ["Carrots", "🥕"],
      ["Cauliflower", CAULIFLOWER_SYMBOL],
      ["Cucumber", "🥒"],
      ["Green Capsicum", "🫑"],
      ["Green Peas", "🫛"],
      ["Onions", "🧅"],
      ["Sweet Corn", "🌽"],
    ];

    for (const [name, symbol] of catalogIcons) {
      expect(productSymbol(name), name).toBe(symbol);
    }
  });

  it("uses the product name before a potentially inconsistent category", () => {
    expect(productSymbol("Tomatoes", "Fruits")).toBe("🍅");
    expect(productSymbol("Potatoes", "Fruits")).toBe("🥔");
    expect(productSymbol("  fReSh mIlK  ", "Vegetables")).toBe("🥛");
    expect(productSymbol("PAPAYAS", "Melons")).toBe(PAPAYA_SYMBOL);
    expect(productSymbol("Cauliflower", "Vegetables")).toBe(CAULIFLOWER_SYMBOL);
    expect(productSymbol("Broccoli", "Vegetables")).toBe("🥦");
    expect(productSymbol("Cauliflower", "Vegetables")).not.toBe(productSymbol("Broccoli", "Vegetables"));
    expect(productSymbol("Sugar", "Grains")).toBe("🍬");
    expect(productSymbol("Basmati Rice", "Grains")).toBe("🍚");
  });

  it("uses category-specific icons for unmatched product names", () => {
    const categoryFallbacks: Array<[string, string]> = [
      ["Fruits", "🍎"],
      ["Vegetables", "🥬"],
      ["Dairy Products", "🥛"],
      ["Bakery Products", "🍞"],
      ["Grains", "🌾"],
      ["Pulses", "🫘"],
      ["Seafood", "🐟"],
      ["Meat & Poultry", "🍗"],
      ["Beverages", "🥤"],
      ["Cooking Essentials", "🫙"],
      ["Frozen Foods", "🧊"],
      ["Ready-to-Eat Foods", "🍱"],
      ["Fresh Juices", "🧃"],
    ];

    for (const [category, symbol] of categoryFallbacks) {
      expect(productSymbol("Unknown product", category), category).toBe(symbol);
    }
    expect(productSymbol("Unlisted item", "Unknown")).toBe("🛍️");
  });
});
