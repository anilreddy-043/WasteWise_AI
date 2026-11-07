import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestAuthenticatedJson } from "./auth";
import { canViewSystemHealth, loadSystemHealth } from "./systemHealth";

vi.mock("./auth", () => ({
	requestAuthenticatedJson: vi.fn(),
}));

describe("system health service", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(requestAuthenticatedJson).mockResolvedValue({} as never);
	});

	it("allows only Admin and Store Manager roles", () => {
		expect(canViewSystemHealth("admin")).toBe(true);
		expect(canViewSystemHealth("store_manager")).toBe(true);
		expect(canViewSystemHealth("staff")).toBe(false);
		expect(canViewSystemHealth("viewer")).toBe(false);
	});

	it("loads health through the authenticated API client", async () => {
		await loadSystemHealth();
		expect(requestAuthenticatedJson).toHaveBeenCalledWith("/api/v1/system-health");
	});
});
