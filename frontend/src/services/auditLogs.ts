import { requestAuthenticatedJson } from "./auth";

export type AuditStatus = "successful" | "failed" | "unknown";

export type AuditLogEntry = {
	activity_id: number;
	user_id: number | null;
	actor_name: string;
	actor_role?: string;
	action: string;
	entity_type: string;
	entity_id: number | null;
	affected_record?: string;
	created_at: string;
	status: AuditStatus;
	details: Record<string, unknown>;
};

export type AuditLogPage = {
	items: AuditLogEntry[];
	total: number;
	page: number;
	page_size: number;
	total_pages: number;
	timezone: string;
};

export type AuditLogFilters = {
	actions: string[];
	actors: { user_id: number; full_name: string }[];
	has_unknown_actor: boolean;
	timezone: string;
};

export type AuditLogQuery = {
	action?: string;
	user_id?: number;
	unknown_actor?: boolean;
	start_date?: string;
	end_date?: string;
	search?: string;
	status?: AuditStatus;
	sort_by?: "timestamp" | "action" | "actor" | "affected_record" | "status";
	sort_order?: "asc" | "desc";
	page: number;
	page_size: number;
};

export function canViewAuditLogs(role: string): boolean {
	return role === "admin" || role === "store_manager";
}

function queryString(values: AuditLogQuery): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined && value !== "") params.set(key, String(value));
	}
	return params.toString();
}

export function loadAuditLogFilters(): Promise<AuditLogFilters> {
	return requestAuthenticatedJson<AuditLogFilters>("/api/v1/audit-logs/filters");
}

export function loadAuditLogs(query: AuditLogQuery): Promise<AuditLogPage> {
	return requestAuthenticatedJson<AuditLogPage>(
		`/api/v1/audit-logs?${queryString(query)}`,
	);
}
