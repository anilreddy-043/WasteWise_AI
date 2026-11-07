import csv
import hashlib
import io
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Literal

from openpyxl import Workbook
from sqlalchemy import func, inspect, select, tuple_
from sqlalchemy.orm import Session

from app.models import InventoryBatch, Product, SaleRecord, UserActivity, WasteRecord
from app.schemas import ProductCreate, SaleCreate
from app.services.inventory_batch_import_service import (
    CSV_COLUMNS,
    confirm_inventory_batches_csv,
    preview_inventory_batches_csv,
)

ImportDataset = Literal["products", "inventory", "sales"]
ExportDataset = Literal["products", "inventory", "sales", "waste", "reports"]
ExportFormat = Literal["csv", "xlsx"]

MAX_IMPORT_BYTES = 5 * 1024 * 1024
MAX_IMPORT_ROWS = 5000

_IMPORT_COLUMNS: dict[ImportDataset, set[str]] = {
    "products": {"product_name", "category", "sku", "unit", "price", "supplier"},
    "inventory": {"batch_code", "quantity_received", "received_at", "expiry_date", "location"},
    "sales": {"product_id", "sold_at", "quantity", "unit_price"},
}
_HEADER_ALIASES: dict[ImportDataset, dict[str, str]] = {
    "products": {
        "name": "product_name",
        "product": "product_name",
        "selling_price": "price",
    },
    "inventory": {
        "name": "product_name",
        "product": "product_name",
        "batch_number": "batch_code",
        "batch_no": "batch_code",
        "manufacturing_date": "received_at",
        "manufacture_date": "received_at",
        "received_date": "received_at",
        "quantity": "quantity_received",
        "remaining_quantity": "quantity_remaining",
        "cost": "unit_cost",
    },
    "sales": {},
}


class CsvImportError(ValueError):
    pass


def decode_csv(contents: bytes) -> str:
    if not contents:
        raise CsvImportError("The uploaded CSV file is empty.")
    if len(contents) > MAX_IMPORT_BYTES:
        raise CsvImportError("CSV files must be 5 MB or smaller.")
    if b"\x00" in contents:
        raise CsvImportError("The uploaded file is not a valid text CSV.")
    try:
        text = contents.decode("utf-8-sig", errors="strict")
    except UnicodeDecodeError as exc:
        raise CsvImportError("CSV files must use UTF-8 encoding.") from exc
    if not text.strip():
        raise CsvImportError("The uploaded CSV file is empty.")
    return text


def _normalise_header(value: str, dataset: ImportDataset) -> str:
    header = "_".join(value.strip().casefold().replace("-", " ").split())
    return _HEADER_ALIASES[dataset].get(header, header)


def _parse_rows(csv_text: str, dataset: ImportDataset) -> list[dict[str, Any]]:
    try:
        reader = csv.reader(io.StringIO(csv_text, newline=""), strict=True)
        raw_headers = next(reader, None)
        if not raw_headers:
            raise CsvImportError("CSV must include a header row.")
        headers = [_normalise_header(header.lstrip("\ufeff"), dataset) for header in raw_headers]
        if any(not header for header in headers):
            raise CsvImportError("CSV contains an empty column name.")
        if len(headers) != len(set(headers)):
            raise CsvImportError("CSV contains duplicate columns after normalizing header names.")
        missing = _IMPORT_COLUMNS[dataset] - set(headers)
        if missing:
            raise CsvImportError(f"CSV is missing required columns: {', '.join(sorted(missing))}.")
        if dataset == "inventory" and not {"product_name", "product_id"}.intersection(headers):
            raise CsvImportError("Inventory CSV must include a product_name or product_id column.")

        rows: list[dict[str, Any]] = []
        for row_number, raw_values in enumerate(reader, start=2):
            if len(rows) >= MAX_IMPORT_ROWS:
                raise CsvImportError(f"CSV exceeds the {MAX_IMPORT_ROWS} row import limit.")
            if not any(value.strip() for value in raw_values):
                continue
            row: dict[str, Any] = {
                "row": row_number,
                "values": {},
                "errors": [],
            }
            if len(raw_values) != len(headers):
                row["errors"].append("Row has a different number of values than the CSV header.")
            row["values"] = {
                header: raw_values[index].strip() if index < len(raw_values) else ""
                for index, header in enumerate(headers)
            }
            rows.append(row)
        if not rows:
            raise CsvImportError("CSV contains no data records.")
        return rows
    except csv.Error as exc:
        raise CsvImportError(f"CSV could not be parsed: {exc}") from exc


def _parse_decimal(value: str, field: str, max_places: int) -> Decimal:
    try:
        parsed = Decimal(value)
    except InvalidOperation as exc:
        raise ValueError(f"{field} must be a number.") from exc
    if not parsed.is_finite():
        raise ValueError(f"{field} must be finite.")
    if parsed.as_tuple().exponent < -max_places:
        raise ValueError(f"{field} supports at most {max_places} decimal places.")
    return parsed


def _error_report(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {"row": row["row"], "errors": list(row["errors"])}
        for row in rows
        if row["errors"]
    ]


def _result(
    dataset: ImportDataset,
    total: int,
    successful: int,
    skipped: int,
    failed: int,
    errors: list[dict[str, Any]],
    import_id: str,
) -> dict[str, Any]:
    return {
        "dataset": dataset,
        "import_id": import_id,
        "total_records": total,
        "successful_records": successful,
        "skipped_records": skipped,
        "failed_records": failed,
        "errors": errors,
    }


def _was_imported(db: Session, dataset: ImportDataset, digest: str) -> bool:
    if dataset == "inventory":
        return db.scalar(
            select(UserActivity.activity_id)
            .where(
                UserActivity.action == "batch_csv_imported",
                UserActivity.entity_type == "inventory_batch_import",
                UserActivity.details["import_id"].as_string() == digest,
            )
            .limit(1)
        ) is not None
    return db.scalar(
        select(UserActivity.activity_id)
        .where(
            UserActivity.action == "data_csv_imported",
            UserActivity.entity_type == dataset,
            UserActivity.details["sha256"].as_string() == digest,
        )
        .limit(1)
    ) is not None


def _record_import(
    db: Session,
    *,
    user_id: int,
    dataset: ImportDataset,
    digest: str,
    filename: str,
    total: int,
    successful: int,
    skipped: int,
) -> None:
    db.add(
        UserActivity(
            user_id=user_id,
            action="data_csv_imported",
            entity_type=dataset,
            details={
                "sha256": digest,
                "filename": filename,
                "total_records": total,
                "successful_records": successful,
                "skipped_records": skipped,
                "provenance": "operational_csv_import",
            },
        )
    )


def import_products_csv(
    db: Session,
    csv_text: str,
    *,
    user_id: int,
    filename: str,
    digest: str,
) -> dict[str, Any]:
    rows = _parse_rows(csv_text, "products")
    seen_skus: set[str] = set()
    parsed_products: list[tuple[dict[str, Any], ProductCreate]] = []
    skipped = 0
    for row in rows:
        values = row["values"]
        try:
            payload = ProductCreate.model_validate({
                "name": values.get("product_name", ""),
                "category": values.get("category", ""),
                "sku": values.get("sku", ""),
                "unit": values.get("unit", ""),
                "price": _parse_decimal(values.get("price", ""), "price", 2),
                "supplier": values.get("supplier", ""),
            })
        except (ValueError, TypeError) as exc:
            row["errors"].append(str(exc))
            continue
        sku = payload.sku.casefold()
        if sku in seen_skus:
            skipped += 1
            row["skipped"] = True
            continue
        seen_skus.add(sku)
        parsed_products.append((row, payload))

    if _was_imported(db, "products", digest):
        return _result("products", len(rows), 0, len(rows), 0, [], digest)

    existing_skus = {
        sku.casefold()
        for sku in db.scalars(
            select(Product.sku).where(func.lower(Product.sku).in_(seen_skus))
        ).all()
    } if seen_skus else set()
    additions: list[tuple[dict[str, Any], ProductCreate]] = []
    for row, payload in parsed_products:
        if payload.sku.casefold() in existing_skus:
            skipped += 1
            row["skipped"] = True
        else:
            additions.append((row, payload))

    errors = _error_report(rows)
    if errors:
        return _result("products", len(rows), 0, skipped, len(errors), errors, digest)

    try:
        for _, payload in additions:
            product = Product(**payload.model_dump())
            db.add(product)
            db.flush()
            db.add(UserActivity(
                user_id=user_id,
                action="product_imported",
                entity_type="product",
                entity_id=product.product_id,
                details={"sha256": digest, "provenance": "operational_csv_import"},
            ))
        _record_import(
            db,
            user_id=user_id,
            dataset="products",
            digest=digest,
            filename=filename,
            total=len(rows),
            successful=len(additions),
            skipped=skipped,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return _result("products", len(rows), len(additions), skipped, 0, [], digest)


def import_inventory_csv(
    db: Session,
    csv_text: str,
    *,
    user_id: int,
    filename: str,
    digest: str,
) -> dict[str, Any]:
    rows = _parse_rows(csv_text, "inventory")
    if _was_imported(db, "inventory", digest):
        return _result("inventory", len(rows), 0, len(rows), 0, [], digest)

    try:
        if "product_id" in rows[0]["values"]:
            product_id_map: dict[int, Product] = {}
            for row in rows:
                raw_id = row["values"].get("product_id", "")
                try:
                    product_id = int(raw_id)
                    if product_id < 1:
                        raise ValueError
                except ValueError:
                    row["errors"].append("Product ID must be a positive integer.")
                    continue
                row["values"]["product_id"] = str(product_id)
                if product_id not in product_id_map:
                    product = db.get(Product, product_id)
                    if product is not None:
                        product_id_map[product_id] = product
                product = product_id_map.get(product_id)
                if product is None:
                    row["errors"].append(f"Product ID {product_id} does not exist.")
                else:
                    row["values"]["product_name"] = product.name
                    row["values"]["sku"] = product.sku

        parse_errors = _error_report(rows)
        if parse_errors:
            return _result("inventory", len(rows), 0, 0, len(parse_errors), parse_errors, digest)

        adapted_csv = io.StringIO(newline="")
        writer = csv.DictWriter(adapted_csv, fieldnames=CSV_COLUMNS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(row["values"] for row in rows)
        service_csv = adapted_csv.getvalue()
        preview = preview_inventory_batches_csv(db, service_csv)
        errors = [
            {"row": row["row_number"], "errors": row["errors"]}
            for row in preview["rows"]
            if row["errors"]
        ]
        if errors:
            return _result("inventory", len(rows), 0, 0, len(errors), errors, digest)
        if preview["missing_product_count"]:
            missing = [
                {"row": row["row_number"], "errors": ["Product does not exist. Inventory import does not create products."]}
                for row in preview["rows"]
                if row["product_status"] == "missing"
            ]
            return _result("inventory", len(rows), 0, 0, len(missing), missing, digest)

        result = confirm_inventory_batches_csv(
            db,
            service_csv,
            user_id,
            digest,
            create_missing_products=False,
            source_filename=filename,
        )
        return _result("inventory", len(rows), result["inserted"], 0, 0, [], digest)
    except Exception:
        db.rollback()
        raise


def import_sales_csv(
    db: Session,
    csv_text: str,
    *,
    user_id: int,
    filename: str,
    digest: str,
) -> dict[str, Any]:
    rows = _parse_rows(csv_text, "sales")
    seen_signatures: set[tuple[Any, ...]] = set()
    parsed_sales: list[tuple[dict[str, Any], SaleCreate]] = []
    skipped = 0
    for row in rows:
        values = row["values"]
        try:
            product_id = int(values.get("product_id", ""))
            batch_id = int(values["batch_id"]) if values.get("batch_id", "").strip() else None
            if product_id < 1 or (batch_id is not None and batch_id < 1):
                raise ValueError("Product and batch IDs must be positive integers.")
            quantity = _parse_decimal(values.get("quantity", ""), "quantity", 3)
            unit_price = _parse_decimal(values.get("unit_price", ""), "unit price", 2)
            if quantity <= 0 or unit_price < 0:
                raise ValueError("Quantity must be positive and unit price cannot be negative.")
            sold_at_text = values.get("sold_at", "").strip()
            if not sold_at_text:
                raise ValueError("Sold at is required and must be an ISO timestamp.")
            sold_at = datetime.fromisoformat(sold_at_text.replace("Z", "+00:00"))
            if sold_at.tzinfo is not None:
                sold_at = sold_at.astimezone(timezone.utc).replace(tzinfo=None)
            payload = SaleCreate.model_validate({
                "product_id": product_id,
                "batch_id": batch_id,
                "sold_at": sold_at,
                "quantity": quantity,
                "unit_price": unit_price,
                "source": "integration",
            })
        except (ValueError, TypeError, InvalidOperation) as exc:
            row["errors"].append(str(exc))
            continue
        signature = (payload.product_id, payload.batch_id, payload.sold_at, payload.quantity, payload.unit_price)
        if signature in seen_signatures:
            skipped += 1
            row["skipped"] = True
            continue
        seen_signatures.add(signature)
        parsed_sales.append((row, payload))

    if _was_imported(db, "sales", digest):
        return _result("sales", len(rows), 0, len(rows), 0, [], digest)

    product_ids = {payload.product_id for _, payload in parsed_sales}
    existing_product_ids = set(db.scalars(
        select(Product.product_id).where(Product.product_id.in_(product_ids))
    ).all()) if product_ids else set()
    batches = {
        batch.batch_id: batch.product_id
        for batch in db.scalars(
            select(InventoryBatch).where(
                InventoryBatch.batch_id.in_(
                    {payload.batch_id for _, payload in parsed_sales if payload.batch_id is not None}
                )
            )
        ).all()
    } if any(payload.batch_id is not None for _, payload in parsed_sales) else {}
    for row, payload in parsed_sales:
        if payload.product_id not in existing_product_ids:
            row["errors"].append(f"Product ID {payload.product_id} does not exist.")
        if payload.batch_id is not None:
            batch_product_id = batches.get(payload.batch_id)
            if batch_product_id is None:
                row["errors"].append(f"Batch ID {payload.batch_id} does not exist.")
            elif batch_product_id != payload.product_id:
                row["errors"].append("Batch does not belong to the specified product.")

    existing_signatures: set[tuple[Any, ...]] = set()
    valid_sales = [(row, payload) for row, payload in parsed_sales if not row["errors"]]
    null_batch_signatures = list({
        (payload.product_id, payload.sold_at, payload.quantity, payload.unit_price)
        for _, payload in valid_sales if payload.batch_id is None
    })
    batch_signatures = list({
        (payload.product_id, payload.batch_id, payload.sold_at, payload.quantity, payload.unit_price)
        for _, payload in valid_sales if payload.batch_id is not None
    })
    for offset in range(0, len(null_batch_signatures), 100):
        signatures_batch = null_batch_signatures[offset:offset + 100]
        existing_signatures.update(
            (product_id, None, sold_at, quantity, unit_price)
            for product_id, sold_at, quantity, unit_price in db.execute(
                select(
                    SaleRecord.product_id,
                    SaleRecord.sold_at,
                    SaleRecord.quantity,
                    SaleRecord.unit_price,
                ).where(
                    SaleRecord.batch_id.is_(None),
                    tuple_(
                        SaleRecord.product_id,
                        SaleRecord.sold_at,
                        SaleRecord.quantity,
                        SaleRecord.unit_price,
                    ).in_(signatures_batch),
                )
            ).all()
        )
    for offset in range(0, len(batch_signatures), 100):
        signatures_batch = batch_signatures[offset:offset + 100]
        existing_signatures.update(
            tuple(values)
            for values in db.execute(
                select(
                    SaleRecord.product_id,
                    SaleRecord.batch_id,
                    SaleRecord.sold_at,
                    SaleRecord.quantity,
                    SaleRecord.unit_price,
                ).where(
                    tuple_(
                        SaleRecord.product_id,
                        SaleRecord.batch_id,
                        SaleRecord.sold_at,
                        SaleRecord.quantity,
                        SaleRecord.unit_price,
                    ).in_(signatures_batch)
                )
            ).all()
        )
    additions: list[tuple[dict[str, Any], SaleCreate]] = []
    for row, payload in parsed_sales:
        signature = (payload.product_id, payload.batch_id, payload.sold_at, payload.quantity, payload.unit_price)
        if signature in existing_signatures:
            skipped += 1
            row["skipped"] = True
        else:
            additions.append((row, payload))

    errors = _error_report(rows)
    if errors:
        return _result("sales", len(rows), 0, skipped, len(errors), errors, digest)

    try:
        for _, payload in additions:
            total = (payload.quantity * payload.unit_price).quantize(Decimal("0.01"))
            sale = SaleRecord(
                product_id=payload.product_id,
                batch_id=payload.batch_id,
                sold_at=payload.sold_at,
                quantity=payload.quantity,
                unit_price=payload.unit_price,
                total_amount=total,
                source="csv_import",
            )
            db.add(sale)
            db.flush()
            db.add(UserActivity(
                user_id=user_id,
                action="sale_imported",
                entity_type="sale",
                entity_id=sale.sale_id,
                details={"sha256": digest, "provenance": "operational_csv_import"},
            ))
        _record_import(
            db,
            user_id=user_id,
            dataset="sales",
            digest=digest,
            filename=filename,
            total=len(rows),
            successful=len(additions),
            skipped=skipped,
        )
        db.commit()
    except Exception:
        db.rollback()
        raise
    return _result("sales", len(rows), len(additions), skipped, 0, [], digest)


def import_csv(
    db: Session,
    dataset: ImportDataset,
    csv_text: str,
    *,
    user_id: int,
    filename: str,
) -> dict[str, Any]:
    digest = hashlib.sha256(csv_text.encode("utf-8")).hexdigest()
    if dataset == "products":
        return import_products_csv(db, csv_text, user_id=user_id, filename=filename, digest=digest)
    if dataset == "inventory":
        return import_inventory_csv(db, csv_text, user_id=user_id, filename=filename, digest=digest)
    return import_sales_csv(db, csv_text, user_id=user_id, filename=filename, digest=digest)


def _inventory_has_expiry_source(db: Session) -> bool:
    return "expiry_date_source" in {
        column["name"] for column in inspect(db.get_bind()).get_columns(InventoryBatch.__tablename__)
    }


def _report_rows(db: Session) -> tuple[list[str], list[list[Any]]]:
    product_count = db.scalar(select(func.count()).select_from(Product)) or 0
    batch_count, inventory_units = db.execute(
        select(func.count(InventoryBatch.batch_id), func.coalesce(func.sum(InventoryBatch.quantity_remaining), 0))
        .where(InventoryBatch.status == "active")
    ).one()
    sale_count, sales_units, sales_revenue = db.execute(
        select(
            func.count(SaleRecord.sale_id),
            func.coalesce(func.sum(SaleRecord.quantity), 0),
            func.coalesce(func.sum(SaleRecord.total_amount), 0),
        )
    ).one()
    waste_count, waste_units, waste_cost = db.execute(
        select(
            func.count(WasteRecord.waste_id),
            func.coalesce(func.sum(WasteRecord.quantity), 0),
            func.coalesce(func.sum(WasteRecord.waste_cost), 0),
        )
    ).one()
    generated_at = datetime.now(timezone.utc).replace(tzinfo=None).isoformat(sep=" ")
    return (
        ["metric", "value", "generated_at"],
        [
            [label, value, generated_at]
            for label, value in (
                ("products_count", product_count),
                ("active_batch_count", batch_count),
                ("inventory_units_remaining", inventory_units),
                ("sales_record_count", sale_count),
                ("sales_units", sales_units),
                ("sales_revenue", sales_revenue),
                ("waste_record_count", waste_count),
                ("waste_units", waste_units),
                ("waste_cost", waste_cost),
            )
        ],
    )


def export_rows(db: Session, dataset: ExportDataset) -> tuple[str, list[str], list[list[Any]]]:
    if dataset == "products":
        columns = [
            "product_id", "name", "category", "sku", "unit", "price", "supplier",
            "created_at", "updated_at", "provenance",
        ]
        rows = db.execute(
            select(*(getattr(Product, column) for column in columns[:9])).order_by(Product.product_id)
        ).all()
        product_ids = [row[0] for row in rows]
        imported_ids = set(db.scalars(
            select(UserActivity.entity_id).where(
                UserActivity.action == "product_imported",
                UserActivity.entity_type == "product",
                UserActivity.entity_id.in_(product_ids),
            )
        ).all()) if product_ids else set()
        return "products", columns, [
            [*row[:9], (
                "historical_training_catalog" if row[3].startswith("MLDATA-")
                else "operational_csv_import" if row[0] in imported_ids
                else "operational_application"
            )]
            for row in rows
        ]
    if dataset == "inventory":
        has_source = _inventory_has_expiry_source(db)
        columns = [
            "batch_id", "product_id", "product_name", "sku", "batch_code", "quantity_received",
            "quantity_remaining", "unit_cost", "received_at", "expiry_date",
        ]
        selected = [
            InventoryBatch.batch_id,
            InventoryBatch.product_id,
            Product.name.label("product_name"),
            Product.sku,
            InventoryBatch.batch_code,
            InventoryBatch.quantity_received,
            InventoryBatch.quantity_remaining,
            InventoryBatch.unit_cost,
            InventoryBatch.received_at,
            InventoryBatch.expiry_date,
        ]
        if has_source:
            columns.append("expiry_date_source")
            selected.append(InventoryBatch.expiry_date_source)
        columns.extend(["status", "location", "supplier", "created_at", "updated_at"])
        selected.extend([
            InventoryBatch.status,
            InventoryBatch.location,
            InventoryBatch.supplier,
            InventoryBatch.created_at,
            InventoryBatch.updated_at,
        ])
        rows = db.execute(
            select(*selected).join(Product, Product.product_id == InventoryBatch.product_id)
            .order_by(InventoryBatch.batch_id)
        ).all()
        batch_ids = [row[0] for row in rows]
        imported_batch_ids = set(db.scalars(
            select(UserActivity.entity_id).where(
                UserActivity.action == "batch_imported",
                UserActivity.entity_type == "inventory_batch",
                UserActivity.entity_id.in_(batch_ids),
            )
        ).all()) if batch_ids else set()
        columns.append("record_provenance")
        return "inventory", columns, [
            [*row, "operational_csv_import" if row[0] in imported_batch_ids else "operational_application"]
            for row in rows
        ]
    if dataset == "sales":
        columns = [
            "sale_id", "product_id", "product_name", "sku", "batch_id", "sold_at", "quantity",
            "unit_price", "total_amount", "source", "created_at",
        ]
        rows = db.execute(
            select(
                SaleRecord.sale_id,
                SaleRecord.product_id,
                Product.name,
                Product.sku,
                SaleRecord.batch_id,
                SaleRecord.sold_at,
                SaleRecord.quantity,
                SaleRecord.unit_price,
                SaleRecord.total_amount,
                SaleRecord.source,
                SaleRecord.created_at,
            ).join(Product, Product.product_id == SaleRecord.product_id)
            .order_by(SaleRecord.sold_at, SaleRecord.sale_id)
        ).all()
        return "sales", columns, [list(row) for row in rows]
    if dataset == "waste":
        columns = [
            "waste_id", "product_id", "product_name", "sku", "batch_id", "recorded_by", "quantity",
            "reason", "waste_cost", "recorded_at", "notes",
        ]
        rows = db.execute(
            select(
                WasteRecord.waste_id,
                WasteRecord.product_id,
                Product.name,
                Product.sku,
                WasteRecord.batch_id,
                WasteRecord.recorded_by,
                WasteRecord.quantity,
                WasteRecord.reason,
                WasteRecord.waste_cost,
                WasteRecord.recorded_at,
                WasteRecord.notes,
            ).join(Product, Product.product_id == WasteRecord.product_id)
            .order_by(WasteRecord.recorded_at, WasteRecord.waste_id)
        ).all()
        return "waste", columns, [list(row) for row in rows]
    columns, rows = _report_rows(db)
    return "reports", columns, rows


def export_bytes(db: Session, dataset: ExportDataset, file_format: ExportFormat) -> bytes:
    _, headers, rows = export_rows(db, dataset)
    if file_format == "csv":
        output = io.StringIO(newline="")
        writer = csv.writer(output)
        writer.writerow(headers)
        writer.writerows([[_safe_cell(value) for value in row] for row in rows])
        return output.getvalue().encode("utf-8-sig")

    workbook = Workbook(write_only=True)
    sheet = workbook.create_sheet(title=dataset.title())
    sheet.append(headers)
    for row in rows:
        sheet.append([_safe_cell(value) for value in row])
    output = io.BytesIO()
    workbook.save(output)
    return output.getvalue()


def _safe_cell(value: Any) -> Any:
    if isinstance(value, str) and value.lstrip(" \t\r\n").startswith(("=", "+", "-", "@")):
        return f"'{value}"
    return value
