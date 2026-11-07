import { describe, expect, it } from "vitest";
import { calculateSuggestedExpiryDate, getShelfLifeDays } from "./expiryDates";

describe("category shelf-life suggestions", () => {
  it.each([
    ["Seafood", 2],
    ["Meat & Poultry", 3],
    ["Dairy Products", 9],
    ["Bakery Products", 5],
    ["Vegetables", 9],
    ["Fruits", 9],
    ["Ready-to-Eat Foods", 4],
    ["Fresh Juices", 3],
    ["Frozen Foods", 228],
    ["Beverages", 105],
  ])("%s has a %i-day shelf life", (category, days) => {
    expect(getShelfLifeDays(category)).toBe(days);
  });

  it("supports legacy Dairy and Bakery catalog categories", () => {
    expect(getShelfLifeDays(" Dairy ")).toBe(9);
    expect(getShelfLifeDays("Bakery")).toBe(5);
  });

  it("calculates from the received date, including month and leap-year boundaries", () => {
    expect(calculateSuggestedExpiryDate("Seafood", "2026-01-30")).toBe("2026-02-01");
    expect(calculateSuggestedExpiryDate("Vegetables", "2024-02-25")).toBe("2024-03-05");
  });

  it("leaves categories without a default for manual verification", () => {
    expect(calculateSuggestedExpiryDate("Snacks", "2026-01-01")).toBeUndefined();
    expect(calculateSuggestedExpiryDate("Fruits", "2026-02-30")).toBeUndefined();
  });
});
