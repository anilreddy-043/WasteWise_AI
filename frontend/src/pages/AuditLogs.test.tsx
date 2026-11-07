import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AuditLogs from "./AuditLogs";
import { formatAppDateTime } from "../services/generalSettings";
import * as auditLogs from "../services/auditLogs";

vi.mock("../services/auditLogs", () => ({
	loadAuditLogFilters: vi.fn(),
	loadAuditLogs: vi.fn(),
}));

const record = {
	activity_id: 1,
	user_id: 1,
	actor_name: "Store Manager",
	action: "product_updated",
	entity_type: "product",
	entity_id: 9,
	created_at: "2026-03-01T10:00:00Z",
	status: "successful" as const,
	details: { changed_fields: ["price", "name"] },
};

const response = {
	items: [record],
	total: 21,
	page: 1,
	page_size: 10,
	total_pages: 3,
	timezone: "Asia/Kolkata",
};

describe("AuditLogs", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(auditLogs.loadAuditLogFilters).mockResolvedValue({
			actions: ["product_updated", "auth_login_failed"],
			actors: [{ user_id: 1, full_name: "Store Manager" }],
			has_unknown_actor: true,
			timezone: "Asia/Kolkata",
		});
		vi.mocked(auditLogs.loadAuditLogs).mockResolvedValue(response);
	});

	it("shows activity details using the configured timezone formatter", async () => {
		render(<AuditLogs onNotify={vi.fn()} />);
		expect((await screen.findAllByText("product updated")).length).toBeGreaterThan(0);
		expect(screen.getByText(formatAppDateTime(record.created_at))).toBeInTheDocument();
		expect(screen.getByText(/price, name/)).toBeInTheDocument();
		expect(screen.getByText("Showing 1–10 of 21 activities · Asia/Kolkata")).toBeInTheDocument();
	});

	it("applies action, actor and date filters and requests the next page", async () => {
		render(<AuditLogs onNotify={vi.fn()} />);
		await screen.findAllByText("product updated");
		fireEvent.change(screen.getByLabelText("Filter by action"), { target: { value: "product_updated" } });
		fireEvent.change(screen.getByLabelText("Filter by user"), { target: { value: "1" } });
		fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-03-01" } });
		fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));

		await waitFor(() => {
			expect(auditLogs.loadAuditLogs).toHaveBeenLastCalledWith(expect.objectContaining({
				action: "product_updated",
				user_id: 1,
				start_date: "2026-03-01",
				page: 1,
			}));
		});

		fireEvent.click(screen.getByRole("button", { name: "Next page" }));
		await waitFor(() => {
			expect(auditLogs.loadAuditLogs).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
		});
	});

	it("submits status and server-side sorting and renders actor role and affected record", async () => {
		vi.mocked(auditLogs.loadAuditLogs).mockResolvedValueOnce({
			...response,
			items: [{ ...record, actor_role: "store_manager", affected_record: "Fresh Greens #9" }],
		});
		render(<AuditLogs onNotify={vi.fn()} compact />);
		expect(await screen.findByText("Fresh Greens #9")).toBeInTheDocument();
		expect(screen.getByText("store manager")).toBeInTheDocument();
		expect(screen.queryByRole("heading", { name: "Audit Logs" })).not.toBeInTheDocument();

		fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "failed" } });
		fireEvent.change(screen.getByLabelText("Sort audit logs by"), { target: { value: "actor" } });
		fireEvent.change(screen.getByLabelText("Sort order"), { target: { value: "asc" } });
		fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));

		await waitFor(() => {
			expect(auditLogs.loadAuditLogs).toHaveBeenLastCalledWith(expect.objectContaining({
				status: "failed",
				sort_by: "actor",
				sort_order: "asc",
			}));
		});
	});

	it("displays load failures instead of a success-shaped empty state", async () => {
		vi.mocked(auditLogs.loadAuditLogs).mockRejectedValueOnce(new Error("Audit database unavailable"));
		const notify = vi.fn();
		render(<AuditLogs onNotify={notify} />);
		expect(await screen.findByRole("alert")).toHaveTextContent("Audit database unavailable");
		expect(notify).toHaveBeenCalledWith("Audit database unavailable");
	});
});
