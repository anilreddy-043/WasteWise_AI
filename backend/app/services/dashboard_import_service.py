import csv
import hashlib
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import BACKEND_DIR
from app.models import DashboardHistoricalMetric, DashboardImportRecord, DashboardImportRun, Product

PROJECT_ROOT = BACKEND_DIR.parent
DEFAULT_DATA_DIR = PROJECT_ROOT / "ml" / "data" / "raw"
PRODUCTS_FILE = "products.csv"
HISTORY_FILE = "perishable_inventory.csv"
PRODUCT_COLUMNS = {"product_id", "product_name", "category", "selling_price"}
HISTORY_COLUMNS = {"product_id", "date", "units_sold", "unit_price", "waste_units"}


def _read_rows(path: Path, required: set[str]) -> list[dict[str, str]]:
    if not path.is_file():
        raise FileNotFoundError(f"Dashboard import source does not exist: {path}")
    with path.open(newline="", encoding="utf-8-sig") as source:
        reader = csv.DictReader(source)
        missing = required.difference(reader.fieldnames or [])
        if missing:
            raise ValueError(f"{path.name} is missing required columns: {sorted(missing)}")
        rows = list(reader)
    if not rows:
        raise ValueError(f"Dashboard import source is empty: {path.name}")
    return rows


def _source_name(path: Path, default_name: str) -> str:
    try:
        return path.resolve().relative_to(PROJECT_ROOT.resolve()).as_posix()
    except ValueError:
        return default_name


def _new_run(session: Session, source_file: str, path: Path, rows_seen: int) -> DashboardImportRun:
    run = DashboardImportRun(
        source_file=source_file,
        source_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
        started_at=datetime.now(timezone.utc).replace(tzinfo=None),
        rows_seen=rows_seen,
    )
    session.add(run)
    session.flush()
    return run


def _decimal(value: str, column: str, source_file: str, row_number: int) -> Decimal:
    try:
        parsed = Decimal(value)
    except InvalidOperation as exc:
        raise ValueError(f"{source_file} row {row_number}: {column} must be numeric.") from exc
    if not parsed.is_finite() or parsed < 0:
        raise ValueError(f"{source_file} row {row_number}: {column} must be finite and nonnegative.")
    return parsed


def import_dashboard_csvs(
    session: Session,
    data_dir: Path | str = DEFAULT_DATA_DIR,
) -> list[DashboardImportRun]:
    source_dir = Path(data_dir)
    products_path = source_dir / PRODUCTS_FILE
    history_path = source_dir / HISTORY_FILE
    product_rows = _read_rows(products_path, PRODUCT_COLUMNS)
    history_rows = _read_rows(history_path, HISTORY_COLUMNS)
    product_source = _source_name(products_path, PRODUCTS_FILE)
    history_source = _source_name(history_path, HISTORY_FILE)
    product_run = _new_run(session, product_source, products_path, len(product_rows))
    existing_product_records = {
        record.source_record_key: record.entity_id
        for record in session.scalars(
            select(DashboardImportRecord).where(
                DashboardImportRecord.source_file == product_source,
                DashboardImportRecord.entity_type == "product",
            )
        ).all()
    }
    seen_product_keys: set[str] = set()
    for row_number, row in enumerate(product_rows, start=2):
        source_key = row["product_id"].strip()
        if not source_key or source_key in seen_product_keys:
            product_run.rows_skipped += 1
            continue
        seen_product_keys.add(source_key)
        if source_key in existing_product_records:
            product_run.rows_skipped += 1
            continue
        sku = f"MLDATA-{source_key}"
        if session.scalar(select(Product.product_id).where(Product.sku == sku)) is not None:
            product_run.rows_skipped += 1
            continue
        product = Product(
            name=row["product_name"].strip(),
            category=row["category"].strip(),
            sku=sku,
            unit="unit",
            price=_decimal(row["selling_price"], "selling_price", PRODUCTS_FILE, row_number),
            supplier="ML training dataset",
        )
        if not product.name or not product.category:
            raise ValueError(f"{PRODUCTS_FILE} row {row_number}: product name and category are required.")
        session.add(product)
        session.flush()
        session.add(
            DashboardImportRecord(
                source_file=product_source,
                source_record_key=source_key,
                entity_type="product",
                entity_id=product.product_id,
                import_run_id=product_run.import_run_id,
            )
        )
        existing_product_records[source_key] = product.product_id
        product_run.rows_inserted += 1
    product_run.completed_at = datetime.now(timezone.utc).replace(tzinfo=None)

    history_run = _new_run(session, history_source, history_path, len(history_rows))
    product_map = {
        record.source_record_key: record.entity_id
        for record in session.scalars(
            select(DashboardImportRecord).where(
                DashboardImportRecord.source_file == product_source,
                DashboardImportRecord.entity_type == "product",
            )
        ).all()
    }
    existing_history_keys = set(
        session.scalars(
            select(DashboardHistoricalMetric.source_record_key).where(
                DashboardHistoricalMetric.source_file == history_source
            )
        ).all()
    )
    seen_history_keys: set[str] = set()
    for row_number, row in enumerate(history_rows, start=2):
        product_key = row["product_id"].strip()
        raw_date = row["date"].strip()
        source_key = f"{product_key}:{raw_date}"
        if source_key in seen_history_keys:
            history_run.rows_skipped += 1
            continue
        seen_history_keys.add(source_key)
        if source_key in existing_history_keys:
            history_run.rows_skipped += 1
            continue
        product_id = product_map.get(product_key)
        if product_id is None:
            raise ValueError(f"{HISTORY_FILE} row {row_number}: product_id {product_key!r} has no imported catalog record.")
        try:
            business_date = date.fromisoformat(raw_date)
        except ValueError as exc:
            raise ValueError(f"{HISTORY_FILE} row {row_number}: date must use YYYY-MM-DD.") from exc
        sales_quantity = _decimal(row["units_sold"], "units_sold", HISTORY_FILE, row_number)
        unit_price = _decimal(row["unit_price"], "unit_price", HISTORY_FILE, row_number)
        waste_quantity = _decimal(row["waste_units"], "waste_units", HISTORY_FILE, row_number)
        session.add(
            DashboardHistoricalMetric(
                source_file=history_source,
                source_record_key=source_key,
                source_run_id=history_run.import_run_id,
                product_id=product_id,
                business_date=business_date,
                sales_quantity=sales_quantity,
                sales_revenue=(sales_quantity * unit_price).quantize(Decimal("0.01")),
                waste_quantity=waste_quantity,
                data_kind="training_history",
            )
        )
        history_run.rows_inserted += 1
    history_run.completed_at = datetime.now(timezone.utc).replace(tzinfo=None)
    session.flush()
    return [product_run, history_run]