from pathlib import Path

from app.services.dashboard_csv_service import load_dashboard_csv_data


def test_dashboard_csv_data_is_cached_until_a_source_file_changes(tmp_path: Path) -> None:
    products_file = tmp_path / "products.csv"
    products_file.write_text(
        "product_id,product_name,category,selling_price\n1,Milk,Dairy,10\n",
        encoding="utf-8",
    )

    first = load_dashboard_csv_data(tmp_path)
    second = load_dashboard_csv_data(tmp_path)

    assert second is first
    assert first.catalog_products[0].name == "Milk"

    products_file.write_text(
        "product_id,product_name,category,selling_price\n1,Fresh Milk,Dairy,10\n",
        encoding="utf-8",
    )
    updated = load_dashboard_csv_data(tmp_path)

    assert updated is not first
    assert updated.catalog_products[0].name == "Fresh Milk"
