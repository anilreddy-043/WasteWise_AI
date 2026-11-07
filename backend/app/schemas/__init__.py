from datetime import date, datetime
from decimal import Decimal
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, EmailStr, Field, computed_field, field_validator, model_validator

ExpiryDateSource = Literal["estimated", "manufacturer_verified", "manual_verified", "imported"]


class RegisterRequest(BaseModel):
    full_name: str = Field(min_length=1, max_length=120)
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    role: Literal["Store Manager", "Staff", "Viewer"]
    accepted_terms: bool = False

    @field_validator("full_name")
    @classmethod
    def trim_full_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Full name cannot be empty.")
        return value

    @field_validator("password")
    @classmethod
    def validate_password_strength(cls, value: str) -> str:
        if (
            not any(character.isalpha() for character in value)
            or not any(character.isdigit() for character in value)
            or not any(not character.isalnum() for character in value)
        ):
            raise ValueError("Password must contain a letter, a number, and a special character.")
        return value

    @model_validator(mode="after")
    def require_terms_consent(self) -> "RegisterRequest":
        if not self.accepted_terms:
            raise ValueError("Terms of Service and Privacy Policy consent is required.")
        return self


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class PasswordChangeRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)

    @field_validator("new_password")
    @classmethod
    def validate_new_password_strength(cls, value: str) -> str:
        if (
            not any(character.isalpha() for character in value)
            or not any(character.isdigit() for character in value)
            or not any(not character.isalnum() for character in value)
        ):
            raise ValueError("Password must contain a letter, a number, and a special character.")
        return value


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    user_id: int
    full_name: str
    email: str
    role: str
    is_active: bool


class UserActiveRequest(BaseModel):
    is_active: bool


class UserRoleUpdate(BaseModel):
    role: Literal["admin", "store_manager", "staff", "viewer"]


class GeneralSettingsUpdate(BaseModel):
    application_name: str = Field(min_length=1, max_length=120)
    timezone: str = Field(min_length=1, max_length=64)
    date_format: Literal["DD MMM YYYY", "MM/DD/YYYY", "YYYY-MM-DD"]
    language: Literal["en", "hi", "te", "mr"]
    items_per_page: Literal[10, 20, 50, 100]

    @field_validator("application_name")
    @classmethod
    def trim_application_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Application name cannot be empty.")
        return value

    @field_validator("timezone")
    @classmethod
    def validate_timezone(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Timezone cannot be empty.")
        try:
            ZoneInfo(value)
        except (ValueError, ZoneInfoNotFoundError) as exc:
            raise ValueError("Timezone must be a valid IANA timezone.") from exc
        return value


class GeneralSettingsResponse(GeneralSettingsUpdate):
    model_config = ConfigDict(from_attributes=True)


class NotificationSettingsUpdate(BaseModel):
    expiry_alerts: bool
    low_stock_alerts: bool
    high_demand_alerts: bool
    daily_reports: bool
    weekly_insights: bool
    system_notifications: bool


class NotificationSettingsResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    expiry_alerts: bool = True
    low_stock_alerts: bool = True
    high_demand_alerts: bool = True
    daily_reports: bool = False
    weekly_insights: bool = True
    system_notifications: bool = True


class StoreInformationUpdate(BaseModel):
    store_name: str = Field(min_length=1, max_length=160)
    store_address: str = Field(min_length=1, max_length=255)
    contact_number: str = Field(min_length=7, max_length=32)
    email: EmailStr

    @field_validator("store_name", "store_address", "contact_number")
    @classmethod
    def trim_store_fields(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be empty.")
        return value

    @field_validator("contact_number")
    @classmethod
    def validate_contact_number(cls, value: str) -> str:
        cleaned = value.strip()
        if len(cleaned) < 7 or len(cleaned) > 32:
            raise ValueError("Contact number must contain 7 to 32 characters.")
        if not any(character.isdigit() for character in cleaned):
            raise ValueError("Contact number must include at least one digit.")
        if not all(character.isdigit() or character in "+()- ." for character in cleaned):
            raise ValueError("Contact number contains unsupported characters.")
        return cleaned


class StoreInformationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    store_id: int | None = None
    store_name: str
    store_address: str
    contact_number: str
    email: str
    logo_path: str | None = None
    logo_url: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class ProductCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    category: str = Field(min_length=1, max_length=80)
    sku: str = Field(min_length=1, max_length=64)
    unit: str = Field(min_length=1, max_length=32)
    price: Decimal = Field(ge=0)
    supplier: str = Field(min_length=1, max_length=160)

    @field_validator("name", "category", "sku", "unit", "supplier")
    @classmethod
    def trim_required_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be empty.")
        return value


class ProductResponse(ProductCreate):
    model_config = ConfigDict(from_attributes=True)

    product_id: int
    created_at: datetime
    updated_at: datetime

    @computed_field
    @property
    def image_url(self) -> str | None:
        from app.services.product_images import product_image_url

        return product_image_url(self.product_id)


class ProductUpdate(ProductCreate):
    pass


class ProductSkuSuggestion(BaseModel):
    category: str
    prefix: str
    sku: str


class BatchCreate(BaseModel):
    product_id: int = Field(gt=0)
    batch_code: str = Field(min_length=1, max_length=64)
    quantity_received: Decimal = Field(gt=0)
    quantity_remaining: Decimal | None = Field(default=None, ge=0)
    unit_cost: Decimal = Field(default=Decimal("0"), ge=0)
    received_at: date
    expiry_date: date | None = None
    expiry_date_source: ExpiryDateSource | None = None
    location: str = Field(default="Unassigned", min_length=1, max_length=120)
    supplier: str | None = Field(default=None, max_length=160)

    @field_validator("batch_code", "location")
    @classmethod
    def trim_batch_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be empty.")
        return value

    @field_validator("supplier")
    @classmethod
    def trim_optional_supplier(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        return value or None

    @model_validator(mode="after")
    def validate_batch(self) -> "BatchCreate":
        if (
            self.expiry_date is not None
            and self.expiry_date < self.received_at
            and self.expiry_date_source != "estimated"
        ):
            raise ValueError("Expiry date cannot be before received date.")
        if self.quantity_remaining is not None and self.quantity_remaining > self.quantity_received:
            raise ValueError("Remaining quantity cannot exceed received quantity.")
        return self


class BatchUpdate(BaseModel):
    batch_code: str | None = Field(default=None, min_length=1, max_length=64)
    quantity_received: Decimal | None = Field(default=None, gt=0)
    quantity_remaining: Decimal | None = Field(default=None, ge=0)
    unit_cost: Decimal | None = Field(default=None, ge=0)
    received_at: date | None = None
    expiry_date: date | None = None
    expiry_date_source: ExpiryDateSource | None = None
    location: str | None = Field(default=None, min_length=1, max_length=120)
    supplier: str | None = Field(default=None, max_length=160)

    @field_validator("batch_code", "location")
    @classmethod
    def trim_optional_batch_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be empty.")
        return value

    @field_validator("supplier")
    @classmethod
    def trim_optional_supplier(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        return value or None

    @model_validator(mode="after")
    def require_changes(self) -> "BatchUpdate":
        if not self.model_fields_set:
            raise ValueError("At least one batch field must be provided.")
        if any(
            getattr(self, field) is None and field not in {"supplier", "expiry_date_source"}
            for field in self.model_fields_set
        ):
            raise ValueError("Provided batch fields cannot be null.")
        if (
            self.quantity_received is not None
            and self.quantity_remaining is not None
            and self.quantity_remaining > self.quantity_received
        ):
            raise ValueError("Remaining quantity cannot exceed received quantity.")
        if (
            self.received_at is not None
            and self.expiry_date is not None
            and self.expiry_date < self.received_at
            and self.expiry_date_source != "estimated"
        ):
            raise ValueError("Expiry date cannot be before received date.")
        return self


class BatchResponse(BatchCreate):
    model_config = ConfigDict(from_attributes=True)

    batch_id: int
    expiry_date: date
    status: str
    created_at: datetime


class ShelfLifeSettingResponse(BaseModel):
    category: str
    days: int = Field(gt=0, le=3650)
    updated_at: datetime | None


class ShelfLifeSettingUpdate(BaseModel):
    days: int = Field(gt=0, le=3650)


class ExpirySuggestionResponse(BaseModel):
    product_id: int
    category: str
    received_at: date
    default_shelf_life_days: int | None
    expiry_date: date | None


class InventoryBatchCsvImportRequest(BaseModel):
    csv_text: str = Field(min_length=1, max_length=5_000_000)


class InventoryBatchCsvImportConfirmRequest(InventoryBatchCsvImportRequest):
    import_id: str = Field(min_length=1, max_length=64)
    create_missing_products: bool = False


class InventoryBatchCsvImportResponse(BaseModel):
    inserted: int
    import_id: str
    products_created: int
    batches: list[BatchResponse]


class InventoryBatchCsvImportHistoryRecord(BaseModel):
    import_id: str
    row_count: int
    inserted: int
    products_created: int
    created_at: datetime
    created_by: int | None


class SaleResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    sale_id: int
    product_id: int
    batch_id: int | None
    sold_at: datetime
    quantity: Decimal
    unit_price: Decimal
    total_amount: Decimal
    source: str


class SaleCreate(BaseModel):
    product_id: int = Field(gt=0)
    batch_id: int | None = Field(default=None, gt=0)
    sold_at: datetime | None = None
    quantity: Decimal = Field(gt=0)
    unit_price: Decimal = Field(ge=0)
    source: Literal["manual", "pos", "integration"] = "manual"


class CheckoutItem(BaseModel):
    product_id: int = Field(gt=0)
    quantity: Decimal = Field(gt=0, decimal_places=3)


class CheckoutDiscount(BaseModel):
    type: Literal["percentage", "amount", "none"] = "none"
    value: Decimal = Field(default=Decimal("0"), ge=0)

    @model_validator(mode="after")
    def validate_value(self):
        if self.type == "percentage" and self.value > 100:
            raise ValueError("Percentage discount cannot exceed 100.")
        return self


class CheckoutRequest(BaseModel):
    items: list[CheckoutItem] = Field(min_length=1)
    discount: CheckoutDiscount = Field(default_factory=CheckoutDiscount)
    payment_method: Literal["cash", "upi", "card"]
    customer_name: str | None = Field(default=None, max_length=120)
    customer_phone: str | None = Field(default=None, max_length=32)
    idempotency_key: str = Field(min_length=1, max_length=128)

    @field_validator("customer_name", "customer_phone")
    @classmethod
    def normalize_optional_customer_details(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        return value or None

    @field_validator("items")
    @classmethod
    def reject_duplicate_products(cls, items: list[CheckoutItem]):
        product_ids = [item.product_id for item in items]
        if len(product_ids) != len(set(product_ids)):
            raise ValueError("Duplicate product IDs are not allowed in a checkout.")
        return items


class TransactionAllocationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    allocation_id: int
    batch_id: int
    product_id: int
    quantity_allocated: Decimal


class TransactionItemResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    sale_item_id: int
    product_id: int
    quantity: Decimal
    unit_price: Decimal
    line_subtotal: Decimal
    discount_amount: Decimal
    line_total: Decimal
    allocations: list[TransactionAllocationResponse] = []


class TransactionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    sale_transaction_id: int
    transaction_number: str
    subtotal: Decimal
    discount_type: str
    discount_value: Decimal
    discount_amount: Decimal
    total_amount: Decimal
    payment_method: str
    customer_name: str | None = None
    customer_phone: str | None = None
    sold_at: datetime
    processed_by: int
    status: str
    idempotency_key: str
    created_at: datetime
    updated_at: datetime
    items: list[TransactionItemResponse] = []


class WasteCreate(BaseModel):
    product_id: int = Field(gt=0)
    batch_id: int | None = Field(default=None, gt=0)
    quantity: Decimal = Field(gt=0)
    reason: Literal["spoilage", "expired", "damaged", "overstock", "other"]
    waste_cost: Decimal = Field(default=Decimal("0"), ge=0)
    notes: str | None = Field(default=None, max_length=500)


class WasteResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    waste_id: int
    product_id: int
    batch_id: int | None
    recorded_by: int | None
    quantity: Decimal
    reason: str
    waste_cost: Decimal
    recorded_at: datetime
    notes: str | None


class ForecastResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    forecast_id: int
    product_id: int
    forecast_date: date
    predicted_demand: Decimal
    lower_bound: Decimal | None
    upper_bound: Decimal | None
    model_version: str
    created_at: datetime


class ExpiryRiskGenerateRequest(BaseModel):
    batch_ids: list[int] | None = None


class ForecastGenerateRequest(BaseModel):
    start_date: date
    horizon_days: int = Field(default=30, ge=1, le=90)
    product_ids: list[int] | None = None


class RecommendationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    recommendation_id: int
    product_id: int
    batch_id: int | None = None
    recommendation_type: str
    recommended_quantity: Decimal | None
    discount_percent: Decimal | None
    reason: str
    status: str
    created_at: datetime
    updated_at: datetime
    applied_by: int | None
    applied_at: datetime | None = None


class ModelMetricResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    metric_id: int
    model_name: str
    model_version: str
    evaluated_at: datetime
    mae: Decimal | None
    rmse: Decimal | None
    r2_score: Decimal | None
    sample_size: int
    metrics_json: dict | None
    source: str = "database"


class RecommendationStatusRequest(BaseModel):
    status: Literal["approved", "rejected", "cancelled", "dismissed"]


class RecommendationReceipt(BaseModel):
    batch_code: str = Field(min_length=1, max_length=64)
    quantity_received: Decimal = Field(gt=0)
    unit_cost: Decimal = Field(default=Decimal("0"), ge=0)
    received_at: date
    expiry_date: date | None = None
    expiry_date_source: ExpiryDateSource | None = None
    location: str = Field(default="Unassigned", min_length=1, max_length=120)
    supplier: str | None = Field(default=None, max_length=160)

    @field_validator("batch_code", "location")
    @classmethod
    def trim_receipt_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("This field cannot be empty.")
        return value

    @field_validator("supplier")
    @classmethod
    def trim_optional_supplier(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        return value or None

    @model_validator(mode="after")
    def validate_receipt(self) -> "RecommendationReceipt":
        if (
            self.expiry_date is not None
            and self.expiry_date < self.received_at
            and self.expiry_date_source != "estimated"
        ):
            raise ValueError("Expiry date cannot be before received date.")
        return self


class GeneratedRecommendationApply(BaseModel):
    product_id: int = Field(gt=0)
    batch_id: int | None = Field(default=None, gt=0)
    recommendation_type: Literal["discount", "reorder", "restock", "restock_soon", "remove"] = "discount"
    discount_percent: Decimal | None = Field(default=None, gt=0, le=20)
    recommended_quantity: Decimal | None = Field(default=None, ge=0)
    source: Literal["application"] = "application"