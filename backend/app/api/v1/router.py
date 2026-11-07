import json
import logging
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, Response, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import case, func, insert, inspect, select, update
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session, load_only

from app.core.config import BACKEND_DIR
from app.core.security import (
    AuthenticatedSession,
    check_login_rate_limit,
    create_access_token,
    get_current_user,
    get_current_session,
    hash_password,
    require_admin,
    require_roles,
    record_login_failure,
    revoke_user_sessions,
    verify_password,
)
from app.api.v1.dashboard import router as dashboard_router
from app.api.v1.audit_logs import router as audit_logs_router
from app.api.v1.database_backups import router as database_backups_router
from app.api.v1.data_transfer import router as data_transfer_router
from app.api.v1.expiry_alerts import router as expiry_alerts_router
from app.api.v1.model_metrics import router as model_metrics_router
from app.api.v1.notifications import router as notifications_router
from app.api.v1.profile import router as profile_router
from app.api.v1.system_health import router as system_health_router
from app.db.session import get_db
from app.services.sales_checkout_service import (
    checkout_sale,
    get_checkout_transaction,
    list_checkout_transactions,
)
from app.services.product_images import (
    IMAGE_EXTENSIONS,
    MAX_PRODUCT_IMAGE_BYTES,
    delete_product_image,
    product_image_path,
    product_image_url,
    save_product_image,
    validate_product_image,
)
from app.services.store_logo import (
    MAX_STORE_LOGO_BYTES,
    delete_store_logo,
    save_store_logo,
    store_logo_path_for_store,
    store_logo_url_for_store,
    validate_store_logo,
)
from app.models import (
    DemandForecast,
    CategoryShelfLifeSetting,
    InventoryBatch,
    Product,
    Recommendation,
    SaleRecord,
    StoreInformation,
    User,
    UserGeneralSettings,
    UserNotificationSettings,
    UserActivity,
    WasteRecord,
)
from app.models.store_information import SINGLE_STORE_ID
from app.models.dashboard import DashboardImportRecord, DashboardImportRun
from app.schemas import (
    BatchCreate,
    BatchResponse,
    BatchUpdate,
    ExpiryRiskGenerateRequest,
    ForecastGenerateRequest,
    ForecastResponse,
    GeneralSettingsResponse,
    GeneralSettingsUpdate,
    NotificationSettingsResponse,
    NotificationSettingsUpdate,
    GeneratedRecommendationApply,
    LoginRequest,
    PasswordChangeRequest,
    ProductCreate,
    ProductResponse,
    ProductSkuSuggestion,
    ProductUpdate,
    RecommendationResponse,
    RecommendationReceipt,
    RecommendationStatusRequest,
    RegisterRequest,
    SaleCreate,
    SaleResponse,
    ShelfLifeSettingResponse,
    ShelfLifeSettingUpdate,
    ExpirySuggestionResponse,
    InventoryBatchCsvImportRequest,
    InventoryBatchCsvImportConfirmRequest,
    InventoryBatchCsvImportResponse,
    InventoryBatchCsvImportHistoryRecord,
    CheckoutRequest,
    TransactionResponse,
    StoreInformationResponse,
    StoreInformationUpdate,
    UserActiveRequest,
    UserRoleUpdate,
    WasteCreate,
    WasteResponse,
)
from app.services.dashboard_import_service import import_dashboard_csvs
from app.services.expiry_dates import (
    DEFAULT_SHELF_LIFE_DAYS,
    canonical_category,
    configured_shelf_life_days,
    suggest_expiry_date,
)
from app.services.inventory_batch_import_service import (
    confirm_inventory_batches_csv,
    list_inventory_batch_imports,
    preview_inventory_batches_csv,
)
from app.services.demand_forecast_service import generate_forecasts
from app.services.expiry_risk_service import predict_expiry_batches
from app.services.recommendation_service import discounted_price, recommend_discount
from app.services.product_sku_service import CATEGORY_SKU_PREFIXES, next_product_sku

logger = logging.getLogger(__name__)
_DUMMY_PASSWORD_HASH = hash_password("WasteWise invalid login timing sample 1!")

router = APIRouter(prefix="/api/v1")
router.include_router(audit_logs_router)
router.include_router(database_backups_router)
router.include_router(data_transfer_router)
router.include_router(dashboard_router)
router.include_router(expiry_alerts_router)
router.include_router(model_metrics_router)
router.include_router(notifications_router)
router.include_router(profile_router)
router.include_router(system_health_router)


def _record_activity(db: Session, user_id: int, action: str, entity_type: str, entity_id: int | None,
                     details: dict[str, object] | None = None) -> None:
    db.add(
        UserActivity(
            user_id=user_id,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            details=details,
        )
    )


@router.post("/auth/register", status_code=status.HTTP_201_CREATED)
def register(payload: RegisterRequest, db: Session = Depends(get_db)) -> dict[str, object]:
    user = User(
        full_name=payload.full_name.strip(),
        email=str(payload.email).lower(),
        password_hash=hash_password(payload.password),
        role={
            "Store Manager": "store_manager",
            "Staff": "staff",
            "Viewer": "viewer",
        }[payload.role],
        approval_status="approved",
    )
    db.add(user)
    try:
        db.flush()
        db.add(
            UserActivity(
                user_id=user.user_id,
                action="terms_accepted",
                entity_type="user",
                entity_id=user.user_id,
                details={
                    "terms_of_service": payload.accepted_terms,
                    "privacy_policy": payload.accepted_terms,
                },
            )
        )
        _record_activity(db, user.user_id, "user_registered", "user", user.user_id)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="An account with this email already exists.") from exc
    db.refresh(user)
    return {
        "user_id": user.user_id,
        "email": user.email,
        "message": "Your account has been created. You can sign in now.",
    }


@router.post("/auth/login")
def login(
    payload: LoginRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, object]:
    email = str(payload.email).casefold()
    client_ip = request.client.host if request.client is not None else None
    try:
        retry_after = check_login_rate_limit(db, email, client_ip)
        if retry_after is not None:
            raise HTTPException(
                status_code=429,
                detail="Too many sign-in attempts. Please wait before trying again.",
                headers={"Retry-After": str(retry_after)},
            )
        user = db.scalar(select(User).where(User.email == email))
        password_hash = user.password_hash if user is not None else _DUMMY_PASSWORD_HASH
        password_matches = verify_password(payload.password, password_hash)
        if user is None or not password_matches:
            record_login_failure(db, email, client_ip, user.user_id if user is not None else None)
            db.commit()
            raise HTTPException(status_code=401, detail="Invalid email or password.")
        if not user.is_active:
            db.add(
                UserActivity(
                    user_id=user.user_id,
                    action="auth_login_denied",
                    entity_type="auth_attempt",
                    details={"reason": "inactive_account"},
                )
            )
            db.commit()
            raise HTTPException(status_code=403, detail="Your account is inactive. Contact an administrator.")
        access_token, token_id = create_access_token(user.user_id)
        db.add(
            UserActivity(
                user_id=user.user_id,
                action="session_started",
                entity_type="auth_session",
                details={"jti": token_id},
            )
        )
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("Authentication database operation failed.")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Sign-in is temporarily unavailable. Please try again.",
        ) from exc
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "expires_in": 3600,
        "user": {
            "user_id": user.user_id,
            "full_name": user.full_name,
            "email": user.email,
            "role": user.role,
        },
    }


@router.post("/auth/change-password")
def change_password(
    payload: PasswordChangeRequest,
    session: AuthenticatedSession = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    user = session.user
    if not verify_password(payload.current_password, user.password_hash):
        _record_activity(
            db, user.user_id, "password_change_failed", "user", user.user_id,
            {"reason": "incorrect_current_password"},
        )
        try:
            db.commit()
        except SQLAlchemyError as exc:
            db.rollback()
            logger.exception("Password change failure audit could not be recorded.")
            raise HTTPException(status_code=503, detail="Password change could not be completed.") from exc
        raise HTTPException(status_code=400, detail="Current password is incorrect.")
    if verify_password(payload.new_password, user.password_hash):
        _record_activity(
            db, user.user_id, "password_change_failed", "user", user.user_id,
            {"reason": "unchanged_password"},
        )
        try:
            db.commit()
        except SQLAlchemyError as exc:
            db.rollback()
            logger.exception("Password change failure audit could not be recorded.")
            raise HTTPException(status_code=503, detail="Password change could not be completed.") from exc
        raise HTTPException(status_code=422, detail="New password must be different from the current password.")

    user.password_hash = hash_password(payload.new_password)
    revoked_sessions = revoke_user_sessions(db, user.user_id, user.user_id, "password_changed")
    _record_activity(
        db,
        user.user_id,
        "password_changed",
        "user",
        user.user_id,
        {"revoked_sessions": revoked_sessions},
    )
    try:
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("Password change database operation failed.")
        raise HTTPException(status_code=503, detail="Password change could not be completed.") from exc
    return {"status": "ok", "message": "Password changed. Sign in again with your new password."}


@router.get("/auth/me")
def current_user(user: User = Depends(get_current_user)) -> dict[str, object]:
    return {
        "user_id": user.user_id,
        "full_name": user.full_name,
        "email": user.email,
        "role": user.role,
    }


@router.post("/auth/logout")
def logout(
    session: AuthenticatedSession = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    db.add(
        UserActivity(
            user_id=session.user.user_id,
            action="session_revoked",
            entity_type="auth_session",
            details={"jti": session.token_id, "reason": "logout"},
        )
    )
    try:
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("Logout audit could not be committed.")
        raise HTTPException(status_code=503, detail="Sign-out could not be completed.") from exc
    return {"status": "ok", "message": "Signed out successfully."}


@router.get("/users")
def list_users(
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
    limit: int = Query(default=100, ge=1, le=500),
) -> list[dict[str, object]]:
    users = db.scalars(select(User).order_by(User.created_at.desc()).limit(limit)).all()
    return [
        {
            "user_id": user.user_id,
            "full_name": user.full_name,
            "email": user.email,
            "role": user.role,
            "is_active": user.is_active,
            "created_at": user.created_at,
        }
        for user in users
    ]


@router.patch("/users/{user_id}/active")
def set_user_active(
    user_id: int,
    payload: UserActiveRequest,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")
    if user.user_id == admin.user_id and not payload.is_active:
        raise HTTPException(status_code=409, detail="You cannot deactivate your own administrator account.")
    if user.role == "admin" and user.is_active and not payload.is_active:
        active_admin_ids = db.scalars(
            select(User.user_id)
            .where(User.role == "admin", User.is_active.is_(True))
            .with_for_update()
        ).all()
        if len(active_admin_ids) <= 1:
            raise HTTPException(status_code=409, detail="The last active administrator cannot be deactivated.")
    user.is_active = payload.is_active
    if not payload.is_active:
        revoke_user_sessions(db, user.user_id, admin.user_id, "account_deactivated")
    _record_activity(
        db,
        admin.user_id,
        "user_activated" if payload.is_active else "user_deactivated",
        "user",
        user.user_id,
    )
    db.commit()
    return {"user_id": user.user_id, "is_active": user.is_active}


@router.patch("/users/{user_id}/role")
def update_user_role(
    user_id: int,
    payload: UserRoleUpdate,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found.")
    previous_role = user.role
    if previous_role == payload.role:
        return {"user_id": user.user_id, "role": user.role}
    if user.is_active and previous_role == "admin" and payload.role != "admin":
        active_admin_ids = db.scalars(
            select(User.user_id)
            .where(User.role == "admin", User.is_active.is_(True))
            .with_for_update()
        ).all()
        if len(active_admin_ids) <= 1:
            raise HTTPException(status_code=409, detail="The last active administrator cannot be demoted.")
    user.role = payload.role
    revoked_sessions = revoke_user_sessions(db, user.user_id, admin.user_id, "role_changed")
    _record_activity(
        db,
        admin.user_id,
        "user_role_changed",
        "user",
        user.user_id,
        {
            "previous_role": previous_role,
            "new_role": payload.role,
            "revoked_sessions": revoked_sessions,
        },
    )
    try:
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("User role update failed.")
        raise HTTPException(status_code=503, detail="The user's role could not be updated.") from exc
    return {"user_id": user.user_id, "role": user.role}


@router.get("/products", response_model=list[ProductResponse])
def list_products(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> list[Product]:
    return list(db.scalars(select(Product).order_by(Product.name).offset(offset).limit(limit)).all())


@router.post("/products/{product_id}/image")
async def upload_product_image(
    product_id: int,
    request: Request,
    user: User = Depends(require_roles("admin", "store_manager")),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    if db.get(Product, product_id) is None:
        raise HTTPException(status_code=404, detail="Product not found.")

    content_type = request.headers.get("content-type", "").split(";", maxsplit=1)[0].strip().lower()
    if content_type not in IMAGE_EXTENSIONS:
        raise HTTPException(status_code=415, detail="Upload a JPEG, PNG, or WebP image.")

    contents = bytearray()
    async for chunk in request.stream():
        contents.extend(chunk)
        if len(contents) > MAX_PRODUCT_IMAGE_BYTES:
            raise HTTPException(status_code=413, detail="The optimized product image must be 5 MB or smaller.")

    extension = validate_product_image(content_type, bytes(contents))
    if extension is None:
        raise HTTPException(status_code=422, detail="The uploaded file is not a valid JPEG, PNG, or WebP image.")
    try:
        save_product_image(product_id, extension, bytes(contents))
    except OSError as exc:
        logger.exception("Product image could not be saved.")
        raise HTTPException(status_code=500, detail="Product image could not be saved.") from exc
    _record_activity(db, user.user_id, "product_image_updated", "product", product_id)
    try:
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("Product image update could not be audited.")
        raise HTTPException(status_code=503, detail="Product image update could not be completed.") from exc
    return {"image_url": product_image_url(product_id) or ""}


@router.get("/products/{product_id}/image", include_in_schema=False)
def get_product_image(product_id: int) -> FileResponse:
    path = product_image_path(product_id)
    if path is None:
        raise HTTPException(status_code=404, detail="Product image not found.")
    media_type = next(mime for mime, (extension, _) in IMAGE_EXTENSIONS.items() if path.suffix == extension)
    return FileResponse(path, media_type=media_type)


@router.delete("/products/{product_id}/image", status_code=status.HTTP_204_NO_CONTENT)
def remove_product_image(
    product_id: int,
    user: User = Depends(require_roles("admin", "store_manager")),
    db: Session = Depends(get_db),
) -> Response:
    if db.get(Product, product_id) is None:
        raise HTTPException(status_code=404, detail="Product not found.")
    try:
        delete_product_image(product_id)
    except OSError as exc:
        logger.exception("Product image could not be removed.")
        raise HTTPException(status_code=500, detail="Product image could not be removed.") from exc
    _record_activity(db, user.user_id, "product_image_updated", "product", product_id)
    try:
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("Product image removal could not be audited.")
        raise HTTPException(status_code=503, detail="Product image removal could not be completed.") from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/products/sku-suggestion", response_model=ProductSkuSuggestion)
def suggest_product_sku(
    category: str = Query(min_length=1, max_length=80),
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ProductSkuSuggestion:
    if category not in CATEGORY_SKU_PREFIXES:
        raise HTTPException(status_code=422, detail="Select a category from the approved category list.")
    prefix, sku = next_product_sku(db, category)
    return ProductSkuSuggestion(category=category, prefix=prefix, sku=sku)


@router.post("/products", status_code=status.HTTP_201_CREATED, response_model=ProductResponse)
def create_product(
    payload: ProductCreate,
    user: User = Depends(require_roles("admin", "store_manager")),
    db: Session = Depends(get_db),
) -> Product:
    product = Product(**payload.model_dump())
    db.add(product)
    try:
        db.flush()
        _record_activity(
            db, user.user_id, "product_created", "product", product.product_id,
            {"changed_fields": list(payload.model_dump().keys())},
        )
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="A product with this SKU already exists.") from exc
    db.refresh(product)
    return product


@router.put("/products/{product_id}", response_model=ProductResponse)
def update_product(
    product_id: int,
    payload: ProductUpdate,
    user: User = Depends(require_roles("admin", "store_manager")),
    db: Session = Depends(get_db),
) -> Product:
    product = db.get(Product, product_id)
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found.")
    values = payload.model_dump()
    changed_fields = [field for field, value in values.items() if getattr(product, field) != value]
    for field, value in values.items():
        setattr(product, field, value)
    try:
        if changed_fields:
            _record_activity(
                db, user.user_id, "product_updated", "product", product_id,
                {"changed_fields": changed_fields},
            )
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="A product with this SKU already exists.") from exc
    db.refresh(product)
    return product


@router.delete("/products/{product_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_product(
    product_id: int,
    user: User = Depends(require_roles("admin", "store_manager")),
    db: Session = Depends(get_db),
) -> None:
    product = db.get(Product, product_id)
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found.")
    if product.sku.startswith("MLDATA-"):
        raise HTTPException(status_code=409, detail="Imported dataset products are preserved.")
    references = (
        db.scalar(select(func.count()).select_from(InventoryBatch).where(InventoryBatch.product_id == product_id))
        + db.scalar(select(func.count()).select_from(SaleRecord).where(SaleRecord.product_id == product_id))
        + db.scalar(select(func.count()).select_from(WasteRecord).where(WasteRecord.product_id == product_id))
        + db.scalar(select(func.count()).select_from(DemandForecast).where(DemandForecast.product_id == product_id))
        + db.scalar(select(func.count()).select_from(Recommendation).where(Recommendation.product_id == product_id))
    )
    if references:
        raise HTTPException(status_code=409, detail="Products with inventory or activity history cannot be deleted.")
    _record_activity(db, user.user_id, "product_deleted", "product", product_id)
    db.delete(product)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="The product is referenced by existing records.") from exc


@router.get("/inventory/batches", response_model=list[BatchResponse])
def list_batches(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> list[BatchResponse]:
    try:
        batch_columns = {
            column["name"] for column in inspect(db.get_bind()).get_columns(InventoryBatch.__tablename__)
        }
        selected_columns = [
            getattr(InventoryBatch, column.key)
            for column in InventoryBatch.__mapper__.column_attrs
            if column.key in batch_columns
        ]
        query = (
            select(*selected_columns)
            .order_by(InventoryBatch.expiry_date, InventoryBatch.batch_id)
            .offset(offset)
            .limit(limit)
        )
        db.scalars(select(InventoryBatch.batch_id).limit(1))
        rows = db.execute(query).mappings().all()
        batches = []
        for row in rows:
            batch_data = dict(row)
            batch_data.setdefault("expiry_date_source", None)
            batches.append(BatchResponse.model_validate(batch_data))
        return batches
    except Exception as exc:
        logger.exception("Inventory batch listing failed.")
        raise HTTPException(status_code=500, detail="Inventory batches could not be loaded.") from exc


@router.get("/inventory/shelf-life", response_model=list[ShelfLifeSettingResponse])
def get_shelf_life_settings(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ShelfLifeSettingResponse]:
    try:
        stored_settings = {}
        if inspect(db.get_bind()).has_table(CategoryShelfLifeSetting.__tablename__):
            stored_settings = {
                setting.category: setting
                for setting in db.scalars(
                    select(CategoryShelfLifeSetting).order_by(CategoryShelfLifeSetting.category)
                ).all()
            }
        return [
            ShelfLifeSettingResponse(
                category=category,
                days=stored_settings[category].days if category in stored_settings else days,
                updated_at=stored_settings[category].updated_at if category in stored_settings else None,
            )
            for category, days in DEFAULT_SHELF_LIFE_DAYS.items()
        ]
    except SQLAlchemyError as exc:
        logger.exception("Shelf-life settings could not be loaded.")
        raise HTTPException(status_code=500, detail="Shelf-life settings could not be loaded.") from exc


@router.put("/inventory/shelf-life/{category}", response_model=ShelfLifeSettingResponse)
def update_shelf_life_setting(
    category: str,
    payload: ShelfLifeSettingUpdate,
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> CategoryShelfLifeSetting:
    canonical = canonical_category(category)
    if canonical is None or canonical not in DEFAULT_SHELF_LIFE_DAYS:
        raise HTTPException(status_code=404, detail="Unknown shelf-life category.")
    if not inspect(db.get_bind()).has_table(CategoryShelfLifeSetting.__tablename__):
        raise HTTPException(
            status_code=503,
            detail="Shelf-life settings cannot be saved because the settings table is not available.",
        )
    setting = db.get(CategoryShelfLifeSetting, canonical)
    if setting is None:
        setting = CategoryShelfLifeSetting(category=canonical, days=payload.days)
        db.add(setting)
    else:
        setting.days = payload.days
    setting.updated_by = user.user_id
    try:
        _record_activity(db, user.user_id, "shelf_life_updated", "category_shelf_life", None,
                         {"category": canonical, "days": payload.days})
        db.commit()
        db.refresh(setting)
        return setting
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("Shelf-life setting update failed.")
        raise HTTPException(status_code=500, detail="Shelf-life setting could not be saved.") from exc


@router.get("/products/{product_id}/expiry-suggestion", response_model=ExpirySuggestionResponse)
def get_product_expiry_suggestion(
    product_id: int,
    received_at: date = Query(),
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    product = db.get(Product, product_id)
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found.")
    days = configured_shelf_life_days(db, product.category)
    return {
        "product_id": product_id,
        "category": product.category,
        "received_at": received_at,
        "default_shelf_life_days": days,
        "expiry_date": suggest_expiry_date(db, product.category, received_at),
    }


@router.post("/inventory/batches", status_code=status.HTTP_201_CREATED, response_model=BatchResponse)
def create_batch(
    payload: BatchCreate,
    user: User = Depends(require_roles("admin", "store_manager")),
    db: Session = Depends(get_db),
) -> InventoryBatch:
    values = payload.model_dump()
    if values["quantity_remaining"] is None:
        values["quantity_remaining"] = values["quantity_received"]
    product = db.get(Product, payload.product_id)
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found.")
    if payload.expiry_date is None or payload.expiry_date_source == "estimated":
        values["expiry_date"] = suggest_expiry_date(db, product.category, payload.received_at)
        if values["expiry_date"] is None:
            raise HTTPException(
                status_code=422,
                detail=f"No shelf-life default is configured for category {product.category!r}; provide a verified expiry date.",
            )
        values["expiry_date_source"] = "estimated"
    values["status"] = "expired" if values["expiry_date"] < date.today() else "active"

    batch_columns = {
        column["name"] for column in inspect(db.get_bind()).get_columns(InventoryBatch.__tablename__)
    }
    if "expiry_date_source" in batch_columns:
        values_to_insert = values
    else:
        values_to_insert = {key: value for key, value in values.items() if key in batch_columns}
        values_to_insert.pop("expiry_date_source", None)
        logger.warning("Inventory batch expiry provenance was not saved because the database column is missing.")

    try:
        result = db.execute(insert(InventoryBatch).values(**values_to_insert))
        batch_id = result.inserted_primary_key[0]
        _record_activity(
            db,
            user.user_id,
            "batch_created",
            "inventory_batch",
            batch_id,
            {
                "quantity_received": str(values["quantity_received"]),
                "quantity_remaining": str(values["quantity_remaining"]),
            },
        )
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail="The product does not exist or this batch code is already used for it.",
        ) from exc
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("Inventory batch creation failed.")
        raise HTTPException(
            status_code=503,
            detail="The batch could not be saved. Please verify the inventory database schema and try again.",
        ) from exc

    selected_columns = [
        getattr(InventoryBatch, column.key)
        for column in InventoryBatch.__mapper__.column_attrs
        if column.key in batch_columns
    ]
    batch_row = db.execute(select(*selected_columns).where(InventoryBatch.batch_id == batch_id)).mappings().one()
    batch_data = dict(batch_row)
    batch_data.setdefault("expiry_date_source", None)
    return batch_data


@router.post("/inventory/batches/import/preview")
def preview_inventory_batches(
    payload: InventoryBatchCsvImportRequest,
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    try:
        return preview_inventory_batches_csv(db, payload.csv_text)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except SQLAlchemyError as exc:
        logger.exception("Inventory batch CSV preview failed.")
        raise HTTPException(status_code=503, detail="Batch validation is temporarily unavailable.") from exc


@router.post(
    "/inventory/batches/import/confirm",
    status_code=status.HTTP_201_CREATED,
    response_model=InventoryBatchCsvImportResponse,
)
def confirm_inventory_batch_import(
    payload: InventoryBatchCsvImportConfirmRequest,
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    try:
        result = confirm_inventory_batches_csv(
            db,
            payload.csv_text,
            user.user_id,
            payload.import_id,
            payload.create_missing_products,
        )
        result["batches"] = [BatchResponse.model_validate(batch) for batch in result["batches"]]
        return result
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="The import conflicts with existing products or batches. Refresh the preview.") from exc
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("Inventory batch CSV import failed.")
        raise HTTPException(status_code=503, detail="Batch import could not be completed; no rows were committed.") from exc


@router.get(
    "/inventory/batches/imports",
    response_model=list[InventoryBatchCsvImportHistoryRecord],
)
def get_inventory_batch_import_history(
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> list[dict]:
    try:
        return list_inventory_batch_imports(db)
    except SQLAlchemyError as exc:
        logger.exception("Inventory batch import history could not be loaded.")
        raise HTTPException(status_code=503, detail="Batch import history is temporarily unavailable.") from exc


@router.patch("/inventory/batches/{batch_id}", response_model=BatchResponse)
def update_batch(
    batch_id: int,
    payload: BatchUpdate,
    user: User = Depends(require_roles("admin", "store_manager")),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    batch_columns = {
        column["name"] for column in inspect(db.get_bind()).get_columns(InventoryBatch.__tablename__)
    }
    selected_columns = [
        getattr(InventoryBatch, column.key)
        for column in InventoryBatch.__mapper__.column_attrs
        if column.key in batch_columns
    ]
    row = db.execute(
        select(*selected_columns)
        .where(InventoryBatch.batch_id == batch_id)
        .with_for_update()
    ).mappings().first()
    if row is None:
        raise HTTPException(status_code=404, detail="Inventory batch not found.")
    batch = dict(row)
    values = payload.model_dump(exclude_unset=True)
    next_received = values.get("quantity_received", batch["quantity_received"])
    next_remaining = values.get("quantity_remaining", batch["quantity_remaining"])
    next_received_at = values.get("received_at", batch["received_at"])
    next_expiry_date = values.get("expiry_date", batch["expiry_date"])
    if "expiry_date" in values and "expiry_date_source" not in values:
        values["expiry_date_source"] = None
    source_after_update = values.get("expiry_date_source", batch.get("expiry_date_source"))
    if source_after_update == "estimated" and (
        next_received_at != batch["received_at"]
        or ("expiry_date_source" in values and batch.get("expiry_date_source") != "estimated")
        or next_expiry_date < next_received_at
    ):
        product = db.get(Product, batch["product_id"])
        next_expiry_date = suggest_expiry_date(db, product.category, next_received_at) if product else None
        if next_expiry_date is None:
            raise HTTPException(
                status_code=422,
                detail="No shelf-life default is configured for this product category; provide an expiry date.",
            )
        values["expiry_date"] = next_expiry_date
    if next_remaining > next_received:
        raise HTTPException(status_code=422, detail="Remaining quantity cannot exceed received quantity.")
    if next_expiry_date < next_received_at:
        raise HTTPException(status_code=422, detail="Expiry date cannot be before received date.")
    if values.get("expiry_date_source") is not None and "expiry_date_source" not in batch_columns:
        logger.warning(
            "Inventory batch expiry provenance could not be saved because the database column is missing."
        )
    updates = {
        field: value
        for field, value in values.items()
        if field in batch_columns
    }
    changed_fields = [field for field, value in updates.items() if batch.get(field) != value]
    original_status = batch.get("status")
    batch.update(updates)
    if batch["quantity_remaining"] == 0:
        batch["status"] = "depleted"
    elif batch["expiry_date"] < date.today():
        batch["status"] = "expired"
    else:
        batch["status"] = "active"
    if "status" in batch_columns and batch.get("status") != original_status:
        changed_fields.append("status")
    updates["status"] = batch["status"]
    try:
        db.execute(
            update(InventoryBatch)
            .where(InventoryBatch.batch_id == batch_id)
            .values(**updates)
        )
        _record_activity(
            db,
            user.user_id,
            "batch_updated",
            "inventory_batch",
            batch_id,
            {"changed_fields": changed_fields},
        )
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="The batch code is already used for this product.") from exc
    updated_row = db.execute(
        select(*selected_columns).where(InventoryBatch.batch_id == batch_id)
    ).mappings().one()
    return dict(updated_row)


@router.delete("/inventory/batches/{batch_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_batch(
    batch_id: int,
    user: User = Depends(require_roles("admin", "store_manager")),
    db: Session = Depends(get_db),
) -> None:
    batch = db.get(InventoryBatch, batch_id)
    if batch is None:
        raise HTTPException(status_code=404, detail="Inventory batch not found.")
    references = (
        db.scalar(select(func.count()).select_from(SaleRecord).where(SaleRecord.batch_id == batch_id))
        + db.scalar(select(func.count()).select_from(WasteRecord).where(WasteRecord.batch_id == batch_id))
    )
    if references:
        raise HTTPException(status_code=409, detail="Batches with sales or waste history cannot be deleted.")
    _record_activity(db, user.user_id, "batch_deleted", "inventory_batch", batch_id)
    db.delete(batch)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="The batch is referenced by existing records.") from exc


@router.get("/inventory/summary")
def inventory_summary(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[dict[str, object]]:
    today = date.today()
    rows = db.execute(
        select(
            Product.product_id,
            Product.name,
            Product.category,
            Product.sku,
            Product.unit,
            Product.price,
            Product.supplier,
            func.coalesce(
                func.sum(
                    case(
                        (
                            (InventoryBatch.status == "active")
                            & (InventoryBatch.expiry_date >= today),
                            InventoryBatch.quantity_remaining,
                        ),
                        else_=0,
                    )
                ),
                0,
            ).label("quantity"),
            func.coalesce(
                func.sum(
                    case(
                        (
                            (InventoryBatch.status == "active")
                            & (InventoryBatch.expiry_date >= today)
                            & (InventoryBatch.quantity_remaining > 0),
                            1,
                        ),
                        else_=0,
                    )
                ),
                0,
            ).label("batch_count"),
        )
        .outerjoin(InventoryBatch, InventoryBatch.product_id == Product.product_id)
        .group_by(
            Product.product_id,
            Product.name,
            Product.category,
            Product.sku,
            Product.unit,
            Product.price,
            Product.supplier,
        )
        .order_by(Product.name)
    ).all()
    return [
        {
            "product_id": product_id,
            "product_name": name,
            "category": category,
            "sku": sku,
            "unit": unit,
            "price": float(price),
            "supplier": supplier,
            "quantity": float(quantity),
            "inventory_value": float(quantity * price),
            "active_batch_count": int(batch_count),
            "source": "actual",
        }
        for product_id, name, category, sku, unit, price, supplier, quantity, batch_count in rows
    ]


@router.get("/sales", response_model=list[SaleResponse])
def list_sales(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> list[SaleRecord]:
    return list(
        db.scalars(select(SaleRecord).order_by(SaleRecord.sold_at.desc()).offset(offset).limit(limit)).all()
    )


@router.post("/sales/checkout", status_code=status.HTTP_201_CREATED, response_model=TransactionResponse)
def checkout_pos_sale(
    payload: CheckoutRequest,
    user: User = Depends(require_roles("admin", "store_manager")),
    db: Session = Depends(get_db),
) -> TransactionResponse:
    return checkout_sale(db, user, payload)


@router.get("/sales/transactions/{sale_transaction_id}", response_model=TransactionResponse)
def get_pos_sale_transaction(
    sale_transaction_id: int,
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    return get_checkout_transaction(db, sale_transaction_id)


@router.get("/sales/transactions", response_model=list[TransactionResponse])
def list_pos_sale_transactions(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> list[TransactionResponse]:
    return list_checkout_transactions(db, limit=limit, offset=offset)


@router.post("/sales", status_code=status.HTTP_201_CREATED, response_model=SaleResponse)
def create_sale(
    payload: SaleCreate,
    user: User = Depends(require_roles("admin", "store_manager")),
    db: Session = Depends(get_db),
) -> SaleRecord:
    batch = None
    if payload.batch_id is not None:
        batch = db.scalar(
            select(InventoryBatch)
            .where(InventoryBatch.batch_id == payload.batch_id)
            .with_for_update()
        )
        if batch is None or batch.product_id != payload.product_id:
            raise HTTPException(status_code=404, detail="The selected product batch was not found.")
        if batch.status != "active" or batch.expiry_date < date.today():
            raise HTTPException(status_code=409, detail="The selected batch is not available for sale.")
        if batch.quantity_remaining < payload.quantity:
            raise HTTPException(status_code=409, detail="The batch does not have enough remaining stock.")
        batch.quantity_remaining -= payload.quantity
        if batch.quantity_remaining == 0:
            batch.status = "depleted"

    sale = SaleRecord(
        **payload.model_dump(exclude={"sold_at"}),
        sold_at=payload.sold_at or datetime.now(timezone.utc).replace(tzinfo=None),
        total_amount=(payload.quantity * payload.unit_price).quantize(Decimal("0.01")),
    )
    db.add(sale)
    try:
        db.flush()
        _record_activity(
            db,
            user.user_id,
            "sale_recorded",
            "sale",
            sale.sale_id,
            {"quantity": str(sale.quantity), "total_amount": str(sale.total_amount)},
        )
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="The sale references an unknown product or batch.") from exc
    db.refresh(sale)
    return sale


@router.get("/waste", response_model=list[WasteResponse])
def list_waste(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> list[WasteRecord]:
    return list(
        db.scalars(select(WasteRecord).order_by(WasteRecord.recorded_at.desc()).offset(offset).limit(limit)).all()
    )


@router.post("/waste", status_code=status.HTTP_201_CREATED, response_model=WasteResponse)
def create_waste_record(
    payload: WasteCreate,
    user: User = Depends(require_roles("admin", "store_manager")),
    db: Session = Depends(get_db),
) -> WasteRecord:
    if payload.batch_id is not None:
        batch = db.scalar(
            select(InventoryBatch)
            .where(InventoryBatch.batch_id == payload.batch_id)
            .with_for_update()
        )
        if batch is None or batch.product_id != payload.product_id:
            raise HTTPException(status_code=404, detail="The selected product batch was not found.")
        if batch.quantity_remaining < payload.quantity:
            raise HTTPException(status_code=409, detail="The batch does not have enough remaining stock.")
        batch.quantity_remaining -= payload.quantity
        if batch.quantity_remaining == 0:
            batch.status = "depleted"

    record = WasteRecord(**payload.model_dump(), recorded_by=user.user_id)
    db.add(record)
    try:
        db.flush()
        _record_activity(
            db,
            user.user_id,
            "waste_recorded",
            "waste_record",
            record.waste_id,
            {"quantity": str(record.quantity), "reason": record.reason},
        )
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="The waste record references an unknown product or batch.") from exc
    db.refresh(record)
    return record


@router.post("/risk/expiry/predict")
def predict_expiry_risk(
    payload: ExpiryRiskGenerateRequest,
    _: User = Depends(require_roles("admin", "store_manager")),
    db: Session = Depends(get_db),
) -> list[dict[str, object]]:
    try:
        return predict_expiry_batches(db, payload.batch_ids)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=422 if isinstance(exc, ValueError) else 503, detail=str(exc)) from exc


@router.get("/risk/expiry")
def expiry_risks(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    within_days: int = Query(default=30, ge=0, le=365),
) -> list[dict[str, object]]:
    today = date.today()
    batches = db.execute(
        select(InventoryBatch, Product.name)
        .join(Product, Product.product_id == InventoryBatch.product_id)
        .where(
            InventoryBatch.quantity_remaining > 0,
            InventoryBatch.expiry_date <= today + timedelta(days=within_days),
        )
        .order_by(InventoryBatch.expiry_date)
    ).all()
    return [
        {
            "batch_id": batch.batch_id,
            "product_id": batch.product_id,
            "product_name": product_name,
            "batch_code": batch.batch_code,
            "quantity_remaining": batch.quantity_remaining,
            "expiry_date": batch.expiry_date,
            "expiry_date_source": batch.expiry_date_source,
            "risk": "expired" if batch.expiry_date < today else "expiring",
        }
        for batch, product_name in batches
    ]


@router.post("/forecasts/generate", response_model=list[ForecastResponse])
def generate_demand_forecasts(
    payload: ForecastGenerateRequest,
    _: User = Depends(require_roles("admin", "store_manager")),
    db: Session = Depends(get_db),
) -> list[DemandForecast]:
    try:
        return generate_forecasts(db, payload.product_ids, payload.start_date, payload.horizon_days)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/forecasts", response_model=list[ForecastResponse])
def list_forecasts(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    product_id: int | None = Query(default=None, gt=0),
    limit: int = Query(default=100, ge=1, le=500),
) -> list[DemandForecast]:
    query = select(DemandForecast).order_by(DemandForecast.forecast_date.desc())
    if product_id is not None:
        query = query.where(DemandForecast.product_id == product_id)
    return list(db.scalars(query.limit(limit)).all())


@router.get("/recommendations", response_model=list[RecommendationResponse])
def list_recommendations(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    recommendation_status: str | None = Query(default=None, alias="status"),
    limit: int = Query(default=100, ge=1, le=500),
) -> list[Recommendation]:
    query = select(Recommendation).order_by(Recommendation.created_at.desc())
    if recommendation_status is not None:
        if recommendation_status not in {"pending", "approved", "ordered", "received", "rejected", "cancelled", "dismissed", "applied"}:
            raise HTTPException(status_code=422, detail="Unsupported recommendation status.")
        query = query.where(Recommendation.status == recommendation_status)
    return list(db.scalars(query.limit(limit)).all())


@router.post("/recommendations/apply-generated")
def apply_generated_recommendation(
    payload: GeneratedRecommendationApply,
    user: User = Depends(require_roles("admin", "store_manager")),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    product = db.get(Product, payload.product_id)
    if product is None:
        raise HTTPException(status_code=404, detail="Product not found.")

    if payload.recommendation_type == "discount":
        if payload.batch_id is None or payload.discount_percent is None:
            raise HTTPException(status_code=422, detail="A batch and discount percentage are required.")
        batch = db.scalar(select(InventoryBatch).options(load_only(
            InventoryBatch.batch_id,
            InventoryBatch.product_id,
            InventoryBatch.quantity_remaining,
            InventoryBatch.expiry_date,
            InventoryBatch.status,
        )).where(InventoryBatch.batch_id == payload.batch_id))
        if batch is None or batch.product_id != payload.product_id:
            raise HTTPException(status_code=404, detail="Recommendation batch not found for this product.")
        if batch.status != "active" or batch.quantity_remaining <= 0:
            raise HTTPException(status_code=409, detail="The batch is no longer eligible for a discount.")
        if batch.expiry_date <= date.today():
            raise HTTPException(status_code=409, detail="Expired products cannot be discounted for sale.")
        expected = recommend_discount((batch.expiry_date - date.today()).days, Decimal(str(batch.quantity_remaining)))
        if Decimal(str(payload.discount_percent)) != expected:
            raise HTTPException(status_code=409, detail="The discount is no longer valid for this batch; regenerate recommendations.")
    elif payload.recommendation_type == "remove":
        if payload.batch_id is None:
            raise HTTPException(status_code=422, detail="An expired batch is required for removal.")
        batch = db.scalar(select(InventoryBatch).options(load_only(
            InventoryBatch.batch_id,
            InventoryBatch.product_id,
            InventoryBatch.expiry_date,
            InventoryBatch.status,
        )).where(InventoryBatch.batch_id == payload.batch_id))
        if batch is None or batch.product_id != payload.product_id:
            raise HTTPException(status_code=404, detail="Recommendation batch not found for this product.")
        if batch.status != "expired" and batch.expiry_date >= date.today():
            raise HTTPException(status_code=409, detail="Only expired inventory may be applied as a removal recommendation.")
    elif payload.recommendation_type in {"reorder", "restock", "restock_soon"}:
        if payload.recommended_quantity is None or payload.recommended_quantity <= 0:
            raise HTTPException(status_code=422, detail="A positive recommended quantity is required.")
        if payload.batch_id is not None:
            batch = db.scalar(select(InventoryBatch).options(load_only(
                InventoryBatch.batch_id,
                InventoryBatch.product_id,
            )).where(InventoryBatch.batch_id == payload.batch_id))
            if batch is None or batch.product_id != payload.product_id:
                raise HTTPException(status_code=404, detail="Recommendation batch not found for this product.")

    normalized_type = payload.recommendation_type.replace("restock_soon", "restock")
    if normalized_type in {"reorder", "restock"} and user.role not in {"admin", "store_manager"}:
        raise HTTPException(status_code=403, detail="Only administrators and store managers can approve replenishment recommendations.")

    existing = db.scalar(
        select(Recommendation).where(
            Recommendation.product_id == payload.product_id,
            Recommendation.recommendation_type == normalized_type,
            Recommendation.status.in_(["pending", "approved", "ordered", "received", "applied"]),
            Recommendation.discount_percent == payload.discount_percent if payload.recommendation_type == "discount" else True,
        ).order_by(Recommendation.created_at.desc())
    )
    if existing is not None and existing.status in {"approved", "ordered", "received", "applied"}:
        raise HTTPException(status_code=409, detail="This recommendation has already been approved or executed.")
    if existing is not None:
        existing.status = "approved"
        existing.applied_by = user.user_id
        existing.applied_at = datetime.now(timezone.utc).replace(tzinfo=None)
        existing.batch_id = payload.batch_id
        recommendation = existing
    else:
        recommendation = Recommendation(
            product_id=payload.product_id,
            recommendation_type=normalized_type,
            batch_id=payload.batch_id,
            recommended_quantity=payload.recommended_quantity,
            discount_percent=payload.discount_percent,
            reason=f"Verified {payload.recommendation_type} recommendation approved by {user.full_name}; no inventory execution has occurred.",
            status="approved",
            applied_by=user.user_id,
            applied_at=datetime.now(timezone.utc).replace(tzinfo=None),
        )
        db.add(recommendation)
        db.flush()

    db.add(UserActivity(
        user_id=user.user_id,
        action="recommendation_approved",
        entity_type="recommendation",
        entity_id=recommendation.recommendation_id,
        details={
            "product_id": payload.product_id,
            "batch_id": payload.batch_id,
            "recommendation_type": payload.recommendation_type,
            "discount_percent": float(payload.discount_percent) if payload.discount_percent is not None else None,
            "original_price": float(product.price),
            "suggested_price": float(discounted_price(Decimal(str(product.price)), payload.discount_percent)) if payload.discount_percent is not None else None,
            "recommended_quantity": float(payload.recommended_quantity) if payload.recommended_quantity is not None else None,
            "recorded_separately": True,
        },
    ))
    try:
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail="The recommendation approval transaction was rolled back.") from exc
    db.refresh(recommendation)
    return {"recommendation_id": recommendation.recommendation_id, "status": recommendation.status}


@router.post("/recommendations/{recommendation_id}/record-purchase")
def record_recommendation_purchase(
    recommendation_id: int,
    user: User = Depends(require_roles("admin", "store_manager")),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    recommendation = db.scalar(
        select(Recommendation).where(Recommendation.recommendation_id == recommendation_id).with_for_update()
    )
    if recommendation is None:
        raise HTTPException(status_code=404, detail="Recommendation not found.")
    if recommendation.recommendation_type not in {"reorder", "restock"}:
        raise HTTPException(status_code=409, detail="Only restock and reorder recommendations can record a purchase.")
    if recommendation.status != "approved":
        raise HTTPException(status_code=409, detail="Only an approved recommendation can be recorded as purchased.")
    recommendation.status = "ordered"
    _record_activity(db, user.user_id, "recommendation_purchase_recorded", "recommendation", recommendation_id,
                     details={"recommendation_type": recommendation.recommendation_type})
    try:
        db.commit()
    except (IntegrityError, SQLAlchemyError):
        db.rollback()
        raise HTTPException(status_code=409, detail="The purchase could not be recorded.")
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail="The purchase could not be recorded.") from exc
    db.refresh(recommendation)
    return {"recommendation_id": recommendation_id, "status": recommendation.status}


@router.post("/recommendations/{recommendation_id}/receive")
def receive_recommendation_stock(
    recommendation_id: int,
    payload: RecommendationReceipt,
    user: User = Depends(require_roles("admin", "store_manager")),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    recommendation = db.scalar(
        select(Recommendation).where(Recommendation.recommendation_id == recommendation_id).with_for_update()
    )
    if recommendation is None:
        raise HTTPException(status_code=404, detail="Recommendation not found.")
    if recommendation.recommendation_type not in {"reorder", "restock"}:
        raise HTTPException(status_code=409, detail="Only restock and reorder recommendations can receive stock.")
    if recommendation.status == "received":
        raise HTTPException(status_code=409, detail="This recommendation has already been received.")
    if recommendation.status not in {"approved", "ordered"}:
        raise HTTPException(status_code=409, detail="Only an approved or purchased recommendation can be received.")

    product = db.get(Product, recommendation.product_id)
    if product is None:
        raise HTTPException(status_code=404, detail="Recommendation product not found.")
    expiry_date = payload.expiry_date
    expiry_date_source = payload.expiry_date_source
    if expiry_date is None or expiry_date_source == "estimated":
        expiry_date = suggest_expiry_date(db, product.category, payload.received_at)
        if expiry_date is None:
            raise HTTPException(
                status_code=422,
                detail=f"No shelf-life default is configured for category {product.category!r}; provide a verified expiry date.",
            )
        expiry_date_source = "estimated"
    if expiry_date < payload.received_at:
        raise HTTPException(status_code=422, detail="Expiry date cannot be before received date.")
    batch = InventoryBatch(
        product_id=recommendation.product_id,
        batch_code=payload.batch_code,
        quantity_received=payload.quantity_received,
        quantity_remaining=payload.quantity_received,
        unit_cost=payload.unit_cost,
        received_at=payload.received_at,
        expiry_date=expiry_date,
        expiry_date_source=expiry_date_source,
        status="active",
        location=payload.location,
        supplier=payload.supplier,
    )
    db.add(batch)
    recommendation.status = "received"
    recommendation.batch_id = None
    try:
        db.flush()
        recommendation.batch_id = batch.batch_id
        _record_activity(db, user.user_id, "recommendation_stock_received", "recommendation", recommendation_id,
                         details={"batch_id": batch.batch_id, "quantity_received": float(payload.quantity_received),
                                  "received_at": payload.received_at.isoformat()})
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="The batch code is already used for this product or receipt could not be audited.") from exc
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail="The stock receipt transaction failed and was rolled back.") from exc
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail="The stock receipt transaction failed and was rolled back.") from exc
    db.refresh(recommendation)
    return {"recommendation_id": recommendation_id, "status": recommendation.status, "batch_id": batch.batch_id}


@router.patch("/recommendations/{recommendation_id}")
def update_recommendation(
    recommendation_id: int,
    payload: RecommendationStatusRequest,
    user: User = Depends(require_roles("admin", "store_manager")),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    recommendation = db.get(Recommendation, recommendation_id)
    if recommendation is None:
        raise HTTPException(status_code=404, detail="Recommendation not found.")
    if recommendation.status != "pending":
        raise HTTPException(status_code=409, detail="Only pending recommendations can be updated.")
    recommendation.status = payload.status
    recommendation.applied_by = user.user_id if payload.status == "approved" else None
    recommendation.applied_at = datetime.now(timezone.utc).replace(tzinfo=None) if payload.status == "approved" else None
    _record_activity(db, user.user_id, f"recommendation_{payload.status}", "recommendation", recommendation_id)
    try:
        db.commit()
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail="The recommendation status update was rolled back.") from exc
    return {"recommendation_id": recommendation_id, "status": recommendation.status}


@router.post("/datasets/import", status_code=status.HTTP_202_ACCEPTED)
def import_datasets(
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    inspector = inspect(db.get_bind())
    required_tables = {
        DashboardImportRun.__tablename__,
        DashboardImportRecord.__tablename__,
        "dashboard_historical_metrics",
    }
    if not required_tables.issubset(set(inspector.get_table_names())):
        raise HTTPException(
            status_code=503,
            detail="The additive dashboard-import migration must be applied before importing datasets.",
        )
    try:
        runs = import_dashboard_csvs(db)
        db.commit()
    except (FileNotFoundError, ValueError) as exc:
        db.rollback()
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except SQLAlchemyError:
        db.rollback()
        logger.exception("Dataset import failed; the database transaction was rolled back.")
        raise

    return {
        "status": "accepted",
        "training": "not_started_requires_explicit_confirmation",
        "imports": [
            {
                "source_file": run.source_file,
                "rows_seen": run.rows_seen,
                "rows_inserted": run.rows_inserted,
                "rows_skipped": run.rows_skipped,
                "sha256": run.source_sha256,
            }
            for run in runs
        ],
    }


@router.get("/models/registry")
def model_registry(
    _: User = Depends(get_current_user),
) -> dict[str, object]:
    from ml.src.model_registry import DEFAULT_ARTIFACT_DIR

    registry_path = DEFAULT_ARTIFACT_DIR / "active_models.json"
    if not registry_path.exists():
        return {"active_models": {}}
    return {"active_models": json.loads(registry_path.read_text(encoding="utf-8"))}


@router.post("/models/{model_name}/rollback")
def rollback_registered_model(
    model_name: Literal["demand_forecast", "expiry_risk", "food_waste", "discount_recommendation"],
    version: str | None = Query(default=None, min_length=1, max_length=64),
    _: User = Depends(require_admin),
) -> dict[str, object]:
    from ml.src.model_registry import rollback_model

    try:
        return rollback_model(model_name, version)
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


def _upsert_shared_store_information(db: Session, values: dict[str, str]) -> StoreInformation:
    dialect = db.get_bind().dialect.name
    if dialect == "mysql":
        statement = mysql_insert(StoreInformation).values(store_id=SINGLE_STORE_ID, **values)
        statement = statement.on_duplicate_key_update(**values)
    elif dialect == "sqlite":
        statement = sqlite_insert(StoreInformation).values(store_id=SINGLE_STORE_ID, **values)
        statement = statement.on_conflict_do_update(
            index_elements=[StoreInformation.store_id],
            set_=values,
        )
    else:
        raise RuntimeError(f"Shared Store Information does not support the {dialect} database dialect.")

    db.execute(statement)
    record = db.scalar(
        select(StoreInformation)
        .where(StoreInformation.store_id == SINGLE_STORE_ID)
        .execution_options(populate_existing=True)
    )
    if record is None:
        raise HTTPException(status_code=500, detail="Shared store information could not be loaded.")
    return record


def _ensure_shared_store_information(db: Session) -> StoreInformation:
    values = {
        "store_name": "",
        "store_address": "",
        "contact_number": "",
        "email": "",
    }
    dialect = db.get_bind().dialect.name
    if dialect == "mysql":
        statement = mysql_insert(StoreInformation).values(store_id=SINGLE_STORE_ID, **values)
        statement = statement.on_duplicate_key_update(store_id=SINGLE_STORE_ID)
    elif dialect == "sqlite":
        statement = sqlite_insert(StoreInformation).values(store_id=SINGLE_STORE_ID, **values)
        statement = statement.on_conflict_do_nothing(index_elements=[StoreInformation.store_id])
    else:
        raise RuntimeError(f"Shared Store Information does not support the {dialect} database dialect.")
    db.execute(statement)
    record = db.scalar(
        select(StoreInformation)
        .where(StoreInformation.store_id == SINGLE_STORE_ID)
        .execution_options(populate_existing=True)
    )
    if record is None:
        raise HTTPException(status_code=500, detail="Shared store information could not be loaded.")
    return record


@router.get("/settings/store", response_model=StoreInformationResponse)
def get_store_information(
    _user: User = Depends(require_roles("admin", "store_manager")),
    db: Session = Depends(get_db),
) -> StoreInformationResponse:
    record = db.get(StoreInformation, SINGLE_STORE_ID)
    if record is None:
        return StoreInformationResponse(
            store_id=SINGLE_STORE_ID,
            store_name="",
            store_address="",
            contact_number="",
            email="",
            logo_path=None,
            logo_url=None,
        )
    logo_url = store_logo_url_for_store(record.store_id) if record.logo_path else None
    return StoreInformationResponse(
        store_id=record.store_id,
        store_name=record.store_name,
        store_address=record.store_address,
        contact_number=record.contact_number,
        email=record.email,
        logo_path=record.logo_path,
        logo_url=logo_url,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


@router.put("/settings/store", response_model=StoreInformationResponse)
def update_store_information(
    payload: StoreInformationUpdate,
    user: User = Depends(require_roles("admin", "store_manager")),
    db: Session = Depends(get_db),
) -> StoreInformationResponse:
    try:
        existing = db.get(StoreInformation, SINGLE_STORE_ID)
        values = {
            "store_name": payload.store_name.strip(),
            "store_address": payload.store_address.strip(),
            "contact_number": payload.contact_number.strip(),
            "email": str(payload.email).lower(),
        }
        changed_fields = [
            field for field, value in values.items()
            if existing is None or getattr(existing, field) != value
        ]
        record = _upsert_shared_store_information(db, values)
        if changed_fields:
            _record_activity(
                db,
                user.user_id,
                "store_information_updated",
                "store_information",
                record.store_id,
                {"changed_fields": changed_fields},
            )
        db.commit()
        db.refresh(record)
        return StoreInformationResponse(
            store_id=record.store_id,
            store_name=record.store_name,
            store_address=record.store_address,
            contact_number=record.contact_number,
            email=record.email,
            logo_path=record.logo_path,
            logo_url=store_logo_url_for_store(record.store_id) if record.logo_path else None,
            created_at=record.created_at,
            updated_at=record.updated_at,
        )
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("Could not save store information for user %s.", user.user_id)
        raise HTTPException(status_code=500, detail="Store information could not be saved.") from exc


@router.post("/settings/store/logo", response_model=StoreInformationResponse)
async def upload_store_logo(
    file: UploadFile = File(...),
    user: User = Depends(require_roles("admin", "store_manager")),
    db: Session = Depends(get_db),
) -> StoreInformationResponse:
    if file.filename is None or not file.filename.strip():
        raise HTTPException(status_code=400, detail="A logo image file is required.")
    content_type = (file.content_type or "").split(";", maxsplit=1)[0].strip().lower()
    if content_type not in {"image/png", "image/jpeg", "image/webp"}:
        raise HTTPException(status_code=415, detail="Upload a PNG, JPG, JPEG, or WebP logo image.")
    contents = await file.read()
    if len(contents) > MAX_STORE_LOGO_BYTES:
        raise HTTPException(status_code=413, detail="The logo must be 2 MB or smaller.")
    extension = validate_store_logo(content_type, contents)
    if extension is None:
        raise HTTPException(status_code=422, detail="The uploaded file is not a valid PNG, JPG, JPEG, or WebP image.")
    try:
        record = db.get(StoreInformation, SINGLE_STORE_ID)
        if record is None:
            record = _ensure_shared_store_information(db)
        saved_path = save_store_logo(record.store_id, extension, contents)
        record.logo_path = f"uploads/store/{record.store_id}{extension}"
        _record_activity(db, user.user_id, "store_logo_updated", "store_information", record.store_id)
        db.commit()
        db.refresh(record)
        return StoreInformationResponse(
            store_id=record.store_id,
            store_name=record.store_name,
            store_address=record.store_address,
            contact_number=record.contact_number,
            email=record.email,
            logo_path=record.logo_path,
            logo_url=f"/api/v1/settings/store/logo?v={saved_path.stat().st_mtime_ns}",
            created_at=record.created_at,
            updated_at=record.updated_at,
        )
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("Could not save store logo for user %s.", user.user_id)
        raise HTTPException(status_code=500, detail="Store logo could not be saved.") from exc


@router.get("/settings/store/logo", include_in_schema=False)
def get_store_logo(
    _user: User = Depends(require_roles("admin", "store_manager")),
    db: Session = Depends(get_db),
) -> FileResponse:
    record = db.get(StoreInformation, SINGLE_STORE_ID)
    if record is None or not record.logo_path:
        raise HTTPException(status_code=404, detail="Store logo not found.")
    path = BACKEND_DIR / record.logo_path
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Store logo not found.")
    media_type = "image/png" if path.suffix == ".png" else "image/jpeg" if path.suffix in {".jpg", ".jpeg"} else "image/webp"
    return FileResponse(path, media_type=media_type)


@router.get("/settings/me")
def get_my_settings(user: User = Depends(get_current_user)) -> dict[str, object]:
    return {
        "user_id": user.user_id,
        "full_name": user.full_name,
        "email": user.email,
        "role": user.role,
    }


@router.get("/settings/me/general", response_model=GeneralSettingsResponse)
def get_my_general_settings(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> GeneralSettingsResponse:
    try:
        settings = db.get(UserGeneralSettings, user.user_id)
        if settings is None:
            return GeneralSettingsResponse(
                application_name="WasteWise AI",
                timezone="Asia/Kolkata",
                date_format="DD MMM YYYY",
                language="en",
                items_per_page=10,
            )
        return GeneralSettingsResponse.model_validate(settings)
    except SQLAlchemyError as exc:
        logger.exception("Could not load general settings for user %s.", user.user_id)
        raise HTTPException(status_code=500, detail="General settings could not be loaded.") from exc


@router.put("/settings/me/general", response_model=GeneralSettingsResponse)
def update_my_general_settings(
    payload: GeneralSettingsUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> GeneralSettingsResponse:
    values = payload.model_dump()
    try:
        settings = db.get(UserGeneralSettings, user.user_id)
        changed_fields = [
            key for key, value in values.items()
            if settings is None or getattr(settings, key) != value
        ]
        if settings is None:
            settings = UserGeneralSettings(user_id=user.user_id, **values)
            db.add(settings)
        else:
            for key, value in values.items():
                setattr(settings, key, value)
        if changed_fields:
            _record_activity(
                db,
                user.user_id,
                "general_settings_updated",
                "general_settings",
                user.user_id,
                {"changed_fields": changed_fields},
            )
        db.commit()
        db.refresh(settings)
        return GeneralSettingsResponse.model_validate(settings)
    except IntegrityError:
        db.rollback()
        try:
            settings = db.get(UserGeneralSettings, user.user_id)
            if settings is None:
                raise HTTPException(status_code=500, detail="General settings could not be saved.")
            changed_fields = [
                key for key, value in values.items()
                if getattr(settings, key) != value
            ]
            for key, value in values.items():
                setattr(settings, key, value)
            if changed_fields:
                _record_activity(
                    db,
                    user.user_id,
                    "general_settings_updated",
                    "general_settings",
                    user.user_id,
                    {"changed_fields": changed_fields},
                )
            db.commit()
            db.refresh(settings)
            return GeneralSettingsResponse.model_validate(settings)
        except SQLAlchemyError as exc:
            db.rollback()
            logger.exception("Could not save general settings for user %s.", user.user_id)
            raise HTTPException(status_code=500, detail="General settings could not be saved.") from exc
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("Could not save general settings for user %s.", user.user_id)
        raise HTTPException(status_code=500, detail="General settings could not be saved.") from exc


@router.get("/settings/me/notifications", response_model=NotificationSettingsResponse)
def get_my_notification_settings(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> NotificationSettingsResponse:
    try:
        settings = db.get(UserNotificationSettings, user.user_id)
        if settings is None:
            return NotificationSettingsResponse()
        return NotificationSettingsResponse.model_validate(settings)
    except SQLAlchemyError as exc:
        logger.exception("Could not load notification settings for user %s.", user.user_id)
        raise HTTPException(status_code=500, detail="Notification settings could not be loaded.") from exc


@router.put("/settings/me/notifications", response_model=NotificationSettingsResponse)
def update_my_notification_settings(
    payload: NotificationSettingsUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> NotificationSettingsResponse:
    values = payload.model_dump()
    try:
        settings = db.get(UserNotificationSettings, user.user_id)
        changed_fields = [
            key for key, value in values.items()
            if settings is None or getattr(settings, key) != value
        ]
        if settings is None:
            settings = UserNotificationSettings(user_id=user.user_id, **values)
            db.add(settings)
        else:
            for key, value in values.items():
                setattr(settings, key, value)
        if changed_fields:
            _record_activity(
                db,
                user.user_id,
                "notification_settings_updated",
                "notification_settings",
                user.user_id,
                {"changed_fields": changed_fields},
            )
        db.commit()
        db.refresh(settings)
        return NotificationSettingsResponse.model_validate(settings)
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("Could not save notification settings for user %s.", user.user_id)
        raise HTTPException(status_code=500, detail="Notification settings could not be saved.") from exc