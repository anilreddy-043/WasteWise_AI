import csv
import threading
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from functools import lru_cache
from pathlib import Path

from app.core.config import BACKEND_DIR

DEFAULT_DATA_DIR = BACKEND_DIR.parent / "ml" / "data" / "raw"
PRODUCTS_FILE = "products.csv"
HISTORY_FILE = "perishable_inventory.csv"
PRODUCT_COLUMNS = {"product_id", "product_name", "category", "selling_price"}
HISTORY_COLUMNS = {"product_id", "date", "category", "units_sold", "unit_price", "waste_units"}
SNAPSHOT_FILE = "inventory_batches.csv"
SNAPSHOT_COLUMNS = {
	"batch_id", "product_id", "snapshot_date", "expiry_date", "initial_quantity",
	"quantity_remaining", "days_to_expiry", "unit_price", "unit_cost", "expiry_risk_label",
}
DISCOUNT_FILE = "discount_scenarios_simulated.csv"
DISCOUNT_COLUMNS = {
	"batch_id", "product_id", "days_to_expiry", "quantity_remaining", "discount_pct",
	"estimated_units_sold_simulated", "estimated_revenue_simulated", "estimated_gross_margin_simulated",
}
_DASHBOARD_CSV_LOCK = threading.Lock()


@dataclass(frozen=True)
class CsvProduct:
	source_id: str
	name: str
	category: str
	unit: str
	price: Decimal

	@property
	def sku(self) -> str:
		return f"MLDATA-{self.source_id}"


@dataclass(frozen=True)
class CsvHistoryRow:
	product_source_id: str
	business_date: date
	category: str
	sales_quantity: Decimal
	unit_price: Decimal
	waste_quantity: Decimal


@dataclass(frozen=True)
class CsvBatchSnapshot:
	batch_id: int
	product_source_id: str
	category: str
	snapshot_date: date
	expiry_date: date
	quantity_received: Decimal
	quantity_remaining: Decimal
	days_to_expiry: int
	unit_price: Decimal
	unit_cost: Decimal
	expiry_risk: bool


@dataclass(frozen=True)
class CsvDiscountScenario:
	batch_id: int
	product_source_id: str
	days_to_expiry: int
	quantity_remaining: Decimal
	discount_percent: Decimal
	estimated_units_sold: Decimal
	estimated_revenue: Decimal
	estimated_gross_margin: Decimal


@dataclass(frozen=True)
class DashboardCsvData:
	catalog_products: tuple[CsvProduct, ...]
	sales_history: tuple[CsvHistoryRow, ...]
	catalog_available: bool
	history_available: bool
	catalog_source: str
	history_source: str
	inventory_snapshots: tuple[CsvBatchSnapshot, ...] = ()
	discount_scenarios: tuple[CsvDiscountScenario, ...] = ()
	snapshots_available: bool = False
	discount_scenarios_available: bool = False
	snapshot_source: str = f"ml/data/raw/{SNAPSHOT_FILE}"
	discount_source: str = f"ml/data/raw/{DISCOUNT_FILE}"


def _signature(path: Path) -> tuple[int, int] | None:
	try:
		stat = path.stat()
	except FileNotFoundError:
		return None
	return stat.st_mtime_ns, stat.st_size


@lru_cache(maxsize=8)
def _read_rows(
	path_string: str,
	modified_ns: int,
	file_size: int,
	required_columns: tuple[str, ...],
) -> tuple[dict[str, str], ...]:
	path = Path(path_string)
	stat = path.stat()
	if (stat.st_mtime_ns, stat.st_size) != (modified_ns, file_size):
		return _read_rows(path_string, stat.st_mtime_ns, stat.st_size, required_columns)
	with path.open(newline="", encoding="utf-8-sig") as source:
		reader = csv.DictReader(source)
		missing = set(required_columns).difference(reader.fieldnames or [])
		if missing:
			raise ValueError(f"{path.name} is missing required columns: {sorted(missing)}")
		return tuple(dict(row) for row in reader)


def _decimal(value: str, field: str, path: Path, row_number: int) -> Decimal:
	try:
		result = Decimal(value)
	except InvalidOperation as exc:
		raise ValueError(f"{path.name} row {row_number}: {field} must be numeric.") from exc
	if not result.is_finite() or result < 0:
		raise ValueError(f"{path.name} row {row_number}: {field} must be finite and nonnegative.")
	return result


def load_dashboard_csv_data(data_dir: Path | str = DEFAULT_DATA_DIR) -> DashboardCsvData:
	root = Path(data_dir).resolve()
	products_path = root / PRODUCTS_FILE
	history_path = root / HISTORY_FILE
	snapshots_path = root / SNAPSHOT_FILE
	discount_path = root / DISCOUNT_FILE
	signatures = (
		_signature(products_path),
		_signature(history_path),
		_signature(snapshots_path),
		_signature(discount_path),
	)
	with _DASHBOARD_CSV_LOCK:
		return _load_dashboard_csv_data_cached(str(root), *signatures)


@lru_cache(maxsize=8)
def _load_dashboard_csv_data_cached(
	root_string: str,
	products_signature: tuple[int, int] | None,
	history_signature: tuple[int, int] | None,
	snapshots_signature: tuple[int, int] | None,
	discount_signature: tuple[int, int] | None,
) -> DashboardCsvData:
	root = Path(root_string)
	products_path = root / PRODUCTS_FILE
	history_path = root / HISTORY_FILE
	snapshots_path = root / SNAPSHOT_FILE
	discount_path = root / DISCOUNT_FILE
	products_rows = (
		_read_rows(str(products_path), *products_signature, tuple(sorted(PRODUCT_COLUMNS)))
		if products_signature is not None
		else ()
	)
	history_rows = (
		_read_rows(str(history_path), *history_signature, tuple(sorted(HISTORY_COLUMNS)))
		if history_signature is not None
		else ()
	)
	snapshot_rows = (
		_read_rows(str(snapshots_path), *snapshots_signature, tuple(sorted(SNAPSHOT_COLUMNS)))
		if snapshots_signature is not None
		else ()
	)
	discount_rows = (
		_read_rows(str(discount_path), *discount_signature, tuple(sorted(DISCOUNT_COLUMNS)))
		if discount_signature is not None
		else ()
	)

	products_by_id: dict[str, CsvProduct] = {}
	for row_number, row in enumerate(products_rows, start=2):
		source_id = row["product_id"].strip()
		name = row["product_name"].strip()
		category = row["category"].strip()
		if not source_id or not name or not category:
			raise ValueError(f"{PRODUCTS_FILE} row {row_number}: product ID, name, and category are required.")
		product = CsvProduct(
			source_id=source_id,
			name=name,
			category=category,
			unit="unit",
			price=_decimal(row["selling_price"], "selling_price", products_path, row_number),
		)
		if source_id in products_by_id and products_by_id[source_id] != product:
			raise ValueError(f"{PRODUCTS_FILE} row {row_number}: conflicting duplicate product ID {source_id!r}.")
		products_by_id[source_id] = product

	history_by_key: dict[tuple[str, date], CsvHistoryRow] = {}
	for row_number, row in enumerate(history_rows, start=2):
		product_source_id = row["product_id"].strip()
		try:
			business_date = date.fromisoformat(row["date"].strip())
		except ValueError as exc:
			raise ValueError(f"{HISTORY_FILE} row {row_number}: date must use YYYY-MM-DD.") from exc
		if product_source_id not in products_by_id:
			raise ValueError(
				f"{HISTORY_FILE} row {row_number}: product ID {product_source_id!r} is missing from {PRODUCTS_FILE}."
			)
		history_row = CsvHistoryRow(
			product_source_id=product_source_id,
			business_date=business_date,
			category=row["category"].strip(),
			sales_quantity=_decimal(row["units_sold"], "units_sold", history_path, row_number),
			unit_price=_decimal(row["unit_price"], "unit_price", history_path, row_number),
			waste_quantity=_decimal(row["waste_units"], "waste_units", history_path, row_number),
		)
		key = (product_source_id, business_date)
		if key in history_by_key and history_by_key[key] != history_row:
			raise ValueError(f"{HISTORY_FILE} row {row_number}: conflicting duplicate product/date key {key!r}.")
		history_by_key[key] = history_row

	snapshots_by_id: dict[int, CsvBatchSnapshot] = {}
	for row_number, row in enumerate(snapshot_rows, start=2):
		product_source_id = row["product_id"].strip()
		if product_source_id not in products_by_id:
			raise ValueError(f"{SNAPSHOT_FILE} row {row_number}: unknown product ID {product_source_id!r}.")
		try:
			batch_id = int(row["batch_id"])
			snapshot_date = date.fromisoformat(row["snapshot_date"].strip())
			expiry_date = date.fromisoformat(row["expiry_date"].strip())
			days_to_expiry = int(row["days_to_expiry"])
		except ValueError as exc:
			raise ValueError(f"{SNAPSHOT_FILE} row {row_number}: invalid batch ID or date field.") from exc
		snapshot = CsvBatchSnapshot(
			batch_id=batch_id,
			product_source_id=product_source_id,
			category=row["category"].strip(),
			snapshot_date=snapshot_date,
			expiry_date=expiry_date,
			quantity_received=_decimal(row["initial_quantity"], "initial_quantity", snapshots_path, row_number),
			quantity_remaining=_decimal(row["quantity_remaining"], "quantity_remaining", snapshots_path, row_number),
			days_to_expiry=days_to_expiry,
			unit_price=_decimal(row["unit_price"], "unit_price", snapshots_path, row_number),
			unit_cost=_decimal(row["unit_cost"], "unit_cost", snapshots_path, row_number),
			expiry_risk=row["expiry_risk_label"].strip() == "1",
		)
		if batch_id in snapshots_by_id and snapshots_by_id[batch_id] != snapshot:
			raise ValueError(f"{SNAPSHOT_FILE} row {row_number}: conflicting duplicate batch ID {batch_id}.")
		snapshots_by_id[batch_id] = snapshot

	discounts_by_key: dict[tuple[int, Decimal], CsvDiscountScenario] = {}
	for row_number, row in enumerate(discount_rows, start=2):
		try:
			batch_id = int(row["batch_id"])
			days_to_expiry = int(row["days_to_expiry"])
		except ValueError as exc:
			raise ValueError(f"{DISCOUNT_FILE} row {row_number}: invalid batch ID or days_to_expiry.") from exc
		product_source_id = row["product_id"].strip()
		snapshot = snapshots_by_id.get(batch_id)
		if snapshot is None or snapshot.product_source_id != product_source_id:
			raise ValueError(f"{DISCOUNT_FILE} row {row_number}: batch/product key does not match the inventory snapshot.")
		scenario = CsvDiscountScenario(
			batch_id=batch_id,
			product_source_id=product_source_id,
			days_to_expiry=days_to_expiry,
			quantity_remaining=_decimal(row["quantity_remaining"], "quantity_remaining", discount_path, row_number),
			discount_percent=_decimal(row["discount_pct"], "discount_pct", discount_path, row_number),
			estimated_units_sold=_decimal(row["estimated_units_sold_simulated"], "estimated_units_sold_simulated", discount_path, row_number),
			estimated_revenue=_decimal(row["estimated_revenue_simulated"], "estimated_revenue_simulated", discount_path, row_number),
			estimated_gross_margin=_decimal(row["estimated_gross_margin_simulated"], "estimated_gross_margin_simulated", discount_path, row_number),
		)
		key = (batch_id, scenario.discount_percent)
		if key in discounts_by_key and discounts_by_key[key] != scenario:
			raise ValueError(f"{DISCOUNT_FILE} row {row_number}: conflicting duplicate scenario key {key!r}.")
		discounts_by_key[key] = scenario

	return DashboardCsvData(
		catalog_products=tuple(products_by_id[key] for key in sorted(products_by_id)),
		sales_history=tuple(history_by_key[key] for key in sorted(history_by_key)),
		catalog_available=products_signature is not None,
		history_available=history_signature is not None,
		catalog_source=f"ml/data/raw/{PRODUCTS_FILE}",
		history_source=f"ml/data/raw/{HISTORY_FILE}",
		inventory_snapshots=tuple(snapshots_by_id[key] for key in sorted(snapshots_by_id)),
		discount_scenarios=tuple(discounts_by_key[key] for key in sorted(discounts_by_key)),
		snapshots_available=snapshots_signature is not None,
		discount_scenarios_available=discount_signature is not None,
	)