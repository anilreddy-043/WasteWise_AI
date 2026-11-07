import { describe, expect, it } from "vitest";
import { visiblePageNumbers } from "./pagination";

describe("visiblePageNumbers", () => {
  it("shows all available pages when there are fewer than the button limit", () => {
    expect(visiblePageNumbers(1, 3, 5)).toEqual([1, 2, 3]);
  });

  it("keeps a centered, unique page range on a middle page", () => {
    expect(visiblePageNumbers(5, 12, 5)).toEqual([3, 4, 5, 6, 7]);
  });

  it("shifts the range back at the last page without repeating numbers", () => {
    expect(visiblePageNumbers(6, 6, 5)).toEqual([2, 3, 4, 5, 6]);
  });

  it("bounds invalid current-page values to the available range", () => {
    expect(visiblePageNumbers(20, 6, 5)).toEqual([2, 3, 4, 5, 6]);
    expect(visiblePageNumbers(0, 0, 5)).toEqual([1]);
  });
});
