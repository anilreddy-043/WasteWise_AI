from datetime import date, datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from uuid import uuid4
import logging
import random

from fastapi import HTTPException
from sqlalchemy import inspect, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, load_only

from app.models.inventory import InventoryBatch
from app.models.prediction import Recommendation
from app.models.product import Product
from app.models.sales import SaleRecord, SalesTransaction, SalesTransactionBatch, SalesTransactionItem
from app.models.user import User
from app.models.waste import UserActivity
from app.schemas import CheckoutRequest, TransactionResponse

logger = logging.getLogger(__name__)



def _money(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _transaction_number(db: Session) -> str:
    timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
    return f"WW-{timestamp}-{uuid4().hex[:12].upper()}"


def _rollback(db: Session) -> None:
    db.rollback()


def checkout_sale(db: Session, user: User, payload: CheckoutRequest) -> TransactionResponse:
    if user.role not in {"admin", "store_manager", "staff"}:
        raise HTTPException(status_code=403, detail="Your role cannot process sales.")

    try:
        existing = db.scalar(select(SalesTransaction).where(SalesTransaction.idempotency_key == payload.idempotency_key))
        if existing is not None:
            return TransactionResponse.model_validate(
                get_checkout_transaction(db, existing.sale_transaction_id)
            )

        product_ids = [item.product_id for item in payload.items]
        products = list(db.scalars(select(Product).where(Product.product_id.in_(product_ids))))
        products_by_id = {product.product_id: product for product in products}
        missing = sorted(set(product_ids) - set(products_by_id))
        if missing:
            raise HTTPException(status_code=404, detail=f"Products not found: {missing}.")

        subtotal = Decimal("0")
        for item in payload.items:
            subtotal += _money(Decimal(str(products_by_id[item.product_id].price)) * item.quantity)
        subtotal = _money(subtotal)

        discount_type = payload.discount.type
        discount_value = _money(payload.discount.value)
        if discount_type == "none":
            discount_value = Decimal("0")
            discount_amount = Decimal("0")
        elif discount_type == "percentage":
            discount_amount = _money(min(subtotal, subtotal * discount_value / Decimal("100")))
        else:
            discount_amount = _money(min(subtotal, discount_value))
        if discount_amount > subtotal:
            raise HTTPException(status_code=422, detail="Discount cannot exceed the subtotal.")

        allocations: dict[int, list[tuple[InventoryBatch, Decimal]]] = {}
        for item in payload.items:
            remaining_needed = item.quantity
            batches = list(db.scalars(
                select(InventoryBatch)
                .options(load_only(
                    InventoryBatch.batch_id,
                    InventoryBatch.product_id,
                    InventoryBatch.quantity_remaining,
                    InventoryBatch.expiry_date,
                    InventoryBatch.status,
                ))
                .where(
                    InventoryBatch.product_id == item.product_id,
                    InventoryBatch.status == "active",
                    InventoryBatch.expiry_date >= date.today(),
                    InventoryBatch.quantity_remaining > 0,
                )
                .order_by(InventoryBatch.expiry_date.asc(), InventoryBatch.batch_id.asc())
                .with_for_update()
            ))
            product_allocations: list[tuple[InventoryBatch, Decimal]] = []
            for batch in batches:
                if remaining_needed <= 0:
                    break
                allocated = min(remaining_needed, batch.quantity_remaining)
                product_allocations.append((batch, allocated))
                remaining_needed -= allocated
            if remaining_needed > 0:
                product = products_by_id[item.product_id]
                raise HTTPException(status_code=409, detail=f"Insufficient stock for {product.name}; {remaining_needed} {product.unit} unavailable.")
            allocations[item.product_id] = product_allocations

        approved_batch_discounts = {
            recommendation.batch_id: Decimal(str(recommendation.discount_percent))
            for recommendation in db.scalars(
                select(Recommendation).where(
                    Recommendation.status == "approved",
                    Recommendation.recommendation_type == "discount",
                    Recommendation.batch_id.is_not(None),
                    Recommendation.discount_percent.is_not(None),
                )
            ).all()
            if recommendation.batch_id is not None and recommendation.discount_percent is not None
        }
        automatic_line_discounts: list[Decimal] = []
        for item in payload.items:
            product = products_by_id[item.product_id]
            automatic_discount = Decimal("0")
            for batch, allocated in allocations[item.product_id]:
                discount_percent = approved_batch_discounts.get(batch.batch_id)
                if discount_percent is not None:
                    allocation_subtotal = _money(Decimal(str(product.price)) * allocated)
                    automatic_discount += _money(allocation_subtotal * discount_percent / Decimal("100"))
            automatic_line_discounts.append(automatic_discount)

        discount_amount += sum(automatic_line_discounts, Decimal("0"))
        discount_amount = min(subtotal, _money(discount_amount))
        if discount_type == "none" and discount_amount > 0:
            discount_type = "percentage"
            discount_value = _money(discount_amount * Decimal("100") / subtotal) if subtotal else Decimal("0")
        total_amount = _money(subtotal - discount_amount)

        transaction = SalesTransaction(
            transaction_number=_transaction_number(db),
            subtotal=subtotal,
            discount_type=discount_type,
            discount_value=discount_value,
            discount_amount=discount_amount,
            total_amount=total_amount,
            payment_method=payload.payment_method,
            customer_name=payload.customer_name,
            customer_phone=payload.customer_phone,
            sold_at=datetime.now(timezone.utc).replace(tzinfo=None),
            processed_by=user.user_id,
            status="completed",
            idempotency_key=payload.idempotency_key,
        )
        db.add(transaction)
        db.flush()

        remaining_discount = discount_amount
        for index, item in enumerate(payload.items):
            product = products_by_id[item.product_id]
            unit_price = _money(Decimal(str(product.price)))
            line_subtotal = _money(unit_price * item.quantity)
            if index == len(payload.items) - 1:
                line_discount = remaining_discount
            else:
                proportional_discount = _money(discount_amount * line_subtotal / subtotal) if subtotal else Decimal("0")
                line_discount = min(line_subtotal, remaining_discount, proportional_discount)
                remaining_discount -= line_discount
            line_discount = min(line_discount, line_subtotal)
            line_total = _money(line_subtotal - line_discount)
            transaction_item = SalesTransactionItem(
                sale_transaction_id=transaction.sale_transaction_id,
                product_id=item.product_id,
                quantity=item.quantity,
                unit_price=unit_price,
                line_subtotal=line_subtotal,
                discount_amount=line_discount,
                line_total=line_total,
            )
            db.add(transaction_item)
            db.flush()

            batch_allocations = allocations[item.product_id]
            remaining_batch_discount = line_discount
            for allocation_index, (batch, allocated) in enumerate(batch_allocations):
                allocation_subtotal = _money(unit_price * allocated)
                if allocation_index == len(batch_allocations) - 1:
                    allocation_discount = remaining_batch_discount
                else:
                    allocation_discount = (
                        _money(line_discount * allocation_subtotal / line_subtotal)
                        if line_subtotal else Decimal("0")
                    )
                    allocation_discount = min(
                        allocation_discount,
                        remaining_batch_discount,
                        allocation_subtotal,
                    )
                    remaining_batch_discount -= allocation_discount
                db.add(SalesTransactionBatch(
                    sale_item_id=transaction_item.sale_item_id,
                    batch_id=batch.batch_id,
                    product_id=item.product_id,
                    quantity_allocated=allocated,
                ))
                batch.quantity_remaining -= allocated
                if batch.quantity_remaining == 0:
                    batch.status = "depleted"
                db.add(SaleRecord(
                    product_id=item.product_id,
                    batch_id=batch.batch_id,
                    sold_at=transaction.sold_at,
                    quantity=allocated,
                    unit_price=unit_price,
                    total_amount=_money(allocation_subtotal - allocation_discount),
                    source="pos",
                ))

        db.add(UserActivity(
            user_id=user.user_id,
            action="pos_sale_completed",
            entity_type="sales_transaction",
            entity_id=transaction.sale_transaction_id,
            details={
                "transaction_number": transaction.transaction_number,
                "payment_method": payload.payment_method,
                "total_amount": str(total_amount),
                "item_count": len(payload.items),
            },
        ))
        db.flush()
        result = TransactionResponse.model_validate(
            get_checkout_transaction(db, transaction.sale_transaction_id)
        )
        db.commit()
        return result
    except IntegrityError as exc:
        _rollback(db)
        try:
            existing = db.scalar(select(SalesTransaction).where(SalesTransaction.idempotency_key == payload.idempotency_key))
            if existing is not None:
                return TransactionResponse.model_validate(
                    get_checkout_transaction(db, existing.sale_transaction_id)
                )
        except Exception as recovery_exc:
            _rollback(db)
            logger.exception("POS idempotency recovery failed after a database constraint error.")
            raise HTTPException(status_code=500, detail="The sale transaction could not be completed.") from recovery_exc
        raise HTTPException(status_code=409, detail="The sale could not be completed due to a database constraint.") from exc
    except HTTPException:
        _rollback(db)
        raise
    except Exception:
        _rollback(db)
        logger.exception("POS checkout failed before the transaction could be committed.")
        raise HTTPException(status_code=500, detail="The sale transaction could not be completed.") from None


def get_checkout_transaction(db: Session, sale_transaction_id: int) -> dict:
    transaction = db.get(SalesTransaction, sale_transaction_id)
    if transaction is None:
        raise HTTPException(status_code=404, detail="Sales transaction not found.")
    items = list(db.scalars(select(SalesTransactionItem).where(SalesTransactionItem.sale_transaction_id == sale_transaction_id).order_by(SalesTransactionItem.sale_item_id)))
    result_items = []
    for item in items:
        allocations = list(db.scalars(select(SalesTransactionBatch).where(SalesTransactionBatch.sale_item_id == item.sale_item_id).order_by(SalesTransactionBatch.allocation_id)))
        result_items.append({
            "sale_item_id": item.sale_item_id,
            "product_id": item.product_id,
            "quantity": item.quantity,
            "unit_price": item.unit_price,
            "line_subtotal": item.line_subtotal,
            "discount_amount": item.discount_amount,
            "line_total": item.line_total,
            "allocations": [{
                "allocation_id": allocation.allocation_id,
                "batch_id": allocation.batch_id,
                "product_id": allocation.product_id,
                "quantity_allocated": allocation.quantity_allocated,
            } for allocation in allocations],
        })
    return {
        "sale_transaction_id": transaction.sale_transaction_id,
        "transaction_number": transaction.transaction_number,
        "subtotal": transaction.subtotal,
        "discount_type": transaction.discount_type,
        "discount_value": transaction.discount_value,
        "discount_amount": transaction.discount_amount,
        "total_amount": transaction.total_amount,
        "payment_method": transaction.payment_method,
        "customer_name": getattr(transaction, "customer_name", None),
        "customer_phone": getattr(transaction, "customer_phone", None),
        "sold_at": transaction.sold_at,
        "processed_by": transaction.processed_by,
        "status": transaction.status,
        "idempotency_key": transaction.idempotency_key,
        "created_at": transaction.created_at,
        "updated_at": transaction.updated_at,
        "items": result_items,
    }


def list_checkout_transactions(db: Session, limit: int = 100, offset: int = 0) -> list[TransactionResponse]:
    transactions = list(db.scalars(
        select(SalesTransaction)
        .order_by(SalesTransaction.sold_at.desc(), SalesTransaction.sale_transaction_id.desc())
        .offset(offset)
        .limit(limit)
    ))
    if not transactions:
        return []

    transaction_ids = [transaction.sale_transaction_id for transaction in transactions]
    items = list(db.scalars(
        select(SalesTransactionItem)
        .where(SalesTransactionItem.sale_transaction_id.in_(transaction_ids))
        .order_by(SalesTransactionItem.sale_transaction_id, SalesTransactionItem.sale_item_id)
    ))
    item_ids = [item.sale_item_id for item in items]
    allocations = list(db.scalars(
        select(SalesTransactionBatch)
        .where(SalesTransactionBatch.sale_item_id.in_(item_ids))
        .order_by(SalesTransactionBatch.allocation_id)
    )) if item_ids else []

    allocations_by_item: dict[int, list[SalesTransactionBatch]] = {}
    for allocation in allocations:
        allocations_by_item.setdefault(allocation.sale_item_id, []).append(allocation)
    items_by_transaction: dict[int, list[dict]] = {}
    for item in items:
        items_by_transaction.setdefault(item.sale_transaction_id, []).append({
            "sale_item_id": item.sale_item_id,
            "product_id": item.product_id,
            "quantity": item.quantity,
            "unit_price": item.unit_price,
            "line_subtotal": item.line_subtotal,
            "discount_amount": item.discount_amount,
            "line_total": item.line_total,
            "allocations": [{
                "allocation_id": allocation.allocation_id,
                "batch_id": allocation.batch_id,
                "product_id": allocation.product_id,
                "quantity_allocated": allocation.quantity_allocated,
            } for allocation in allocations_by_item.get(item.sale_item_id, [])],
        })

    return [
        TransactionResponse.model_validate({
            "sale_transaction_id": transaction.sale_transaction_id,
            "transaction_number": transaction.transaction_number,
            "subtotal": transaction.subtotal,
            "discount_type": transaction.discount_type,
            "discount_value": transaction.discount_value,
            "discount_amount": transaction.discount_amount,
            "total_amount": transaction.total_amount,
            "payment_method": transaction.payment_method,
            "customer_name": getattr(transaction, "customer_name", None),
            "customer_phone": getattr(transaction, "customer_phone", None),
            "sold_at": transaction.sold_at,
            "processed_by": transaction.processed_by,
            "status": transaction.status,
            "idempotency_key": transaction.idempotency_key,
            "created_at": transaction.created_at,
            "updated_at": transaction.updated_at,
            "items": items_by_transaction.get(transaction.sale_transaction_id, []),
        })
        for transaction in transactions
    ]
