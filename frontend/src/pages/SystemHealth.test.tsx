import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SystemHealth from "./SystemHealth";
import * as systemHealth from "../services/systemHealth";

vi.mock("../services/systemHealth", () => ({
	loadSystemHealth: vi.fn(),
}));

const healthyResponse: systemHealth.SystemHealthResponse = {
	status: "healthy",
	checked_at: "2026-11-06T12:00:00Z",
	last_successful_check: "2026-11-06T12:00:00Z",
	api: { status: "available" },
	frontend_backend: { status: "connected", message: "Frontend request reached the authenticated API." },
	database: { status: "available" },
	ml_models: [
		{ name: "demand_forecast", artifact: "demand_forecast.joblib", status: "available" },
		{ name: "discount_recommendation", artifact: "discount_recommendation.joblib", status: "available" },
		{ name: "expiry_risk", artifact: "expiry_risk.joblib", status: "available" },
	],
	app_version: "1.0.0",
	uptime_seconds: 3661,
	errors: [],
};

describe("SystemHealth", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(systemHealth.loadSystemHealth).mockResolvedValue(healthyResponse);
	});

	it("shows live service and model status with Admin details", async () => {
		render(<SystemHealth isAdmin onNotify={vi.fn()} />);

		expect(await screen.findByText("All checked services are available")).toBeInTheDocument();
		expect(screen.getByText("demand_forecast.joblib")).toBeInTheDocument();
		expect(screen.getByText("discount_recommendation.joblib")).toBeInTheDocument();
		expect(screen.getByText("expiry_risk.joblib")).toBeInTheDocument();
		expect(screen.getByText("1.0.0")).toBeInTheDocument();
		expect(screen.getByText("1h 1m 1s")).toBeInTheDocument();
		expect(screen.getByText("No errors detected by the current health checks.")).toBeInTheDocument();
	});

	it("shows only operational service information to a Store Manager", async () => {
		render(<SystemHealth isAdmin={false} onNotify={vi.fn()} />);

		expect(await screen.findByText("All checked services are available")).toBeInTheDocument();
		expect(screen.getByText("MySQL Database")).toBeInTheDocument();
		expect(screen.getByText("Frontend / Backend").parentElement).toHaveTextContent("Connected");
		expect(screen.getByText("Frontend request reached the authenticated API.")).toBeInTheDocument();
		expect(screen.queryByText("Application version")).not.toBeInTheDocument();
		expect(screen.queryByText("Application uptime")).not.toBeInTheDocument();
		expect(screen.queryByRole("region", { name: "System errors" })).not.toBeInTheDocument();
	});

	it("renders degraded status and reports model failure", async () => {
		vi.mocked(systemHealth.loadSystemHealth).mockResolvedValue({
			...healthyResponse,
			status: "degraded",
			ml_models: healthyResponse.ml_models.map((model) => model.name === "expiry_risk"
				? { ...model, status: "unavailable", message: "Model could not be loaded (ValueError)." }
				: model),
			errors: [{ service: "expiry_risk", message: "Model could not be loaded (ValueError)." }],
		});

		render(<SystemHealth isAdmin onNotify={vi.fn()} />);

		expect(await screen.findByText("Some services need attention")).toBeInTheDocument();
		expect(screen.getAllByText("Model could not be loaded (ValueError).")).toHaveLength(2);
	});

	it("shows backend unavailability and supports manual refresh", async () => {
		vi.mocked(systemHealth.loadSystemHealth)
			.mockRejectedValueOnce(new Error("Service unavailable"))
			.mockResolvedValueOnce(healthyResponse);
		const notify = vi.fn();
		render(<SystemHealth isAdmin onNotify={notify} />);

		expect(await screen.findByText("Health check unavailable")).toBeInTheDocument();
		expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
		expect(notify).toHaveBeenCalledWith("Service unavailable");
		fireEvent.click(screen.getByRole("button", { name: "Refresh Health" }));

		await waitFor(() => {
			expect(screen.getByText("All checked services are available")).toBeInTheDocument();
		});
		expect(systemHealth.loadSystemHealth).toHaveBeenCalledTimes(2);
	});
});
