from collections import defaultdict
import logging
from datetime import date, datetime, time, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import and_, func, inspect, literal, select
from sqlalchemy.orm import Session

from app.core.security import get_current_user
from app.db.session import get_db
from app.models import (
	DashboardHistoricalMetric,
	DashboardImportRecord,
	DemandForecast,
	InventoryBatch,
	Product,
	Recommendation,
	SaleRecord,
	User,
	UserActivity,
	WasteRecord,
)
from app.services.audit_log_service import activity_scope
from app.services.dashboard_csv_service import CsvBatchSnapshot, load_dashboard_csv_data
from app.services.expiry_risk_service import predict_expiry_batches
from app.services.recommendation_service import generate_operational_recommendations
from app.services.recommendation_service import (
	discounted_price,
	estimated_gross_margin,
	expiry_risk,
	recommendation_priority,
	recommendation_reason,
	recommend_discount,
)
from app.schemas.dashboard import (
	CategoryDistributionResponse,
	DataAvailability,
	DashboardRecommendation,
	DashboardSummary,
	ExpiryAlert,
	LowStockProduct,
	RecentActivity,
	SalesDemandResponse,
	TopProduct,
	UnitQuantity,
	WasteTrendResponse,
)

router = APIRouter(prefix="/dashboard", tags=["dashboard"])
_ZERO = Decimal("0")
_MAX_DATE_RANGE_DAYS = 730
_CSV_UNAVAILABLE_MESSAGE = "The dashboard CSV source is unavailable. Application records remain available."
logger = logging.getLogger(__name__) 


def _import_table_available(db: Session, table_name: str) -> bool:
	return inspect(db.get_bind()).has_table(table_name)


def _date_range(start_date: date | None, end_date: date | None, default_days: int = 30) -> tuple[date, date]:
	end = end_date or date.today()
	start = start_date or end - timedelta(days=default_days - 1)
	if start > end:
		raise HTTPException(status_code=422, detail="start_date must be on or before end_date.")
	if (end - start).days > _MAX_DATE_RANGE_DAYS:
		raise HTTPException(status_code=422, detail=f"Date range cannot exceed {_MAX_DATE_RANGE_DAYS} days.")
	return start, end


def _datetime_bounds(start: date, end: date) -> tuple[datetime, datetime]:
	return datetime.combine(start, time.min), datetime.combine(end + timedelta(days=1), time.min)


def _as_float(value: Decimal | int | float | None) -> float:
	return float(value or 0)


def _unit_totals(rows: list[tuple[str, Decimal | None]]) -> list[UnitQuantity]:
	totals: dict[str, Decimal] = defaultdict(lambda: _ZERO)
	for unit, quantity in rows:
		totals[unit] += quantity or _ZERO
	return [UnitQuantity(unit=unit, quantity=_as_float(totals[unit])) for unit in sorted(totals)]


def _activity_date_filter(column, start: date, end: date):
	start_at, end_at = _datetime_bounds(start, end)
	return and_(column >= start_at, column < end_at)


def _application_expiry_rows(
	db: Session,
	today: date,
	within_days: int,
	limit: int | None = None,
) -> list[tuple]:
	batch_columns = {
		column["name"] for column in inspect(db.get_bind()).get_columns(InventoryBatch.__tablename__)
	}
	expiry_date_source = (
		InventoryBatch.expiry_date_source
		if "expiry_date_source" in batch_columns
		else literal(None).label("expiry_date_source")
	)
	query = (
		select(
			InventoryBatch.batch_id,
			InventoryBatch.product_id,
			InventoryBatch.batch_code,
			InventoryBatch.expiry_date,
			expiry_date_source,
			InventoryBatch.quantity_remaining,
			Product.name,
			Product.category,
			Product.unit,
		)
		.join(Product, Product.product_id == InventoryBatch.product_id)
		.where(
			InventoryBatch.quantity_remaining > 0,
			InventoryBatch.status.in_(("active", "expired")),
			InventoryBatch.expiry_date <= today + timedelta(days=within_days),
		)
		.order_by(InventoryBatch.expiry_date, InventoryBatch.batch_id)
	)
	if limit is not None:
		query = query.limit(limit)
	return list(db.execute(query).all())


def _snapshot_expiry_alerts(
	csv_data,
	today: date,
	within_days: int,
) -> list[ExpiryAlert]:
	products_by_source_id = {int(product.source_id): product for product in csv_data.catalog_products}
	alerts = []
	for snapshot in csv_data.inventory_snapshots:
		if snapshot.snapshot_date > today or snapshot.quantity_remaining <= 0:
			continue
		days_to_expiry = (snapshot.expiry_date - snapshot.snapshot_date).days
		if days_to_expiry > within_days:
			continue
		product = products_by_source_id[int(snapshot.product_source_id)]
		alerts.append(
			ExpiryAlert(
				source="inventory_snapshot",
				batch_id=snapshot.batch_id,
				product_id=int(snapshot.product_source_id),
				product_name=product.name,
				category=snapshot.category or product.category,
				unit=product.unit,
				batch_code=f"CSV-{snapshot.batch_id}",
				expiry_date=snapshot.expiry_date,
				snapshot_date=snapshot.snapshot_date,
				days_to_expiry=days_to_expiry,
				quantity_remaining=_as_float(snapshot.quantity_remaining),
				status="expired" if days_to_expiry < 0 else "expiring_soon",
				risk="high" if days_to_expiry <= 3 else "medium",
			)
		)
	alerts.sort(key=lambda alert: (-(alert.snapshot_date or date.min).toordinal(), alert.days_to_expiry))
	return alerts


@router.get("/summary", response_model=DashboardSummary)
def dashboard_summary(
	_: User = Depends(get_current_user),
	db: Session = Depends(get_db),
	start_date: date | None = None,
	end_date: date | None = None,
	within_days: int = Query(default=7, ge=0, le=365),
) -> DashboardSummary:
	start, end = _date_range(start_date, end_date)
	csv_data = load_dashboard_csv_data()
	database_products = db.execute(select(Product.product_id, Product.sku)).all()
	database_skus = {sku for _, sku in database_products}
	database_product_ids = {product_id for product_id, _ in database_products}
	csv_product_ids = {product.source_id for product in csv_data.catalog_products}
	database_sku_source_ids = {
		sku.removeprefix("MLDATA-")
		for sku in database_skus
		if sku.startswith("MLDATA-")
	}
	import_table_available = _import_table_available(db, DashboardImportRecord.__tablename__)
	persisted_records = (
		db.execute(
			select(DashboardImportRecord.source_record_key, DashboardImportRecord.entity_id).where(
				DashboardImportRecord.entity_type == "product",
				DashboardImportRecord.source_file == csv_data.catalog_source,
			)
		).all()
		if import_table_available
		else []
	)
	persisted_source_ids = {
		source_id for source_id, entity_id in persisted_records if entity_id in database_product_ids
	}
	persisted_entity_ids = {entity_id for _, entity_id in persisted_records}
	database_imported_entity_ids = (persisted_entity_ids & database_product_ids) | {
		product_id
		for product_id, sku in database_products
		if sku.startswith("MLDATA-")
	}
	all_imported_source_ids = csv_product_ids | persisted_source_ids | database_sku_source_ids
	csv_source_ids_already_in_database = csv_product_ids & (persisted_source_ids | database_sku_source_ids)
	csv_only_product_count = len(csv_product_ids - csv_source_ids_already_in_database)
	product_count = len(database_products) + csv_only_product_count
	user_product_count = len(database_products) - len(database_imported_entity_ids)
	import_catalog_available = csv_data.catalog_available or import_table_available
	imported_product_count = len(all_imported_source_ids) if import_catalog_available else None
	inventory_rows = db.execute(
		select(Product.unit, func.sum(InventoryBatch.quantity_remaining))
		.join(InventoryBatch, InventoryBatch.product_id == Product.product_id)
		.where(
			InventoryBatch.status == "active",
			InventoryBatch.quantity_remaining > 0,
			InventoryBatch.expiry_date >= date.today(),
		)
		.group_by(Product.unit)
		.order_by(Product.unit)
	).all()
	active_batch_count = int(
		db.scalar(
			select(func.count())
			.select_from(InventoryBatch)
			.where(
				InventoryBatch.status == "active",
				InventoryBatch.quantity_remaining > 0,
				InventoryBatch.expiry_date >= date.today(),
			)
		)
		or 0
	)
	sales_total, sales_count = db.execute(
		select(func.sum(SaleRecord.total_amount), func.count())
		.select_from(SaleRecord)
		.where(_activity_date_filter(SaleRecord.sold_at, start, end))
	).one()
	waste_rows = db.execute(
		select(Product.unit, func.sum(WasteRecord.quantity))
		.join(Product, Product.product_id == WasteRecord.product_id)
		.where(_activity_date_filter(WasteRecord.recorded_at, start, end))
		.group_by(Product.unit)
	).all()
	waste_cost, waste_count = db.execute(
		select(func.sum(WasteRecord.waste_cost), func.count())
		.select_from(WasteRecord)
		.where(_activity_date_filter(WasteRecord.recorded_at, start, end))
	).one()
	today = date.today()
	application_expiry_rows = _application_expiry_rows(db, today, within_days)
	snapshot_expiry_rows = _snapshot_expiry_alerts(csv_data, today, within_days)
	application_expired_count = sum(1 for row in application_expiry_rows if row[3] < today)
	application_expiring_soon_count = len(application_expiry_rows) - application_expired_count
	snapshot_expired_count = sum(1 for alert in snapshot_expiry_rows if alert.status == "expired")
	snapshot_expiring_soon_count = len(snapshot_expiry_rows) - snapshot_expired_count
	return DashboardSummary(
		start_date=start,
		end_date=end,
		product_count=product_count,
		active_product_count=product_count,
		imported_product_count=imported_product_count,
		user_product_count=user_product_count,
		imported_catalog=DataAvailability(
			status="available" if import_catalog_available else "unavailable",
			message="Read-only CSV catalog is included; source IDs and MLDATA SKUs are deduplicated against MySQL." if csv_data.catalog_available else "Imported catalog provenance is available in MySQL." if import_table_available else _CSV_UNAVAILABLE_MESSAGE,
			source=csv_data.catalog_source if csv_data.catalog_available else "dashboard_import_records" if import_table_available else None,
		),
		available_inventory=_unit_totals(inventory_rows),
		active_batch_count=active_batch_count,
		sales_revenue=_as_float(sales_total),
		sales_record_count=int(sales_count or 0),
		currency="INR",
		waste_quantity_by_unit=_unit_totals(waste_rows),
		waste_cost=_as_float(waste_cost),
		waste_record_count=int(waste_count or 0),
		expired_batch_count=application_expired_count + snapshot_expired_count,
		expiring_soon_batch_count=application_expiring_soon_count + snapshot_expiring_soon_count,
		expiry_window_days=within_days,
		application_expired_batch_count=application_expired_count,
		application_expiring_soon_batch_count=application_expiring_soon_count,
		snapshot_expired_batch_count=snapshot_expired_count,
		snapshot_expiring_soon_batch_count=snapshot_expiring_soon_count,
	)


@router.get("/sales-demand", response_model=SalesDemandResponse)
def sales_demand(
	_: User = Depends(get_current_user),
	db: Session = Depends(get_db),
	start_date: date | None = None,
	end_date: date | None = None,
	product_id: int | None = Query(default=None, gt=0),
	category: str | None = Query(default=None, min_length=1, max_length=80),
	prediction_days: int = Query(default=30, ge=0, le=180),
) -> SalesDemandResponse:
	start, end = _date_range(start_date, end_date)
	csv_data = load_dashboard_csv_data()
	start_at, end_at = _datetime_bounds(start, end)
	prediction_start = max(end + timedelta(days=1), date.today())
	prediction_end = prediction_start + timedelta(days=prediction_days - 1) if prediction_days else None
	product_filters = []
	if product_id is not None:
		product_filters.append(Product.product_id == product_id)
	if category is not None:
		product_filters.append(Product.category == category)
	actual_rows = db.execute(
		select(func.date(SaleRecord.sold_at), Product.unit, func.sum(SaleRecord.quantity))
		.join(Product, Product.product_id == SaleRecord.product_id)
		.where(SaleRecord.sold_at >= start_at, SaleRecord.sold_at < end_at, *product_filters)
		.group_by(func.date(SaleRecord.sold_at), Product.unit)
		.order_by(func.date(SaleRecord.sold_at), Product.unit)
	).all()
	database_history_available = _import_table_available(db, DashboardHistoricalMetric.__tablename__)
	database_history_rows = (
		db.execute(
			select(DashboardHistoricalMetric.business_date, Product.unit, func.sum(DashboardHistoricalMetric.sales_quantity))
			.join(Product, Product.product_id == DashboardHistoricalMetric.product_id)
			.where(
				DashboardHistoricalMetric.business_date >= start,
				DashboardHistoricalMetric.business_date <= end,
				*product_filters,
			)
			.group_by(DashboardHistoricalMetric.business_date, Product.unit)
			.order_by(DashboardHistoricalMetric.business_date, Product.unit)
		).all()
		if database_history_available
		else []
	)
	if database_history_rows:
		history_rows = database_history_rows
		history_source_available = True
		history_source = "dashboard_historical_metrics"
		history_message = "Persisted training history is shown separately from actual application sales."
	else:
		csv_products = {product.source_id: product for product in csv_data.catalog_products}
		selected_source_ids = set(csv_products)
		if product_id is not None:
			product_sku = db.scalar(select(Product.sku).where(Product.product_id == product_id))
			selected_source_ids = {
				product_sku.removeprefix("MLDATA-")
				if product_sku and product_sku.startswith("MLDATA-")
				else ""
			}
		history_rows = [
			(row.business_date, csv_products[row.product_source_id].unit, row.sales_quantity)
			for row in csv_data.sales_history
			if start <= row.business_date <= end
			and row.product_source_id in selected_source_ids
			and (category is None or row.category == category)
		]
		history_source_available = csv_data.history_available
		history_source = csv_data.history_source if history_source_available else None
		history_message = (
			"CSV training history is shown separately from actual application sales."
			if history_source_available
			else _CSV_UNAVAILABLE_MESSAGE
		)
	forecast_rows = db.execute(
		select(DemandForecast.forecast_date, Product.unit, DemandForecast.predicted_demand, DemandForecast.model_version)
		.join(Product, Product.product_id == DemandForecast.product_id)
		.where(
			DemandForecast.forecast_date >= prediction_start,
			DemandForecast.forecast_date <= prediction_end if prediction_end else False,
			*product_filters,
		)
		.order_by(DemandForecast.forecast_date, Product.unit)
	).all()
	actual = [
		{"date": date.fromisoformat(str(row[0])), "unit": row[1], "quantity": _as_float(row[2])}
		for row in actual_rows
	]
	history = [{"date": row[0], "unit": row[1], "quantity": _as_float(row[2])} for row in history_rows]
	forecast_totals: dict[tuple[date, str], Decimal] = defaultdict(lambda: _ZERO)
	forecast_versions: dict[tuple[date, str], set[str]] = defaultdict(set)
	for forecast_date, unit, quantity, version in forecast_rows:
		key = (forecast_date, unit)
		forecast_totals[key] += quantity
		forecast_versions[key].add(version)
	predicted = [
		{
			"date": forecast_date,
			"unit": unit,
			"quantity": _as_float(quantity),
			"model_versions": sorted(forecast_versions[(forecast_date, unit)]),
		}
		for (forecast_date, unit), quantity in sorted(forecast_totals.items())
	]
	baseline_fallback_used = not predicted and prediction_days > 0
	if baseline_fallback_used:
		baseline_rows = actual if actual else history
		daily_totals: dict[str, list[Decimal]] = defaultdict(list)
		for row in baseline_rows:
			daily_totals[row["unit"]].append(Decimal(str(row["quantity"])))
		for unit, quantities in sorted(daily_totals.items()):
			if not quantities:
				continue
			average = sum(quantities, Decimal("0")) / Decimal(len(quantities))
			if average <= 0:
				continue
			for offset in range(prediction_days):
				predicted.append({
					"date": prediction_start + timedelta(days=offset),
					"unit": unit,
					"quantity": _as_float(average),
					"model_versions": ["historical-average-baseline"],
				})
	available_units = sorted({row["unit"] for row in actual + history + predicted})
	return SalesDemandResponse(
		start_date=start,
		end_date=end,
		prediction_start_date=prediction_start if prediction_end else None,
		prediction_end_date=prediction_end,
		units=available_units,
		actual_sales=actual,
		imported_history=history,
		imported_history_status=DataAvailability(
			status="available" if history_source_available else "unavailable",
			message=history_message,
			source=history_source,
		),
		predicted_demand=predicted,
		prediction={
			"status": "available" if predicted else "unavailable",
			"source": "historical_average_baseline" if baseline_fallback_used else "demand_forecasts",
			"message": (
				"Forecast window disabled by request."
				if not prediction_days
				else "Showing a transparent historical-average baseline because no saved model forecast exists."
				if baseline_fallback_used
				else "Showing saved, versioned forecasts for the forward window; they are not recorded sales."
			),
		},
	)


@router.get("/category-distribution", response_model=CategoryDistributionResponse)
def category_distribution(
	_: User = Depends(get_current_user),
	db: Session = Depends(get_db),
) -> CategoryDistributionResponse:
	csv_data = load_dashboard_csv_data()
	stock_join = and_(
		InventoryBatch.product_id == Product.product_id,
		InventoryBatch.status == "active",
		InventoryBatch.quantity_remaining > 0,
		InventoryBatch.expiry_date >= date.today(),
	)
	rows = db.execute(
		select(
			Product.product_id,
			Product.sku,
			Product.category,
			Product.unit,
			func.coalesce(func.sum(InventoryBatch.quantity_remaining), 0),
		)
		.outerjoin(InventoryBatch, stock_join)
		.group_by(Product.product_id, Product.sku, Product.category, Product.unit)
		.order_by(Product.category, Product.sku)
	).all()
	database_product_ids = {row[0] for row in rows}
	products_by_sku = {
		row[1]: {"category": row[2], "unit": row[3]}
		for row in rows
	}
	persisted_source_ids = set()
	if csv_data.catalog_available and _import_table_available(db, DashboardImportRecord.__tablename__):
		persisted_source_ids = {
			source_id
			for source_id, entity_id in db.execute(
				select(DashboardImportRecord.source_record_key, DashboardImportRecord.entity_id).where(
					DashboardImportRecord.source_file == csv_data.catalog_source,
					DashboardImportRecord.entity_type == "product",
				)
			).all()
			if entity_id in database_product_ids
		}
	live_stock: dict[str, dict[str, Decimal]] = defaultdict(lambda: defaultdict(lambda: _ZERO))
	live_stocked_skus: dict[str, set[str]] = defaultdict(set)
	for _, sku, category, unit, quantity in rows:
		if quantity:
			live_stock[category][unit] += quantity
			live_stocked_skus[category].add(sku)
	for product in csv_data.catalog_products:
		if product.source_id in persisted_source_ids:
			continue
		products_by_sku.setdefault(product.sku, {"category": product.category, "unit": product.unit})
	products_by_category: dict[str, set[str]] = defaultdict(set)
	for sku, product in products_by_sku.items():
		products_by_category[product["category"]].add(sku)
	total = sum(len(skus) for skus in products_by_category.values())
	categories = [
		{
			"category": category,
			"product_count": len(products_by_category[category]),
			"live_stocked_product_count": len(live_stocked_skus[category]),
			"product_share_percent": round(100 * len(products_by_category[category]) / total, 2) if total else 0,
			"available_quantity_by_unit": [
				{"unit": unit, "quantity": _as_float(quantity)}
				for unit, quantity in sorted(live_stock[category].items())
			],
		}
		for category in sorted(products_by_category)
	]
	return CategoryDistributionResponse(
		measure="share_of_distinct_catalog_products",
		total_products=total,
		categories=categories,
	)


@router.get("/waste-trend", response_model=WasteTrendResponse)
def waste_trend(
	_: User = Depends(get_current_user),
	db: Session = Depends(get_db),
	start_date: date | None = None,
	end_date: date | None = None,
	granularity: str = Query(default="month", pattern="^(day|month)$"),
) -> WasteTrendResponse:
	start, end = _date_range(start_date, end_date, default_days=180)
	csv_data = load_dashboard_csv_data()
	actual_rows = db.execute(
		select(WasteRecord.recorded_at, Product.unit, WasteRecord.quantity, WasteRecord.waste_cost)
		.join(Product, Product.product_id == WasteRecord.product_id)
		.where(_activity_date_filter(WasteRecord.recorded_at, start, end))
		.order_by(WasteRecord.recorded_at)
	).all()
	expired_rows = db.execute(
		select(InventoryBatch.expiry_date, Product.unit, InventoryBatch.quantity_remaining, InventoryBatch.unit_cost)
		.join(Product, Product.product_id == InventoryBatch.product_id)
		.where(
			InventoryBatch.expiry_date >= start,
			InventoryBatch.expiry_date <= end,
			InventoryBatch.expiry_date < date.today(),
			InventoryBatch.quantity_remaining > 0,
			InventoryBatch.status.in_(("active", "expired")),
		)
		.order_by(InventoryBatch.expiry_date)
	).all()
	database_history_available = _import_table_available(db, DashboardHistoricalMetric.__tablename__)
	database_history_rows = (
		db.execute(
			select(DashboardHistoricalMetric.business_date, Product.unit, DashboardHistoricalMetric.waste_quantity)
			.join(Product, Product.product_id == DashboardHistoricalMetric.product_id)
			.where(
				DashboardHistoricalMetric.business_date >= start,
				DashboardHistoricalMetric.business_date <= end,
			)
			.order_by(DashboardHistoricalMetric.business_date)
		).all()
		if database_history_available
		else []
	)
	if database_history_rows:
		history_rows = database_history_rows
		history_source_available = True
		history_source = "dashboard_historical_metrics"
		history_message = "Persisted training waste history is shown separately from recorded application waste."
	else:
		history_rows = [
			(row.business_date, "unit", row.waste_quantity)
			for row in csv_data.sales_history
			if start <= row.business_date <= end
		]
		history_source_available = csv_data.history_available
		history_source = csv_data.history_source if history_source_available else None
		history_message = (
			"CSV training waste history is shown separately from recorded application waste."
			if history_source_available
			else _CSV_UNAVAILABLE_MESSAGE
		)

	def period_for(value: date) -> date:
		return value if granularity == "day" else value.replace(day=1)

	actual_totals: dict[tuple[date, str], Decimal] = defaultdict(lambda: _ZERO)
	actual_costs: dict[tuple[date, str], Decimal] = defaultdict(lambda: _ZERO)
	expired_totals: dict[tuple[date, str], Decimal] = defaultdict(lambda: _ZERO)
	expired_costs: dict[tuple[date, str], Decimal] = defaultdict(lambda: _ZERO)
	history_totals: dict[tuple[date, str], Decimal] = defaultdict(lambda: _ZERO)
	for recorded_at, unit, quantity, cost in actual_rows:
		key = (period_for(recorded_at.date()), unit)
		actual_totals[key] += quantity
		actual_costs[key] += cost
	for expiry_date, unit, quantity, unit_cost in expired_rows:
		key = (period_for(expiry_date), unit)
		expired_totals[key] += quantity
		expired_costs[key] += quantity * unit_cost
	for business_date, unit, quantity in history_rows:
		key = (period_for(business_date), unit)
		history_totals[key] += quantity
	actual = [
		{"period": period, "unit": unit, "quantity": _as_float(quantity), "cost": _as_float(actual_costs[(period, unit)])}
		for (period, unit), quantity in sorted(actual_totals.items())
	]
	expired_inventory = [
		{"period": period, "unit": unit, "quantity": _as_float(quantity), "cost": _as_float(expired_costs[(period, unit)])}
		for (period, unit), quantity in sorted(expired_totals.items())
	]
	imported = [
		{"period": period, "unit": unit, "quantity": _as_float(quantity), "cost": None}
		for (period, unit), quantity in sorted(history_totals.items())
	]
	return WasteTrendResponse(
		start_date=start,
		end_date=end,
		granularity=granularity,
		actual_record_count=len(actual_rows),
		actual=actual,
		expired_inventory=expired_inventory,
		imported_history=imported,
		imported_history_status=DataAvailability(
			status="available" if history_source_available else "unavailable",
			message=history_message,
			source=history_source,
		),
		units=sorted({point["unit"] for point in actual + expired_inventory + imported}),
	)


@router.get("/expiry-alerts", response_model=list[ExpiryAlert])
def expiry_alerts(
	_: User = Depends(get_current_user),
	db: Session = Depends(get_db),
	within_days: int = Query(default=7, ge=0, le=365),
	limit: int = Query(default=100, ge=1, le=500),
) -> list[ExpiryAlert]:
	today = date.today()
	csv_data = load_dashboard_csv_data()
	rows = _application_expiry_rows(db, today, within_days, limit)
	application_ml = {}
	if rows:
		try:
			application_ml = {
				prediction["batch_id"]: prediction
				for prediction in predict_expiry_batches(db, [row[0] for row in rows])
			}
		except (FileNotFoundError, ImportError, OSError, RuntimeError, ValueError, TypeError) as exc:
			logger.warning("Expiry model is unavailable for dashboard alerts; using date rules: %s", exc)
	alerts: list[ExpiryAlert] = []
	for batch_id, product_id, batch_code, expiry_date, expiry_date_source, quantity_remaining, product_name, category, unit in rows:
		days = (expiry_date - today).days
		status = "expired" if days < 0 else "expiring_soon"
		ml_prediction = application_ml.get(batch_id)
		risk = "high" if days <= 3 else "medium" if days <= within_days else "low"
		if ml_prediction:
			risk = ml_prediction["ml_risk"].lower().replace(" risk", "")
		alerts.append(
			ExpiryAlert(
				source="application",
				batch_id=batch_id,
				product_id=product_id,
				product_name=product_name,
				category=category,
				unit=unit,
				batch_code=batch_code,
				expiry_date=expiry_date,
				expiry_date_source=expiry_date_source,
				snapshot_date=None,
				days_to_expiry=days,
				quantity_remaining=_as_float(quantity_remaining),
				status=status,
				risk=risk,
				ml_risk=ml_prediction["ml_risk"] if ml_prediction else None,
				risk_probability=ml_prediction["risk_probability"] if ml_prediction else None,
				predicted_class=ml_prediction["predicted_class"] if ml_prediction else None,
				rule_status=ml_prediction["rule_status"] if ml_prediction else status,
				recommendation_source=ml_prediction["recommendation_source"] if ml_prediction else "date_rule",
			)
		)
	snapshot_alerts = _snapshot_expiry_alerts(csv_data, today, within_days)
	return alerts[:limit] + snapshot_alerts[: max(0, limit - len(alerts[:limit]))]


@router.get("/recommendations", response_model=list[DashboardRecommendation])
def dashboard_recommendations(_ : User = Depends(get_current_user), db: Session = Depends(get_db), limit: int = Query(default=5, ge=1, le=100)) -> list[DashboardRecommendation]:
    return [DashboardRecommendation(**row) for row in generate_operational_recommendations(db, limit)]
@router.get("/top-products", response_model=list[TopProduct])
def top_products(
	_: User = Depends(get_current_user),
	db: Session = Depends(get_db),
	start_date: date | None = None,
	end_date: date | None = None,
	limit: int = Query(default=5, ge=1, le=50),
) -> list[TopProduct]:
	start, end = _date_range(start_date, end_date)
	csv_data = load_dashboard_csv_data()
	rows = db.execute(
		select(Product.product_id, Product.name, Product.category, Product.unit, func.sum(SaleRecord.quantity), func.sum(SaleRecord.total_amount))
		.join(SaleRecord, SaleRecord.product_id == Product.product_id)
		.where(_activity_date_filter(SaleRecord.sold_at, start, end))
		.group_by(Product.product_id, Product.name, Product.category, Product.unit)
		.order_by(func.sum(SaleRecord.quantity).desc(), Product.product_id)
		.limit(limit)
	).all()
	actual = [
		TopProduct(
			source="application",
			product_id=row[0],
			product_name=row[1],
			category=row[2],
			unit=row[3],
			quantity_sold=_as_float(row[4]),
			revenue=_as_float(row[5]),
		)
		for row in rows
	]
	if len(actual) >= limit:
		return actual[:limit]
	database_history_available = _import_table_available(db, DashboardHistoricalMetric.__tablename__)
	database_history_rows = (
		db.execute(
			select(
				Product.product_id,
				Product.name,
				Product.category,
				Product.unit,
				func.sum(DashboardHistoricalMetric.sales_quantity),
			)
			.join(Product, Product.product_id == DashboardHistoricalMetric.product_id)
			.where(
				DashboardHistoricalMetric.business_date >= start,
				DashboardHistoricalMetric.business_date <= end,
			)
			.group_by(Product.product_id, Product.name, Product.category, Product.unit)
			.order_by(func.sum(DashboardHistoricalMetric.sales_quantity).desc())
		).all()
		if database_history_available
		else []
	)
	training = []
	if database_history_rows:
		training = [
			TopProduct(
				source="training_history",
				product_id=row[0],
				product_name=row[1],
				category=row[2],
				unit=row[3],
				quantity_sold=_as_float(row[4]),
				revenue=None,
			)
			for row in database_history_rows[:limit]
		]
	else:
		products_by_source_id = {product.source_id: product for product in csv_data.catalog_products}
		history: dict[str, Decimal] = defaultdict(lambda: _ZERO)
		for row in csv_data.sales_history:
			if start <= row.business_date <= end:
				history[row.product_source_id] += row.sales_quantity
		training = [
			TopProduct(
				source="training_history",
				product_id=int(source_id),
				product_name=products_by_source_id[source_id].name,
				category=products_by_source_id[source_id].category,
				unit=products_by_source_id[source_id].unit,
				quantity_sold=_as_float(quantity),
				revenue=None,
			)
			for source_id, quantity in sorted(history.items(), key=lambda item: item[1], reverse=True)[:limit]
		]
	return actual[:limit] + training[: max(0, limit - len(actual))]


@router.get("/low-stock", response_model=list[LowStockProduct])
def low_stock(
	_: User = Depends(get_current_user),
	db: Session = Depends(get_db),
	reorder_level: Decimal = Query(default=Decimal("10"), ge=0, le=1000000),
	limit: int = Query(default=5, ge=1, le=100),
) -> list[LowStockProduct]:
	csv_data = load_dashboard_csv_data()
	stock_join = and_(
		InventoryBatch.product_id == Product.product_id,
		InventoryBatch.status == "active",
		InventoryBatch.quantity_remaining > 0,
		InventoryBatch.expiry_date >= date.today(),
	)
	quantity = func.coalesce(func.sum(InventoryBatch.quantity_remaining), 0)
	rows = db.execute(
		select(Product.product_id, Product.name, Product.category, Product.unit, quantity)
		.outerjoin(InventoryBatch, stock_join)
		.group_by(Product.product_id, Product.name, Product.category, Product.unit)
		.having(quantity <= reorder_level)
		.order_by(quantity, Product.name)
		.limit(limit)
	).all()
	actual = [
		LowStockProduct(
			source="application",
			product_id=row[0],
			product_name=row[1],
			category=row[2],
			unit=row[3],
			current_stock=_as_float(row[4]),
			reorder_level=float(reorder_level),
			snapshot_date=None,
		)
		for row in rows
	]
	products_by_source_id = {int(product.source_id): product for product in csv_data.catalog_products}
	snapshot_examples = []
	for snapshot in csv_data.inventory_snapshots:
		if (
			snapshot.snapshot_date > date.today()
			or snapshot.expiry_date < snapshot.snapshot_date
			or snapshot.quantity_remaining <= 0
			or snapshot.quantity_remaining > reorder_level
		):
			continue
		product_id = int(snapshot.product_source_id)
		snapshot_examples.append(
			LowStockProduct(
				source="inventory_snapshot",
				product_id=product_id,
				product_name=products_by_source_id[product_id].name,
				category=snapshot.category or products_by_source_id[product_id].category,
				unit=products_by_source_id[product_id].unit,
				current_stock=_as_float(snapshot.quantity_remaining),
				reorder_level=float(reorder_level),
				snapshot_date=snapshot.snapshot_date,
			)
		)
	snapshot_examples.sort(key=lambda item: (-(item.snapshot_date or date.min).toordinal(), item.current_stock, item.product_id))
	return actual[:limit] + snapshot_examples[: max(0, limit - len(actual[:limit]))]


@router.get("/recent-activities", response_model=list[RecentActivity])
def recent_activities(
	user: User = Depends(get_current_user),
	db: Session = Depends(get_db),
	limit: int = Query(default=5, ge=1, le=100),
) -> list[RecentActivity]:
	query = (
		select(UserActivity, User.full_name)
		.outerjoin(User, User.user_id == UserActivity.user_id)
	)
	scope = activity_scope(user)
	if scope is not None:
		query = query.where(scope)
	rows = db.execute(query.order_by(UserActivity.created_at.desc(), UserActivity.activity_id.desc()).limit(limit)).all()
	return [
		RecentActivity(
			activity_id=activity.activity_id,
			action=activity.action,
			entity_type=activity.entity_type,
			entity_id=activity.entity_id,
			actor_name=actor_name,
			created_at=activity.created_at,
		)
		for activity, actor_name in rows
	]
