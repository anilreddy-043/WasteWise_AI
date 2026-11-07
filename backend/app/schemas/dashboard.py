from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel


class UnitQuantity(BaseModel):
    unit: str
    quantity: float


class DataAvailability(BaseModel):
    status: Literal["available", "unavailable"]
    message: str
    source: str | None = None


class DashboardSummary(BaseModel):
    start_date: date
    end_date: date
    product_count: int
    active_product_count: int
    imported_product_count: int | None
    user_product_count: int | None
    imported_catalog: DataAvailability
    available_inventory: list[UnitQuantity]
    active_batch_count: int
    sales_revenue: float
    sales_record_count: int
    currency: str
    waste_quantity_by_unit: list[UnitQuantity]
    waste_cost: float
    waste_record_count: int
    expired_batch_count: int
    expiring_soon_batch_count: int
    expiry_window_days: int
    application_expired_batch_count: int
    application_expiring_soon_batch_count: int
    snapshot_expired_batch_count: int
    snapshot_expiring_soon_batch_count: int


class SalesDemandPoint(BaseModel):
    date: date
    unit: str
    quantity: float


class PredictedDemandPoint(SalesDemandPoint):
    model_versions: list[str]


class PredictionMetadata(BaseModel):
    status: Literal["available", "unavailable"]
    source: str
    message: str


class SalesDemandResponse(BaseModel):
    start_date: date
    end_date: date
    prediction_start_date: date | None
    prediction_end_date: date | None
    units: list[str]
    actual_sales: list[SalesDemandPoint]
    imported_history: list[SalesDemandPoint]
    imported_history_status: DataAvailability
    predicted_demand: list[PredictedDemandPoint]
    prediction: PredictionMetadata


class CategoryDistributionItem(BaseModel):
    category: str
    product_count: int
    live_stocked_product_count: int
    product_share_percent: float
    available_quantity_by_unit: list[UnitQuantity]


class CategoryDistributionResponse(BaseModel):
    measure: str
    total_products: int
    categories: list[CategoryDistributionItem]


class WasteTrendPoint(BaseModel):
    period: date
    unit: str
    quantity: float
    cost: float | None = None


class WasteTrendResponse(BaseModel):
    start_date: date
    end_date: date
    granularity: Literal["day", "month"]
    actual_record_count: int
    actual: list[WasteTrendPoint]
    expired_inventory: list[WasteTrendPoint]
    imported_history: list[WasteTrendPoint]
    imported_history_status: DataAvailability
    units: list[str]


class ExpiryAlert(BaseModel):
    source: Literal["application", "inventory_snapshot"]
    batch_id: int
    product_id: int
    product_name: str
    category: str
    unit: str
    batch_code: str
    expiry_date: date
    expiry_date_source: str | None = None
    snapshot_date: date | None
    days_to_expiry: int
    quantity_remaining: float
    status: Literal["expired", "expiring_soon"]
    risk: Literal["high", "medium", "low"]
    ml_risk: str | None = None
    risk_probability: float | None = None
    predicted_class: int | None = None
    rule_status: str | None = None
    recommendation_source: str | None = None


class DashboardRecommendation(BaseModel):
    source: Literal["application", "simulated_scenario", "rule_based"]
    recommendation_id: int | None
    product_id: int
    batch_id: int | None = None
    product_name: str
    product_category: str | None = None
    recommendation_type: str
    current_price: float | None
    suggested_price: float | None
    recommended_quantity: float | None
    discount_percent: float | None
    remaining_stock: float | None = None
    expiry_days: int | None = None
    expiry_risk: str | None = None
    expiry_date_source: str | None = None
    predicted_demand: float | None = None
    expected_impact: str | None = None
    priority: str | None = None
    recommendation_method: str | None = None
    source_information: str | None = None
    generated_at: datetime | None = None
    reason: str
    status: str
    created_at: datetime | None
    estimated_revenue: float | None = None
    estimated_gross_margin: float | None = None
    estimated_units_sold: float | None = None
    estimated_financial_impact: float | None = None


class TopProduct(BaseModel):
    source: Literal["application", "training_history"]
    product_id: int
    product_name: str
    category: str
    unit: str
    quantity_sold: float
    revenue: float | None


class LowStockProduct(BaseModel):
    source: Literal["application", "inventory_snapshot"]
    product_id: int
    product_name: str
    category: str
    unit: str
    current_stock: float
    reorder_level: float
    snapshot_date: date | None


class RecentActivity(BaseModel):
    activity_id: int
    action: str
    entity_type: str
    entity_id: int | None
    actor_name: str | None
    created_at: datetime