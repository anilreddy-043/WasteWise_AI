import csv
import io
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import func, select
from sqlalchemy import inspect as sqlalchemy_inspect
from sqlalchemy.orm import Session

from app.models import InventoryBatch, Product, UserActivity

CSV_COLUMNS = (
    "product_name",
    "sku",
    "category",
    "unit",
    "price",
    "batch_code",
    "quantity_received",
    "quantity_remaining",
    "unit_cost",
    "received_at",
    "expiry_date",
    "location",
    "supplier",
)
_HEADER_ALIASES = {
    "product": "product_name",
    "name": "product_name",
    "batch_number": "batch_code",
    "batch_no": "batch_code",
    "manufacturing_date": "received_at",
    "manufacture_date": "received_at",
    "received_date": "received_at",
    "quantity": "quantity_received",
    "remaining_quantity": "quantity_remaining",
    "cost": "unit_cost",
}
_PRODUCT_FIELDS = ("product_name", "sku", "category", "unit", "price", "supplier")
_MAX_ROWS = 5000


def _normalize_header(value: str) -> str:
    normalized = "_".join(value.strip().casefold().replace("-", " ").split())
    return _HEADER_ALIASES.get(normalized, normalized)


def _parse_decimal(value: str, field: str, places: int, *, required: bool = True) -> Decimal | None:
    if not value.strip():
        if required:
            raise ValueError(f"{field.replace('_', ' ')} is required.")
        return None
    try:
        parsed = Decimal(value.strip())
    except InvalidOperation as exc:
        raise ValueError(f"{field.replace('_', ' ')} must be numeric.") from exc
    if not parsed.is_finite() or parsed < 0:
        raise ValueError(f"{field.replace('_', ' ')} must be a finite, nonnegative number.")
    if parsed.as_tuple().exponent < -places:
        raise ValueError(f"{field.replace('_', ' ')} supports at most {places} decimal places.")
    return parsed


def _parse_date(value: str, field: str) -> date:
    try:
        parsed = date.fromisoformat(value.strip())
    except ValueError as exc:
        raise ValueError(f"{field.replace('_', ' ')} must use YYYY-MM-DD format.") from exc
    if parsed.isoformat() != value.strip():
        raise ValueError(f"{field.replace('_', ' ')} must use YYYY-MM-DD format.")
    return parsed


def _product_signature(values: dict[str, str]) -> tuple[str, str, str, str, str]:
    return (
        values["product_name"].strip().casefold(),
        values["category"].strip().casefold(),
        values["unit"].strip().casefold(),
        values["price"].strip(),
        values["supplier"].strip().casefold(),
    )


def _read_csv(csv_text: str) -> list[dict[str, Any]]:
    try:
        reader = csv.reader(io.StringIO(csv_text, newline=""), strict=True)
        header = next(reader, None)
        if not header:
            raise ValueError("CSV is empty.")
        normalized_headers = [_normalize_header(value.lstrip("\ufeff")) for value in header]
        if len(normalized_headers) != len(set(normalized_headers)):
            raise ValueError("CSV contains duplicate columns after normalizing the header names.")
        fields = set(normalized_headers)
        missing = {"product_name", "batch_code", "quantity_received", "received_at", "expiry_date", "location"} - fields
        if missing:
            raise ValueError(f"CSV is missing required columns: {', '.join(sorted(missing))}.")

        rows: list[dict[str, Any]] = []
        for row_number, raw in enumerate(reader, start=2):
            if len(rows) >= _MAX_ROWS:
                raise ValueError(f"CSV exceeds the {_MAX_ROWS} row import limit.")
            if len(raw) != len(normalized_headers):
                values = {
                    column: raw[index].strip() if index < len(raw) else ""
                    for index, column in enumerate(normalized_headers)
                }
                rows.append({
                    "row_number": row_number,
                    "values": values,
                    "errors": ["Row has a different number of values than the CSV header."],
                    "product_status": "invalid",
                    "matched_product": None,
                    "can_create_product": False,
                })
                continue
            values = {column: raw[index].strip() for index, column in enumerate(normalized_headers)}
            rows.append({
                "row_number": row_number,
                "values": {column: values.get(column, "") for column in CSV_COLUMNS},
                "errors": [],
                "product_status": "unmatched",
                "matched_product": None,
                "can_create_product": False,
            })
        if not rows:
            raise ValueError("CSV contains no batch records.")
        return rows
    except csv.Error as exc:
        raise ValueError(f"CSV could not be parsed: {exc}") from exc


def _match_product(db: Session, values: dict[str, str], *, lock: bool = False) -> tuple[Product | None, str | None]:
    sku = values.get("sku", "").strip()
    name = values.get("product_name", "").strip()
    statement = select(Product)
    if lock:
        statement = statement.with_for_update()
    if sku:
        by_sku = list(db.scalars(statement.where(func.lower(Product.sku) == sku.casefold())).all())
        if len(by_sku) > 1:
            return None, "SKU matches multiple products."
        if by_sku:
            return by_sku[0], "sku"
    if name:
        by_name = list(db.scalars(statement.where(func.lower(Product.name) == name.casefold())).all())
        if len(by_name) > 1:
            return None, "Product name matches multiple products; use a unique SKU."
        if by_name:
            return by_name[0], "name"
    return None, None


def _validate_rows(db: Session, rows: list[dict[str, Any]], *, lock_products: bool = False) -> None:
    products_by_row: dict[int, Product] = {}
    seen_skus: dict[str, tuple[tuple[str, str, str, str, str], list[dict[str, Any]]]] = {}
    seen_names: dict[str, tuple[str, list[dict[str, Any]]]] = {}

    for row in rows:
        values = row["values"]
        errors: list[str] = row["errors"]
        for field in ("product_name", "batch_code", "received_at", "expiry_date", "location"):
            if not values.get(field, "").strip():
                errors.append(f"{field.replace('_', ' ').capitalize()} is required.")
        if len(values.get("product_name", "")) > 160:
            errors.append("Product name must be 160 characters or fewer.")
        if len(values.get("sku", "")) > 64:
            errors.append("SKU must be 64 characters or fewer.")
        if len(values.get("category", "")) > 80:
            errors.append("Category must be 80 characters or fewer.")
        if len(values.get("unit", "")) > 32:
            errors.append("Unit must be 32 characters or fewer.")
        if len(values.get("batch_code", "")) > 64:
            errors.append("Batch number must be 64 characters or fewer.")
        if len(values.get("location", "")) > 120:
            errors.append("Location must be 120 characters or fewer.")
        if len(values.get("supplier", "")) > 160:
            errors.append("Supplier must be 160 characters or fewer.")

        try:
            quantity = _parse_decimal(values.get("quantity_received", ""), "quantity_received", 3)
            if quantity is not None and quantity <= 0:
                errors.append("Quantity received must be greater than zero.")
        except ValueError as exc:
            errors.append(str(exc))
            quantity = None
        try:
            remaining = _parse_decimal(values.get("quantity_remaining", ""), "quantity_remaining", 3, required=False)
            if remaining is not None and quantity is not None and remaining > quantity:
                errors.append("Remaining quantity cannot exceed quantity received.")
        except ValueError as exc:
            errors.append(str(exc))
        try:
            _parse_decimal(values.get("unit_cost", ""), "unit_cost", 2, required=False)
        except ValueError as exc:
            errors.append(str(exc))
        try:
            _parse_decimal(values.get("price", ""), "price", 2, required=False)
        except ValueError as exc:
            errors.append(str(exc))

        received_at = expiry_date = None
        try:
            if values.get("received_at", "").strip():
                received_at = _parse_date(values["received_at"], "manufacturing date")
        except ValueError as exc:
            errors.append(str(exc))
        try:
            if values.get("expiry_date", "").strip():
                expiry_date = _parse_date(values["expiry_date"], "expiry date")
        except ValueError as exc:
            errors.append(str(exc))
        if received_at is not None and expiry_date is not None and expiry_date < received_at:
            errors.append("Expiry date cannot be before manufacturing/received date.")

        sku = values.get("sku", "").strip()
        name = values.get("product_name", "").strip()
        if sku and name:
            signature = _product_signature(values)
            previous = seen_skus.get(sku.casefold())
            if previous is None:
                seen_skus[sku.casefold()] = (signature, [row])
            else:
                previous[1].append(row)
                if previous[0] != signature:
                    for conflicting_row in previous[1]:
                        message = "This SKU has conflicting product details elsewhere in the CSV."
                        if message not in conflicting_row["errors"]:
                            conflicting_row["errors"].append(message)

        product, match_method = _match_product(db, values, lock=lock_products)
        if product is not None:
            products_by_row[row["row_number"]] = product
            row["matched_product"] = {
                "product_id": product.product_id,
                "name": product.name,
                "sku": product.sku,
            }
            row["product_status"] = f"matched_by_{match_method}"
        else:
            row["product_status"] = "missing"
            if match_method:
                errors.append(match_method)
            product_fields_valid = True
            for field in _PRODUCT_FIELDS:
                if not values.get(field, "").strip():
                    product_fields_valid = False
            if not values.get("sku", "").strip():
                product_fields_valid = False
                if "SKU is required to create a missing product." not in errors:
                    errors.append("SKU is required to create a missing product.")
            try:
                price = _parse_decimal(values.get("price", ""), "price", 2)
                if price is None:
                    product_fields_valid = False
            except ValueError as exc:
                errors.append(str(exc))
                product_fields_valid = False
            for field in ("category", "unit", "supplier"):
                if not values.get(field, "").strip() and f"{field.capitalize()} is required to create a missing product." not in errors:
                    errors.append(f"{field.capitalize()} is required to create a missing product.")
            if not name and "Product name is required." not in errors:
                errors.append("Product name is required.")
            row["can_create_product"] = product_fields_valid
            same_name = seen_names.get(name.casefold()) if name else None
            if same_name and sku and same_name[0] != sku.casefold():
                for conflicting_row in same_name[1]:
                    message = "This product name has conflicting SKUs elsewhere in the CSV."
                    if message not in conflicting_row["errors"]:
                        conflicting_row["errors"].append(message)
            elif name and sku:
                if same_name is None:
                    seen_names[name.casefold()] = (sku.casefold(), [row])
                else:
                    same_name[1].append(row)

        if product is not None and values.get("sku", "").strip():
            sku_owner, _ = _match_product(db, {"sku": sku, "product_name": ""}, lock=lock_products)
            if sku_owner is not None and sku_owner.product_id != product.product_id:
                errors.append("SKU belongs to a different product than the matched product name.")

    batch_keys: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for row in rows:
        values = row["values"]
        product = products_by_row.get(row["row_number"])
        sku_key = values.get("sku", "").casefold()
        product_key = str(product.product_id) if product is not None else f"new:{sku_key or values.get('product_name', '').casefold()}"
        batch_code = values.get("batch_code", "").casefold()
        if not batch_code:
            continue
        key = (product_key, batch_code)
        batch_keys.setdefault(key, []).append(row)
        if product is not None and db.scalar(
            select(InventoryBatch.batch_id).where(
                InventoryBatch.product_id == product.product_id,
                func.lower(InventoryBatch.batch_code) == batch_code,
            )
        ) is not None:
            row["errors"].append("This batch number already exists for the matched product.")
    for duplicate_rows in batch_keys.values():
        if len(duplicate_rows) > 1:
            row_numbers = ", ".join(str(row["row_number"]) for row in duplicate_rows)
            for row in duplicate_rows:
                row["errors"].append(f"Duplicate batch number in this CSV (rows {row_numbers}).")


def preview_inventory_batches_csv(db: Session, csv_text: str) -> dict[str, Any]:
    rows = _read_csv(csv_text)
    _validate_rows(db, rows)
    invalid_count = sum(bool(row["errors"]) for row in rows)
    missing_count = sum(row["product_status"] == "missing" for row in rows)
    return {
        "row_count": len(rows),
        "valid_count": len(rows) - invalid_count,
        "invalid_count": invalid_count,
        "missing_product_count": missing_count,
        "rows": rows,
    }


def confirm_inventory_batches_csv(
    db: Session,
    csv_text: str,
    user_id: int,
    import_id: str,
    create_missing_products: bool,
    source_filename: str | None = None,
) -> dict[str, Any]:
    try:
        previous_import = db.scalar(
            select(UserActivity.activity_id).where(
                UserActivity.action == "batch_csv_imported",
                UserActivity.entity_type == "inventory_batch_import",
                UserActivity.details["import_id"].as_string() == import_id,
            ).limit(1)
        )
        if previous_import is not None:
            raise ValueError("This import confirmation has already completed.")

        rows = _read_csv(csv_text)
        _validate_rows(db, rows, lock_products=True)
        invalid_rows = [row for row in rows if row["errors"]]
        if invalid_rows:
            raise ValueError("CSV contains invalid rows. Review the preview and resolve every error.")
        missing_products = [row for row in rows if row["product_status"] == "missing"]
        if missing_products and not create_missing_products:
            raise ValueError("Confirm creation of the missing products before importing these batches.")
        if any(not row["can_create_product"] for row in missing_products):
            raise ValueError("Missing products need complete product details before they can be created.")

        has_expiry_source = "expiry_date_source" in {
            column["name"]
            for column in sqlalchemy_inspect(db.connection()).get_columns(InventoryBatch.__tablename__)
        }
        product_for_row: dict[int, Product] = {}
        products_created: dict[str, Product] = {}
        for row in rows:
            values = row["values"]
            matched, _ = _match_product(db, values, lock=True)
            if matched is None:
                sku_key = values["sku"].casefold()
                matched = products_created.get(sku_key)
                if matched is None:
                    matched = Product(
                        name=values["product_name"],
                        category=values["category"],
                        sku=values["sku"],
                        unit=values["unit"],
                        price=_parse_decimal(values["price"], "price", 2),
                        supplier=values["supplier"],
                    )
                    db.add(matched)
                    db.flush()
                    products_created[sku_key] = matched
            product_for_row[row["row_number"]] = matched

        inserted: list[InventoryBatch] = []
        for row in rows:
            values = row["values"]
            product = product_for_row[row["row_number"]]
            received_at = _parse_date(values["received_at"], "manufacturing date")
            expiry_date = _parse_date(values["expiry_date"], "expiry date")
            quantity_received = _parse_decimal(values["quantity_received"], "quantity_received", 3)
            quantity_remaining = _parse_decimal(values["quantity_remaining"], "quantity_remaining", 3, required=False)
            unit_cost = _parse_decimal(values["unit_cost"], "unit_cost", 2, required=False)
            batch_values = {
                "product_id": product.product_id,
                "batch_code": values["batch_code"],
                "quantity_received": quantity_received,
                "quantity_remaining": quantity_received if quantity_remaining is None else quantity_remaining,
                "unit_cost": Decimal("0") if unit_cost is None else unit_cost,
                "received_at": received_at,
                "expiry_date": expiry_date,
                "status": "depleted" if quantity_remaining == 0 else "active",
                "location": values["location"],
                "supplier": values["supplier"] or product.supplier,
            }
            # Older deployments may not yet have the nullable provenance column.
            if has_expiry_source:
                batch_values["expiry_date_source"] = "imported"
            insert_result = db.execute(InventoryBatch.__table__.insert().values(**batch_values))
            batch = InventoryBatch(**batch_values)
            batch.batch_id = int(insert_result.inserted_primary_key[0])
            batch.created_at = datetime.now()
            batch.expiry_date_source = "imported" if "expiry_date_source" in batch_values else None
            db.add(UserActivity(
                user_id=user_id,
                action="batch_imported",
                entity_type="inventory_batch",
                entity_id=batch.batch_id,
                details={"import_id": import_id, "expiry_date_source": batch.expiry_date_source},
            ))
            inserted.append(batch)

        db.add(UserActivity(
            user_id=user_id,
            action="batch_csv_imported",
            entity_type="inventory_batch_import",
            details={
                "import_id": import_id,
                "row_count": len(rows),
                "inserted": len(inserted),
                "products_created": len(products_created),
                "source_filename": source_filename,
                "source_sha256": import_id,
                "provenance": "operational_csv_import",
            },
        ))
        db.commit()
        return {
            "import_id": import_id,
            "inserted": len(inserted),
            "products_created": len(products_created),
            "batches": inserted,
        }
    except Exception:
        db.rollback()
        raise


def list_inventory_batch_imports(db: Session, limit: int = 50) -> list[dict[str, Any]]:
    events = db.scalars(
        select(UserActivity)
        .where(
            UserActivity.action == "batch_csv_imported",
            UserActivity.entity_type == "inventory_batch_import",
        )
        .order_by(UserActivity.created_at.desc(), UserActivity.activity_id.desc())
        .limit(limit)
    ).all()
    return [
        {
            "import_id": event.details.get("import_id", "") if event.details else "",
            "row_count": event.details.get("row_count", 0) if event.details else 0,
            "inserted": event.details.get("inserted", 0) if event.details else 0,
            "products_created": event.details.get("products_created", 0) if event.details else 0,
            "created_at": event.created_at,
            "created_by": event.user_id,
        }
        for event in events
    ]
