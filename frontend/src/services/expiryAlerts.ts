import { requestAuthenticatedBlob, requestAuthenticatedJson } from "./auth";

export type ExpiryRisk = "expired" | "high" | "medium" | "low" | "safe";

export type ExpiryAlert = {
  batch_id: number;
  product_id: number;
  product_name: string;
  sku: string;
  category: string;
  batch_code: string;
  expiry_date: string;
  expiry_date_source?: "estimated" | "manufacturer_verified" | "manual_verified" | "imported" | null;
  received_at: string;
  days_to_expiry: number;
  quantity_remaining: number;
  unit: string;
  status: "active" | "expired";
  risk: ExpiryRisk;
  suggested_action: string;
  location: string;
  supplier: string;
};

export type ExpiryAlertSummary = {
  total_batches: number;
  expired: number;
  high: number;
  medium: number;
  low: number;
  safe: number;
  risk_counts: Record<ExpiryRisk, number>;
};

export type ExpiryAlertPage = {
  items: ExpiryAlert[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  summary: ExpiryAlertSummary;
};

export type ExpiryAlertFilters = {
  categories: string[];
  locations: string[];
  suppliers: string[];
};

export type ExpiryAlertCharts = {
  risk_distribution: { risk: ExpiryRisk; count: number }[];
  expiring_next_14_days: { range: "0-3" | "4-7" | "8-14"; count: number }[];
  top_categories: { category: string; count: number }[];
};

export type ExpiryAlertRule = {
  rule_id: number;
  name: string;
  days_before_expiry: number;
  risk_level: ExpiryRisk | null;
  category: string | null;
  location: string | null;
  supplier: string | null;
  enabled: boolean;
  created_by: number;
  created_at: string;
  updated_at: string;
};

export type ExpiryAlertRuleInput = {
  name: string;
  days_before_expiry: number;
  risk_level: ExpiryRisk | null;
  category: string | null;
  location: string | null;
  supplier: string | null;
  enabled: boolean;
};

export type ExpiryAlertQuery = {
  search?: string;
  category?: string;
  risk?: ExpiryRisk;
  location?: string;
  supplier?: string;
  page?: number;
  page_size?: number;
};

function queryString(params: ExpiryAlertQuery, includePagination = true): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (!includePagination && (key === "page" || key === "page_size")) continue;
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  return query.toString();
}

export function listExpiryAlerts(params: ExpiryAlertQuery): Promise<ExpiryAlertPage> {
  const query = queryString(params);
  return requestAuthenticatedJson<ExpiryAlertPage>(
    `/api/v1/expiry-alerts${query ? `?${query}` : ""}`,
  );
}

export function getExpiryAlertFilters(): Promise<ExpiryAlertFilters> {
  return requestAuthenticatedJson<ExpiryAlertFilters>("/api/v1/expiry-alerts/filters");
}

export function getExpiryAlertCharts(params: Omit<ExpiryAlertQuery, "page" | "page_size">): Promise<ExpiryAlertCharts> {
  const query = queryString(params, false);
  return requestAuthenticatedJson<ExpiryAlertCharts>(
    `/api/v1/expiry-alerts/charts${query ? `?${query}` : ""}`,
  );
}

export function getExpiryAlertBatch(batchId: number): Promise<ExpiryAlert> {
  return requestAuthenticatedJson<ExpiryAlert>(`/api/v1/expiry-alerts/batches/${batchId}`);
}

export function listExpiryAlertRules(): Promise<ExpiryAlertRule[]> {
  return requestAuthenticatedJson<ExpiryAlertRule[]>("/api/v1/expiry-alerts/rules");
}

export function createExpiryAlertRule(payload: ExpiryAlertRuleInput): Promise<ExpiryAlertRule> {
  return requestAuthenticatedJson<ExpiryAlertRule>("/api/v1/expiry-alerts/rules", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateExpiryAlertRule(
  ruleId: number,
  payload: Partial<ExpiryAlertRuleInput>,
): Promise<ExpiryAlertRule> {
  return requestAuthenticatedJson<ExpiryAlertRule>(`/api/v1/expiry-alerts/rules/${ruleId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteExpiryAlertRule(ruleId: number): Promise<void> {
  return requestAuthenticatedJson<void>(`/api/v1/expiry-alerts/rules/${ruleId}`, {
    method: "DELETE",
  });
}

export async function exportExpiryAlerts(
  params: ExpiryAlertQuery,
  format: "csv" | "xlsx",
  selectedBatchIds: number[] = [],
): Promise<Blob> {
  const query = new URLSearchParams(queryString(params, false));
  query.set("format", format);
  selectedBatchIds.forEach((batchId) => query.append("batch_ids", String(batchId)));
  return requestAuthenticatedBlob(`/api/v1/expiry-alerts/export?${query.toString()}`);
}
