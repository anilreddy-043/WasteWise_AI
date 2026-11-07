import logging
from datetime import date, datetime, timedelta
from decimal import Decimal, ROUND_HALF_UP
from types import SimpleNamespace

from sqlalchemy import func, inspect, literal, select
from sqlalchemy.orm import Session

from app.models import DemandForecast, InventoryBatch, Product, Recommendation
from app.services.expiry_risk_service import predict_expiry_batches

MIN_DISCOUNT_PERCENT = Decimal("5")
MAX_DISCOUNT_PERCENT = Decimal("20")
logger = logging.getLogger(__name__)


def candidate_discounts() -> tuple[Decimal, ...]:
    return (Decimal("5"), Decimal("10"), Decimal("15"), Decimal("20"))


def discounted_price(current_price: Decimal, discount_percent: Decimal) -> Decimal:
    if current_price < 0:
        raise ValueError("Current price cannot be negative")
    if not MIN_DISCOUNT_PERCENT <= discount_percent <= MAX_DISCOUNT_PERCENT:
        raise ValueError("Discount percentage is outside configured limits")
    return (current_price * (Decimal("1") - discount_percent / Decimal("100"))).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )


def expiry_risk(days_to_expiry: int) -> str:
    if days_to_expiry < 0:
        return "expired"
    if days_to_expiry <= 3:
        return "high"
    if days_to_expiry <= 7:
        return "medium"
    if days_to_expiry <= 14:
        return "low"
    return "safe"


def recommend_discount(days_to_expiry: int, remaining_stock: Decimal) -> Decimal:
    if days_to_expiry < 0:
        raise ValueError("Expired products are not eligible")
    if remaining_stock <= 0:
        raise ValueError("Out-of-stock products are not eligible")

    risk = expiry_risk(days_to_expiry)
    if risk == "high":
        return Decimal("20") if days_to_expiry <= 1 else Decimal("15")
    if risk == "medium":
        return Decimal("10") if remaining_stock < 50 else Decimal("15")
    return Decimal("5")


def estimated_gross_margin(
    current_price: Decimal, unit_cost: Decimal | None, remaining_stock: Decimal, discount_percent: Decimal
) -> Decimal | None:
    if unit_cost is None or unit_cost < 0:
        return None
    if remaining_stock < 0:
        return None
    suggested_price = discounted_price(current_price, discount_percent)
    return ((suggested_price - unit_cost) * remaining_stock).quantize(Decimal("0.01"))


def recommendation_priority(days_to_expiry: int) -> str:
    return "High" if days_to_expiry <= 3 else "Medium" if days_to_expiry <= 7 else "Low"


def recommendation_reason(days_to_expiry: int, remaining_stock: Decimal) -> str:
    return (
        f"Rule-based discount for an inventory batch with {days_to_expiry} days to expiry "
        f"and {remaining_stock.quantize(Decimal('0.01'))} units remaining."
    )


def _priority(expiry_days: int | None, ml_risk: str | None, stock: Decimal, reorder_level: Decimal, predicted_demand: Decimal | None) -> str:
    if expiry_days is not None and expiry_days < 0:
        return "High"
    if ml_risk in {"High Risk", "High", "high"} or (expiry_days is not None and expiry_days <= 2):
        return "High"
    if stock <= reorder_level or (predicted_demand is not None and stock < predicted_demand * Decimal("2")):
        return "Medium"
    return "Low"


def generate_operational_recommendations(db: Session, limit: int = 100) -> list[dict]:
    """Combine live inventory, demand forecasts, expiry ML predictions, and rule-based discount logic."""
    today = date.today()
    products = list(db.scalars(select(Product).order_by(Product.product_id)).all())
    batch_columns = {
        column["name"] for column in inspect(db.get_bind()).get_columns(InventoryBatch.__tablename__)
    }
    expiry_date_source = (
        InventoryBatch.expiry_date_source
        if "expiry_date_source" in batch_columns
        else literal(None).label("expiry_date_source")
    )
    batch_result_rows = list(db.execute(
        select(
            InventoryBatch.batch_id,
            InventoryBatch.product_id,
            InventoryBatch.quantity_remaining,
            InventoryBatch.unit_cost,
            InventoryBatch.status,
            InventoryBatch.expiry_date,
            expiry_date_source,
            Product,
        )
        .join(Product, Product.product_id == InventoryBatch.product_id)
        .order_by(InventoryBatch.expiry_date.asc(), InventoryBatch.batch_id.asc())
    ).all())
    batch_rows = []
    for row in batch_result_rows:
        batch = SimpleNamespace(
            batch_id=row[0], product_id=row[1], quantity_remaining=row[2],
            unit_cost=row[3], status=row[4], expiry_date=row[5],
            expiry_date_source=row[6],
        )
        batch_rows.append((batch, row[7]))
    active_batch_ids = [
        batch.batch_id
        for batch, _ in batch_rows
        if float(batch.quantity_remaining) > 0
        and batch.status == "active"
        and (batch.expiry_date - today).days <= 14
    ]
    expiry_predictions = {}
    if active_batch_ids:
        try:
            expiry_predictions = {
                row["batch_id"]: row for row in predict_expiry_batches(db, active_batch_ids)
            }
        except (FileNotFoundError, ImportError, OSError, RuntimeError, ValueError, TypeError) as exc:
            logger.warning("Expiry model is unavailable; using date-based recommendation rules: %s", exc)

    stock_by_product: dict[int, Decimal] = {}
    for batch, _ in batch_rows:
        if batch.status == "active":
            stock_by_product[batch.product_id] = stock_by_product.get(batch.product_id, Decimal("0")) + Decimal(str(batch.quantity_remaining))

    forecast_end = today + timedelta(days=7)
    forecast_rows = (
        db.execute(
            select(DemandForecast.product_id, func.sum(DemandForecast.predicted_demand))
            .where(
                DemandForecast.product_id.in_([product.product_id for product in products]),
                DemandForecast.forecast_date >= today,
                DemandForecast.forecast_date <= forecast_end,
            )
            .group_by(DemandForecast.product_id)
        ).all()
        if products
        else []
    )
    demand_by_product = {
        product_id: Decimal(str(total))
        for product_id, total in forecast_rows
        if total is not None
    }

    recommendations: list[dict] = []
    persisted = db.execute(
        select(Recommendation, Product)
        .join(Product, Product.product_id == Recommendation.product_id)
        .where(Recommendation.status.in_(["pending", "approved", "ordered", "received", "rejected", "cancelled", "dismissed"]))
        .order_by(Recommendation.created_at.desc(), Recommendation.recommendation_id.desc())
    ).all()
    expiry_source_by_batch_id = {batch.batch_id: batch.expiry_date_source for batch, _ in batch_rows}
    for saved, product in persisted:
        recommendations.append({
            "source": "application", "recommendation_id": saved.recommendation_id,
            "product_id": product.product_id, "batch_id": saved.batch_id, "product_name": product.name,
            "product_category": product.category, "recommendation_type": saved.recommendation_type,
            "current_price": float(product.price),
            "suggested_price": float(Decimal(str(product.price)) * (Decimal("1") - Decimal(str(saved.discount_percent)) / Decimal("100"))) if saved.discount_percent is not None else None,
            "recommended_quantity": float(saved.recommended_quantity) if saved.recommended_quantity is not None else None,
            "discount_percent": float(saved.discount_percent) if saved.discount_percent is not None else None,
            "remaining_stock": float(stock_by_product.get(product.product_id, Decimal("0"))),
            "expiry_date_source": expiry_source_by_batch_id.get(saved.batch_id) if saved.batch_id is not None else None,
            "expiry_days": None, "expiry_risk": None,
            "predicted_demand": float(demand_by_product.get(product.product_id)) if product.product_id in demand_by_product else None,
            "priority": "Medium", "recommendation_method": "persisted_application_recommendation",
            "reason": saved.reason, "status": saved.status, "created_at": saved.created_at,
            "expected_impact": "Impact unavailable – insufficient verified cost or sales data.",
            "estimated_financial_impact": None,
        })
    for batch, product in batch_rows:
        stock = Decimal(str(batch.quantity_remaining))
        if stock <= 0:
            continue
        expiry_days = (batch.expiry_date - today).days
        ml = expiry_predictions.get(batch.batch_id, {})
        ml_risk = ml.get("ml_risk")
        predicted = demand_by_product.get(product.product_id)
        if batch.status == "expired" or expiry_days < 0:
            recommendations.append({
                "source": "application", "recommendation_id": None, "product_id": product.product_id,
                "batch_id": batch.batch_id, "product_name": product.name, "product_category": product.category,
                "recommendation_type": "remove", "current_price": float(product.price), "suggested_price": None,
                "recommended_quantity": float(stock), "discount_percent": None,
                "remaining_stock": float(stock), "expiry_days": expiry_days, "expiry_risk": ml_risk,
                "expiry_date_source": batch.expiry_date_source,
                "predicted_demand": float(predicted) if predicted is not None else None,
                "priority": "High", "recommendation_method": "date_rule_expired_batch",
                "reason": "Expired inventory must be removed and must not be sold.", "status": "pending",
                "created_at": datetime.now(), "expected_impact": "Impact unavailable – insufficient verified cost or sales data.",
                "estimated_financial_impact": None,
            })
            continue
        if 0 <= expiry_days <= 14 and batch.status == "active":
            discount = recommend_discount(expiry_days, stock)
            suggested = discounted_price(Decimal(str(product.price)), discount)
            unit_cost = Decimal(str(batch.unit_cost)) if batch.unit_cost is not None else None
            impact = estimated_gross_margin(Decimal(str(product.price)), unit_cost, stock, discount)
            recommendations.append({
                "source": "application", "recommendation_id": None, "product_id": product.product_id,
                "batch_id": batch.batch_id, "product_name": product.name, "product_category": product.category,
                "recommendation_type": "discount", "current_price": float(product.price), "suggested_price": float(suggested),
                "recommended_quantity": None, "discount_percent": float(discount), "remaining_stock": float(stock),
                "expiry_days": expiry_days, "expiry_risk": ml_risk or expiry_risk(expiry_days),
                "expiry_date_source": batch.expiry_date_source,
                "predicted_demand": float(predicted) if predicted is not None else None,
                "priority": _priority(expiry_days, ml_risk, stock, Decimal("10"), predicted),
                "recommendation_method": "rule_based_constrained_discount",
                "reason": recommendation_reason(expiry_days, stock), "status": "pending", "created_at": datetime.now(),
                "expected_impact": f"Estimated inventory margin impact: {impact}" if impact is not None else "Waste reduction action; financial impact unavailable without valid cost.",
                "estimated_financial_impact": float(impact) if impact is not None else None,
            })

    seen: set[int] = set()
    for product in products:
        stock = stock_by_product.get(product.product_id, Decimal("0"))
        predicted = demand_by_product.get(product.product_id)
        if predicted is None or stock >= predicted:
            seen.add(product.product_id)
            continue
        reorder_level = Decimal("10")
        shortage = max(predicted - stock, Decimal("0"))
        if stock <= reorder_level:
            recommendation_type = "reorder"
            action = f"Place reorder for {shortage.quantize(Decimal('0.001'))} units."
        else:
            recommendation_type = "restock"
            action = f"Plan stock replenishment for {shortage.quantize(Decimal('0.001'))} units."
        recommendations.append({
            "source": "application", "recommendation_id": None, "product_id": product.product_id,
            "batch_id": None, "product_name": product.name, "product_category": product.category,
            "recommendation_type": recommendation_type, "current_price": float(product.price), "suggested_price": None,
            "recommended_quantity": float(shortage), "discount_percent": None, "remaining_stock": float(stock),
            "expiry_days": None, "expiry_risk": None, "predicted_demand": float(predicted),
            "priority": _priority(None, None, stock, reorder_level, predicted), "recommendation_method": "demand_forecast_inventory_rule",
            "reason": action, "status": "pending", "created_at": datetime.now(),
            "expected_impact": "Reduce the risk of stock shortage using verified demand forecasts.",
            "estimated_financial_impact": None,
        })
        seen.add(product.product_id)

    for row in recommendations:
        row.setdefault("source_information", "Live MySQL inventory and batch data; demand and expiry signals are included when available.")
        row.setdefault("generated_at", row.get("created_at") or datetime.now())
        row.setdefault("predicted_demand", None)
        row.setdefault("expiry_risk", None)
    recommendations.sort(key=lambda row: (0 if row["priority"] == "High" else 1 if row["priority"] == "Medium" else 2, row["product_id"]))
    return recommendations[:limit]
