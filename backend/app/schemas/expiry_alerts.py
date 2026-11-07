from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ExpiryRisk = Literal["expired", "high", "medium", "low", "safe"]
ExpiryDateSource = Literal["estimated", "manufacturer_verified", "manual_verified", "imported"]


class ExpiryAlertItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    batch_id: int
    product_id: int
    product_name: str
    sku: str
    category: str
    batch_code: str
    expiry_date: date
    expiry_date_source: ExpiryDateSource | None = None
    received_at: date
    days_to_expiry: int
    quantity_remaining: float
    unit: str
    status: Literal["active", "expired"]
    risk: ExpiryRisk
    suggested_action: str
    location: str
    supplier: str


class ExpiryAlertSummary(BaseModel):
    total_batches: int
    expired: int
    high: int
    medium: int
    low: int
    safe: int
    risk_counts: dict[str, int]


class ExpiryAlertPage(BaseModel):
    items: list[ExpiryAlertItem]
    total: int
    page: int
    page_size: int
    total_pages: int
    summary: ExpiryAlertSummary


class ExpiryAlertRuleCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    days_before_expiry: int = Field(default=3, ge=0, le=365)
    risk_level: ExpiryRisk | None = None
    category: str | None = Field(default=None, max_length=80)
    location: str | None = Field(default=None, max_length=120)
    supplier: str | None = Field(default=None, max_length=160)
    enabled: bool = True


class ExpiryAlertRuleUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    days_before_expiry: int | None = Field(default=None, ge=0, le=365)
    risk_level: ExpiryRisk | None = None
    category: str | None = Field(default=None, max_length=80)
    location: str | None = Field(default=None, max_length=120)
    supplier: str | None = Field(default=None, max_length=160)
    enabled: bool | None = None


class ExpiryAlertRule(BaseModel):
    rule_id: int
    name: str
    days_before_expiry: int
    risk_level: ExpiryRisk | None
    category: str | None
    location: str | None
    supplier: str | None
    enabled: bool
    created_by: int
    created_at: datetime
    updated_at: datetime
