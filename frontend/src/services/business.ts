import { requestAuthenticatedBlob, requestAuthenticatedJson } from "./auth";
import type { GeneralSettings } from "./generalSettings";

export type ProductRecord = {
  product_id: number;
  name: string;
  category: string;
  sku: string;
  unit: string;
  price: number;
  supplier: string;
  image_url?: string | null;
  created_at: string;
  updated_at: string;
};

export type InventorySummaryRecord = {
  product_id: number;
  product_name: string;
  category: string;
  sku: string;
  unit: string;
  price: number;
  supplier: string;
  quantity: number;
  inventory_value: number;
  active_batch_count: number;
  source: "actual";
};

export type InventoryBatchRecord = {
  batch_id: number;
  product_id: number;
  batch_code: string;
  quantity_received: number;
  quantity_remaining: number;
  unit_cost: number;
  received_at: string;
  expiry_date: string;
  expiry_date_source?: ExpiryDateSource | null;
  status: string;
  location: string;
  supplier: string | null;
};

export type ExpiryDateSource = "estimated" | "manufacturer_verified" | "manual_verified" | "imported";

export type SaleRecord = {
  sale_id: number;
  product_id: number;
  batch_id: number | null;
  sold_at: string;
  quantity: number | string;
  unit_price: number | string;
  total_amount: number | string;
  source: string;
};

export type CheckoutAllocation = {
  allocation_id: number;
  batch_id: number;
  product_id: number;
  quantity_allocated: number;
};

export type CheckoutTransactionItem = {
  sale_item_id: number;
  product_id: number;
  quantity: number | string;
  unit_price: number | string;
  line_subtotal: number | string;
  discount_amount: number | string;
  line_total: number | string;
  allocations: CheckoutAllocation[];
};

export type CheckoutTransaction = {
  sale_transaction_id: number;
  transaction_number: string;
  subtotal: number | string;
  discount_type: "percentage" | "amount" | "none";
  discount_value: number | string;
  discount_amount: number | string;
  total_amount: number | string;
  payment_method: "cash" | "upi" | "card";
  customer_name?: string | null;
  customer_phone?: string | null;
  sold_at: string;
  processed_by: number;
  status: string;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
  items: CheckoutTransactionItem[];
};

export type CheckoutRequest = {
  items: Array<{ product_id: number; quantity: number }>;
  discount: { type: "percentage" | "amount" | "none"; value: number };
  payment_method: "cash" | "upi" | "card";
  customer_name?: string | null;
  customer_phone?: string | null;
  idempotency_key: string;
};

export function checkoutSale(payload: CheckoutRequest): Promise<CheckoutTransaction> {
  return requestAuthenticatedJson("/api/v1/sales/checkout", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export type WasteRecord = {
  waste_id: number;
  product_id: number;
  batch_id: number | null;
  quantity: number | string;
  reason: string;
  waste_cost: number | string;
  recorded_at: string;
  notes: string | null;
};

export type ForecastRecord = {
  forecast_id: number;
  product_id: number;
  forecast_date: string;
  predicted_demand: number;
  lower_bound: number | null;
  upper_bound: number | null;
  model_version: string;
  created_at: string;
};

export type RecommendationRecord = {
  recommendation_id: number;
  product_id: number;
  batch_id: number | null;
  recommendation_type: string;
  recommended_quantity: number | null;
  discount_percent: number | null;
  reason: string;
  status: string;
  created_at: string;
  updated_at: string;
  applied_by: number | null;
};

export type ModelMetricRecord = {
  metric_id: number;
  model_name: string;
  model_version: string;
  evaluated_at: string;
  mae: number | null;
  rmse: number | null;
  r2_score: number | null;
  sample_size: number;
  metrics_json: Record<string, unknown> | null;
  source: string;
};

export type ProductInput = Omit<ProductRecord, "product_id" | "created_at" | "updated_at">;
export type ProductSkuSuggestionRecord = {
  category: string;
  prefix: string;
  sku: string;
};
export type BatchInput = {
  product_id: number;
  batch_code: string;
  quantity_received: number;
  quantity_remaining?: number;
  unit_cost?: number;
  received_at: string;
  expiry_date?: string;
  expiry_date_source?: ExpiryDateSource | null;
  location: string;
  supplier?: string | null;
};

export type ShelfLifeSettingRecord = {
  category: string;
  days: number;
  updated_at: string | null;
};

export type StoreInformationRecord = {
  store_id: number | null;
  store_name: string;
  store_address: string;
  contact_number: string;
  email: string;
  logo_path: string | null;
  logo_url: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type NotificationSettingsRecord = {
  expiry_alerts: boolean;
  low_stock_alerts: boolean;
  high_demand_alerts: boolean;
  daily_reports: boolean;
  weekly_insights: boolean;
  system_notifications: boolean;
};

export type ExpirySuggestionRecord = {
  product_id: number;
  category: string;
  received_at: string;
  default_shelf_life_days: number | null;
  expiry_date: string | null;
};

export type BatchImportResult = {
  inserted: number;
  import_id: string;
  products_created: number;
  batches: InventoryBatchRecord[];
};

export type BatchImportRow = {
  row_number: number;
  values: Record<string, string>;
  errors: string[];
  product_status: string;
  matched_product: { product_id: number; name: string; sku: string } | null;
  can_create_product: boolean;
};

export type BatchImportPreview = {
  row_count: number;
  valid_count: number;
  invalid_count: number;
  missing_product_count: number;
  rows: BatchImportRow[];
};

export type BatchImportHistoryRecord = {
  import_id: string;
  row_count: number;
  inserted: number;
  products_created: number;
  created_at: string;
  created_by: number | null;
};

export function listProducts(): Promise<ProductRecord[]> {
  return requestAuthenticatedJson("/api/v1/products?limit=500");
}

export function uploadProductImage(productId: number, image: File): Promise<{ image_url: string }> {
  return requestAuthenticatedJson(`/api/v1/products/${productId}/image`, {
    method: "POST",
    body: image,
    headers: { "Content-Type": image.type },
  });
}

export function deleteProductImage(productId: number): Promise<void> {
  return requestAuthenticatedJson(`/api/v1/products/${productId}/image`, { method: "DELETE" });
}

export function suggestProductSku(category: string): Promise<ProductSkuSuggestionRecord> {
  return requestAuthenticatedJson(
    `/api/v1/products/sku-suggestion?category=${encodeURIComponent(category)}`,
  );
}

export function createProduct(payload: ProductInput): Promise<ProductRecord> {
  return requestAuthenticatedJson("/api/v1/products", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateProduct(productId: number, payload: ProductInput): Promise<ProductRecord> {
  return requestAuthenticatedJson(`/api/v1/products/${productId}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteProduct(productId: number): Promise<void> {
  return requestAuthenticatedJson(`/api/v1/products/${productId}`, { method: "DELETE" });
}

export function listInventorySummary(): Promise<InventorySummaryRecord[]> {
  return requestAuthenticatedJson("/api/v1/inventory/summary");
}

export function listBatches(): Promise<InventoryBatchRecord[]> {
  return requestAuthenticatedJson("/api/v1/inventory/batches?limit=500");
}

export function listShelfLifeSettings(): Promise<ShelfLifeSettingRecord[]> {
  return requestAuthenticatedJson("/api/v1/inventory/shelf-life");
}

export function updateShelfLifeSetting(category: string, days: number): Promise<ShelfLifeSettingRecord> {
  return requestAuthenticatedJson(`/api/v1/inventory/shelf-life/${encodeURIComponent(category)}`, {
    method: "PUT",
    body: JSON.stringify({ days }),
  });
}

export function getExpirySuggestion(productId: number, receivedAt: string): Promise<ExpirySuggestionRecord> {
  const query = new URLSearchParams({ received_at: receivedAt });
  return requestAuthenticatedJson(`/api/v1/products/${productId}/expiry-suggestion?${query.toString()}`);
}

export function previewInventoryBatchImport(csvText: string): Promise<BatchImportPreview> {
  return requestAuthenticatedJson("/api/v1/inventory/batches/import/preview", {
    method: "POST",
    body: JSON.stringify({ csv_text: csvText }),
  });
}

export function confirmInventoryBatchImport(
  csvText: string,
  importId: string,
  createMissingProducts: boolean,
): Promise<BatchImportResult> {
  return requestAuthenticatedJson("/api/v1/inventory/batches/import/confirm", {
    method: "POST",
    body: JSON.stringify({
      csv_text: csvText,
      import_id: importId,
      create_missing_products: createMissingProducts,
    }),
  });
}

export function listInventoryBatchImports(): Promise<BatchImportHistoryRecord[]> {
  return requestAuthenticatedJson("/api/v1/inventory/batches/imports");
}

export function createBatch(payload: BatchInput): Promise<InventoryBatchRecord> {
  return requestAuthenticatedJson("/api/v1/inventory/batches", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateBatch(
  batchId: number,
  payload: Partial<Omit<BatchInput, "product_id">>,
): Promise<InventoryBatchRecord> {
  return requestAuthenticatedJson(`/api/v1/inventory/batches/${batchId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteBatch(batchId: number): Promise<void> {
  return requestAuthenticatedJson(`/api/v1/inventory/batches/${batchId}`, { method: "DELETE" });
}

export function listSales(): Promise<SaleRecord[]> {
  return requestAuthenticatedJson("/api/v1/sales?limit=500");
}

export function listSalesTransactions(): Promise<CheckoutTransaction[]> {
  return requestAuthenticatedJson("/api/v1/sales/transactions?limit=500");
}

export type ExpiryRiskPrediction = {
  batch_id: number; product_id: number; product_name: string; category: string;
  batch_code: string; expiry_date: string; expiry_date_source: "estimated" | "manufacturer_verified" | "manual_verified" | "imported" | null;
  days_to_expiry: number; quantity_remaining: number;
  predicted_class: number; risk_probability: number; ml_risk: string; rule_status: string;
  recommendation_source: string; location: string; supplier: string | null; model_version: string;
};

export function predictExpiryRisk(batchIds?: number[]): Promise<ExpiryRiskPrediction[]> {
  return requestAuthenticatedJson("/api/v1/risk/expiry/predict", {
    method: "POST",
    body: JSON.stringify({ batch_ids: batchIds }),
  });
}

export function listWaste(): Promise<WasteRecord[]> {
  return requestAuthenticatedJson("/api/v1/waste?limit=500");
}

export function createWaste(payload: Omit<WasteRecord, "waste_id" | "recorded_at">): Promise<WasteRecord> {
  return requestAuthenticatedJson("/api/v1/waste", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function generateForecasts(startDate: string, horizonDays: number, productIds?: number[]): Promise<ForecastRecord[]> {
  return requestAuthenticatedJson("/api/v1/forecasts/generate", {
    method: "POST",
    body: JSON.stringify({ start_date: startDate, horizon_days: horizonDays, product_ids: productIds }),
  });
}

export function listForecasts(productId?: number): Promise<ForecastRecord[]> {
  const query = new URLSearchParams({ limit: "500" });
  if (productId !== undefined) query.set("product_id", String(productId));
  return requestAuthenticatedJson(`/api/v1/forecasts?${query.toString()}`);
}

export function listRecommendations(): Promise<RecommendationRecord[]> {
  return requestAuthenticatedJson("/api/v1/recommendations?limit=500");
}

export function updateRecommendation(
  recommendationId: number,
  status: "applied" | "dismissed",
): Promise<{ recommendation_id: number; status: string }> {
  return requestAuthenticatedJson(`/api/v1/recommendations/${recommendationId}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export function listModelMetrics(modelName?: string): Promise<ModelMetricRecord[]> {
  const query = new URLSearchParams({ limit: "500" });
  if (modelName) query.set("model_name", modelName);
  return requestAuthenticatedJson(`/api/v1/model-metrics?${query.toString()}`);
}

export function getModelRegistry(): Promise<{ active_models: Record<string, unknown> }> {
  return requestAuthenticatedJson("/api/v1/models/registry");
}

export function getMySettings(): Promise<{
  user_id: number;
  full_name: string;
  email: string;
  role: string;
}> {
  return requestAuthenticatedJson("/api/v1/settings/me");
}

export function getGeneralSettings(): Promise<GeneralSettings> {
  return requestAuthenticatedJson("/api/v1/settings/me/general");
}

export function updateGeneralSettings(settings: GeneralSettings): Promise<GeneralSettings> {
  return requestAuthenticatedJson("/api/v1/settings/me/general", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export function getNotificationSettings(): Promise<NotificationSettingsRecord> {
  return requestAuthenticatedJson("/api/v1/settings/me/notifications");
}

export function updateNotificationSettings(
  settings: NotificationSettingsRecord,
): Promise<NotificationSettingsRecord> {
  return requestAuthenticatedJson("/api/v1/settings/me/notifications", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export function getStoreInformation(): Promise<StoreInformationRecord> {
  return requestAuthenticatedJson("/api/v1/settings/store");
}

export function getStoreLogoImage(url: string): Promise<Blob> {
  if (!/^\/api\/v1\/settings\/store\/logo(?:\?v=\d+)?$/.test(url)) {
    return Promise.reject(new Error("Store logo URL is invalid."));
  }
  return requestAuthenticatedBlob(url);
}

export function updateStoreInformation(payload: {
  store_name: string;
  store_address: string;
  contact_number: string;
  email: string;
}): Promise<StoreInformationRecord> {
  return requestAuthenticatedJson("/api/v1/settings/store", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function uploadStoreLogo(file: File): Promise<StoreInformationRecord> {
  const formData = new FormData();
  formData.append("file", file);
  return requestAuthenticatedJson("/api/v1/settings/store/logo", {
    method: "POST",
    headers: { Accept: "application/json" },
    body: formData,
  });
}
