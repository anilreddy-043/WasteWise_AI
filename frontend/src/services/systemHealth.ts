import { requestAuthenticatedJson } from "./auth";

export type HealthState = "available" | "unavailable";
export type BrowserConnectionState = "connected" | "unavailable";
export type SystemHealthStatus = "healthy" | "degraded";

export type SystemHealthModel = {
	name: string;
	artifact: string;
	status: HealthState;
	message?: string;
};

export type SystemHealthResponse = {
	status: SystemHealthStatus;
	checked_at: string;
	last_successful_check: string | null;
	api: { status: HealthState };
	frontend_backend: { status: BrowserConnectionState; message?: string };
	database: { status: HealthState; message?: string };
	ml_models: SystemHealthModel[];
	app_version?: string;
	uptime_seconds?: number;
	errors?: { service: string; message: string }[];
};

export function canViewSystemHealth(role: string): boolean {
	return role === "admin" || role === "store_manager";
}

export function loadSystemHealth(): Promise<SystemHealthResponse> {
	return requestAuthenticatedJson<SystemHealthResponse>("/api/v1/system-health");
}
