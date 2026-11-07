import { requestAuthenticatedJson } from "./auth";

export type UnitQuantity = { unit: string; quantity: number };
export type DataAvailability = { status: "available" | "unavailable"; message: string; source?: string | null };

export type DashboardSummary = {
	start_date: string;
	end_date: string;
	product_count: number;
	active_product_count: number;
	imported_product_count: number | null;
	user_product_count: number | null;
	imported_catalog: DataAvailability;
	available_inventory: UnitQuantity[];
	active_batch_count: number;
	sales_revenue: number;
	sales_record_count: number;
	currency: string;
	waste_quantity_by_unit: UnitQuantity[];
	waste_cost: number;
	waste_record_count: number;
	expired_batch_count: number;
	expiring_soon_batch_count: number;
	expiry_window_days: number;
	application_expired_batch_count: number;
	application_expiring_soon_batch_count: number;
	snapshot_expired_batch_count: number;
	snapshot_expiring_soon_batch_count: number;
};

export const DASHBOARD_EXPIRY_WINDOW_DAYS = 7;

export type SalesDemandPoint = { date: string; unit: string; quantity: number };
export type PredictedDemandPoint = SalesDemandPoint & { model_versions: string[] };
export type SalesDemand = {
	start_date: string;
	end_date: string;
	prediction_start_date: string | null;
	prediction_end_date: string | null;
	imported_history_status: DataAvailability;
	units: string[];
	actual_sales: SalesDemandPoint[];
	imported_history: SalesDemandPoint[];
	predicted_demand: PredictedDemandPoint[];
	prediction: { status: "available" | "unavailable"; source: string; message: string };
};

export type CategoryDistribution = {
	measure: string;
	total_products: number;
	categories: {
		category: string;
		product_count: number;
		live_stocked_product_count: number;
		product_share_percent: number;
		available_quantity_by_unit: UnitQuantity[];
	}[];
};

export type WasteTrend = {
	start_date: string;
	end_date: string;
	granularity: "day" | "month";
	actual_record_count: number;
	actual: { period: string; unit: string; quantity: number; cost: number | null }[];
	expired_inventory: { period: string; unit: string; quantity: number; cost: number | null }[];
	imported_history: { period: string; unit: string; quantity: number; cost: number | null }[];
	imported_history_status: DataAvailability;
	units: string[];
};

export async function loadWasteTrend(range: DateRange, granularity: "day" | "month" = "month"): Promise<WasteTrend> {
	return requestAuthenticatedJson<WasteTrend>(withQuery("/api/v1/dashboard/waste-trend", {
		...range,
		granularity,
	}));
}

export type ExpiryAlert = {
	source: "application" | "inventory_snapshot";
	batch_id: number;
	product_id: number;
	product_name: string;
	category: string;
	unit: string;
	batch_code: string;
	expiry_date: string;
	expiry_date_source?: "estimated" | "manufacturer_verified" | "manual_verified" | "imported" | null;
	snapshot_date: string | null;
	days_to_expiry: number;
	quantity_remaining: number;
	status: "expired" | "expiring_soon";
	risk: "high" | "medium" | "low";
	ml_risk?: string | null;
	risk_probability?: number | null;
	predicted_class?: number | null;
	rule_status?: string | null;
	recommendation_source?: string | null;
};

export type DashboardRecommendation = {
	source: "application" | "simulated_scenario" | "rule_based";
	recommendation_id: number | null;
	product_id: number;
	batch_id?: number | null;
	product_name: string;
	recommendation_type: string;
	current_price: number | null;
	suggested_price: number | null;
	recommended_quantity: number | null;
	discount_percent: number | null;
	reason: string;
	status: string;
	created_at: string | null;
	estimated_revenue: number | null;
	estimated_gross_margin: number | null;
	estimated_units_sold: number | null;
	product_category: string | null;
	remaining_stock: number | null;
	expiry_days: number | null;
	expiry_risk: string | null;
	expiry_date_source: "estimated" | "manufacturer_verified" | "manual_verified" | "imported" | null;
	priority: string | null;
	recommendation_method: string | null;
	source_information: string | null;
	generated_at: string | null;
	predicted_demand?: number | null;
	expected_impact?: string | null;
	estimated_financial_impact: number | null;
};

export type TopProduct = {
	source: "application" | "training_history";
	product_id: number;
	product_name: string;
	category: string;
	unit: string;
	quantity_sold: number;
	revenue: number | null;
};

export type LowStockProduct = {
	source: "application" | "inventory_snapshot";
	product_id: number;
	product_name: string;
	category: string;
	unit: string;
	current_stock: number;
	reorder_level: number;
	snapshot_date: string | null;
};

export type RecentActivity = {
	activity_id: number;
	action: string;
	entity_type: string;
	entity_id: number | null;
	actor_name: string | null;
	created_at: string;
};

export type DashboardPayload = {
	summary: DashboardSummary;
	salesDemand: SalesDemand;
	categoryDistribution: CategoryDistribution;
	wasteTrend: WasteTrend;
	expiryAlerts: ExpiryAlert[];
	recommendations: DashboardRecommendation[];
	topProducts: TopProduct[];
	lowStock: LowStockProduct[];
	recentActivities: RecentActivity[];
};

export type DashboardHighlights = {
	expiryAlerts: Promise<PromiseSettledResult<ExpiryAlert[]>>;
	recommendations: Promise<PromiseSettledResult<DashboardRecommendation[]>>;
};

export type DateRange = { start_date: string; end_date: string };

function withQuery(path: string, parameters: Record<string, string | number>): string {
	const query = new URLSearchParams(Object.entries(parameters).map(([key, value]) => [key, String(value)]));
	return `${path}?${query.toString()}`;
}

function settleRequest<T>(request: Promise<T>): Promise<PromiseSettledResult<T>> {
	return request.then(
		(value): PromiseFulfilledResult<T> => ({ status: "fulfilled", value }),
		(reason: unknown): PromiseRejectedResult => ({ status: "rejected", reason }),
	);
}

export async function loadDashboardData(salesRange: DateRange, wasteRange: DateRange): Promise<DashboardPayload> {
	const wasteStart = Date.parse(`${wasteRange.start_date}T00:00:00Z`);
	const wasteEnd = Date.parse(`${wasteRange.end_date}T00:00:00Z`);
	const wasteGranularity = Number.isFinite(wasteStart) && Number.isFinite(wasteEnd) && wasteEnd - wasteStart < 7 * 24 * 60 * 60 * 1000
		? "day"
		: "month";
	const [summary, salesDemand, categoryDistribution, wasteTrend, topProducts, lowStock, recentActivities] = await Promise.all([
		requestAuthenticatedJson<DashboardSummary>(withQuery("/api/v1/dashboard/summary", {
			...salesRange,
			within_days: DASHBOARD_EXPIRY_WINDOW_DAYS,
		})),
		requestAuthenticatedJson<SalesDemand>(withQuery("/api/v1/dashboard/sales-demand", { ...salesRange, prediction_days: 30 })),
		requestAuthenticatedJson<CategoryDistribution>("/api/v1/dashboard/category-distribution"),
		requestAuthenticatedJson<WasteTrend>(withQuery("/api/v1/dashboard/waste-trend", { ...wasteRange, granularity: wasteGranularity })),
		requestAuthenticatedJson<TopProduct[]>(withQuery("/api/v1/dashboard/top-products", { ...salesRange, limit: 5 })),
		requestAuthenticatedJson<LowStockProduct[]>("/api/v1/dashboard/low-stock?reorder_level=10&limit=5"),
		requestAuthenticatedJson<RecentActivity[]>("/api/v1/dashboard/recent-activities?limit=5"),
	]);
	return { summary, salesDemand, categoryDistribution, wasteTrend, expiryAlerts: [], recommendations: [], topProducts, lowStock, recentActivities };
}

export function loadDashboardHighlights(): DashboardHighlights {
	return {
		expiryAlerts: settleRequest(requestAuthenticatedJson<ExpiryAlert[]>(
			`/api/v1/dashboard/expiry-alerts?within_days=${DASHBOARD_EXPIRY_WINDOW_DAYS}&limit=10`,
		)),
		recommendations: settleRequest(
			requestAuthenticatedJson<DashboardRecommendation[]>("/api/v1/dashboard/recommendations?limit=5"),
		),
	};
}

export async function listDashboardRecommendations(limit = 100): Promise<DashboardRecommendation[]> {
	return requestAuthenticatedJson<DashboardRecommendation[]>(`/api/v1/dashboard/recommendations?limit=${limit}`);
}

export async function listDashboardExpiryAlerts(limit = 500): Promise<ExpiryAlert[]> {
	return requestAuthenticatedJson<ExpiryAlert[]>(
		`/api/v1/dashboard/expiry-alerts?within_days=${DASHBOARD_EXPIRY_WINDOW_DAYS}&limit=${limit}`,
	);
}

export async function applyRuleRecommendation(payload: { product_id: number; batch_id?: number; recommendation_type?: string; discount_percent?: number; recommended_quantity?: number }): Promise<{ recommendation_id: number; status: string }> {
	return requestAuthenticatedJson<{ recommendation_id: number; status: string }>(
		"/api/v1/recommendations/apply-generated",
		{ method: "POST", body: JSON.stringify(payload) },
	);
}

export async function recordRecommendationPurchase(recommendationId: number): Promise<{ recommendation_id: number; status: string }> {
	return requestAuthenticatedJson<{ recommendation_id: number; status: string }>(
		`/api/v1/recommendations/${recommendationId}/record-purchase`,
		{ method: "POST" },
	);
}

export async function receiveRecommendationStock(recommendationId: number, payload: {
	batch_code: string; quantity_received: number; unit_cost?: number; received_at: string;
	expiry_date?: string; expiry_date_source?: "estimated" | "manufacturer_verified" | "manual_verified" | "imported";
	location?: string; supplier?: string | null;
}): Promise<{ recommendation_id: number; status: string; batch_id: number }> {
	return requestAuthenticatedJson<{ recommendation_id: number; status: string; batch_id: number }>(
		`/api/v1/recommendations/${recommendationId}/receive`,
		{ method: "POST", body: JSON.stringify(payload) },
	);
}

export async function markRecommendationApplied(recommendationId: number): Promise<void> {
	await requestAuthenticatedJson<{ recommendation_id: number; status: string }>(
		`/api/v1/recommendations/${recommendationId}`,
		{ method: "PATCH", body: JSON.stringify({ status: "approved" }) },
	);
}
