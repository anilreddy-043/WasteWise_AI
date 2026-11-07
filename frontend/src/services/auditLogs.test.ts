import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestAuthenticatedJson } from "./auth";
import { canViewAuditLogs, loadAuditLogFilters, loadAuditLogs } from "./auditLogs";

vi.mock("./auth", () => ({
	requestAuthenticatedJson: vi.fn(),
}));

describe("audit log service", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(requestAuthenticatedJson).mockResolvedValue({} as never);
	});

	it("allows only Admin and Store Manager roles to open audit history", () => {
		expect(canViewAuditLogs("admin")).toBe(true);
		expect(canViewAuditLogs("store_manager")).toBe(true);
		expect(canViewAuditLogs("staff")).toBe(false);
		expect(canViewAuditLogs("viewer")).toBe(false);
	});

	it("loads action and user filter choices from the authenticated endpoint", async () => {
		await loadAuditLogFilters();
		expect(requestAuthenticatedJson).toHaveBeenCalledWith("/api/v1/audit-logs/filters");
	});

	it("encodes audit filters and pagination as query parameters", async () => {
		await loadAuditLogs({
			search: "batch #3",
			action: "batch_updated",
			user_id: 4,
			start_date: "2026-03-01",
			end_date: "2026-03-02",
			status: "failed",
			sort_by: "actor",
			sort_order: "asc",
			page: 2,
			page_size: 20,
		});
		const [path] = vi.mocked(requestAuthenticatedJson).mock.calls[0];
		const url = new URL(String(path), "http://localhost");
		expect(url.pathname).toBe("/api/v1/audit-logs");
		expect(url.searchParams.get("search")).toBe("batch #3");
		expect(url.searchParams.get("action")).toBe("batch_updated");
		expect(url.searchParams.get("user_id")).toBe("4");
		expect(url.searchParams.get("start_date")).toBe("2026-03-01");
		expect(url.searchParams.get("page")).toBe("2");
		expect(url.searchParams.get("page_size")).toBe("20");
		expect(url.searchParams.get("status")).toBe("failed");
		expect(url.searchParams.get("sort_by")).toBe("actor");
		expect(url.searchParams.get("sort_order")).toBe("asc");
	});
});
