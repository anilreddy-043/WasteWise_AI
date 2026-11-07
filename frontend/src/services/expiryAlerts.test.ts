import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestAuthenticatedJson } from "./auth";
import { getExpiryAlertCharts, getExpiryAlertFilters, listExpiryAlerts } from "./expiryAlerts";

vi.mock("./auth", () => ({
  requestAuthenticatedBlob: vi.fn(),
  requestAuthenticatedJson: vi.fn(),
}));

describe("expiry alert API paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requestAuthenticatedJson).mockResolvedValue({} as never);
  });

  it("requests the backend expiry alert routes with matching query filters", async () => {
    await listExpiryAlerts({
      search: "milk",
      category: "Dairy",
      risk: "high",
      location: "Cold Room",
      supplier: "Farm",
      page: 2,
      page_size: 10,
    });
    await getExpiryAlertCharts({ category: "Dairy", risk: "medium" });
    await getExpiryAlertFilters();

    expect(requestAuthenticatedJson).toHaveBeenNthCalledWith(
      1,
      "/api/v1/expiry-alerts?search=milk&category=Dairy&risk=high&location=Cold+Room&supplier=Farm&page=2&page_size=10",
    );
    expect(requestAuthenticatedJson).toHaveBeenNthCalledWith(
      2,
      "/api/v1/expiry-alerts/charts?category=Dairy&risk=medium",
    );
    expect(requestAuthenticatedJson).toHaveBeenNthCalledWith(3, "/api/v1/expiry-alerts/filters");
    expect(vi.mocked(requestAuthenticatedJson).mock.calls.some(([path]) => path?.includes("/api/v1/api/v1/"))).toBe(false);
  });
});
