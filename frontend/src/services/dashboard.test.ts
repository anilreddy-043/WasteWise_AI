import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestAuthenticatedJson } from "./auth";
import { DASHBOARD_EXPIRY_WINDOW_DAYS, loadDashboardData, loadDashboardHighlights, loadWasteTrend } from "./dashboard";

vi.mock("./auth", () => ({
  requestAuthenticatedJson: vi.fn(),
}));

describe("loadDashboardData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requestAuthenticatedJson).mockResolvedValue({} as never);
  });

  it("uses the same alert window for the expiry summary and alert table", async () => {
    await loadDashboardData(
      { start_date: "2026-01-01", end_date: "2026-11-04" },
      { start_date: "2026-05-01", end_date: "2026-11-04" },
    );
    const highlights = loadDashboardHighlights();

    expect(DASHBOARD_EXPIRY_WINDOW_DAYS).toBe(7);
    const requests = vi.mocked(requestAuthenticatedJson).mock.calls.map(([path]) => path);
    const summaryRequest = requests.find((path) => path.startsWith("/api/v1/dashboard/summary?"));
    const alertsRequest = requests.find((path) => path.startsWith("/api/v1/dashboard/expiry-alerts?"));
    expect(summaryRequest).toContain(`within_days=${DASHBOARD_EXPIRY_WINDOW_DAYS}`);
    expect(alertsRequest).toContain(`within_days=${DASHBOARD_EXPIRY_WINDOW_DAYS}`);
    await expect(highlights.expiryAlerts).resolves.toMatchObject({ status: "fulfilled" });
  });

  it("loads range-specific dashboard data without refetching unchanged highlights", async () => {
    await loadDashboardData(
      { start_date: "2026-01-01", end_date: "2026-11-04" },
      { start_date: "2026-05-01", end_date: "2026-11-04" },
    );

    const requests = vi.mocked(requestAuthenticatedJson).mock.calls.map(([path]) => path);
    expect(requests).toHaveLength(7);
    expect(requests.some((path) => path.startsWith("/api/v1/dashboard/expiry-alerts?"))).toBe(false);
    expect(requests.some((path) => path.startsWith("/api/v1/dashboard/recommendations?"))).toBe(false);
  });

  it("requests daily waste data for a seven-day range", async () => {
    await loadDashboardData(
      { start_date: "2026-10-01", end_date: "2026-10-01" },
      { start_date: "2026-10-29", end_date: "2026-11-04" },
    );

    const wasteRequest = vi.mocked(requestAuthenticatedJson).mock.calls
      .map(([path]) => path)
      .find((path) => path.startsWith("/api/v1/dashboard/waste-trend?"));
    expect(wasteRequest).toBe("/api/v1/dashboard/waste-trend?start_date=2026-10-29&end_date=2026-11-04&granularity=day");
  });

  it("requests a waste trend for the selected date range and granularity", async () => {
    await loadWasteTrend({ start_date: "2026-10-01", end_date: "2026-11-04" }, "day");

    expect(requestAuthenticatedJson).toHaveBeenCalledWith(
      "/api/v1/dashboard/waste-trend?start_date=2026-10-01&end_date=2026-11-04&granularity=day",
    );
  });
});
