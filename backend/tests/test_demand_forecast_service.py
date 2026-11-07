from datetime import date, datetime

import pandas as pd

from app.models import Product
from app.services.demand_forecast_service import FEATURE_COLUMNS, load_demand_model, prepare_feature_row


def test_demand_artifact_loads_and_has_expected_features():
    model = load_demand_model()
    assert list(model.feature_names_in_) == FEATURE_COLUMNS


def test_feature_row_preparation_is_complete():
    product = Product(product_id=1, name="Test", category="Fruit", sku="TEST", unit="each", price=10, supplier="Test")
    row = prepare_feature_row(product, date(2026, 11, 1), [3, 2, 4, 1, 5, 2, 3], 20, 10, 10, 5)
    assert list(row.columns) == FEATURE_COLUMNS
    assert row.iloc[0]["sales_lag_1"] == 3
    assert row.iloc[0]["sales_lag_7"] == 3
    assert row.iloc[0]["calendar_month"] == 11


def test_model_one_day_prediction_is_non_negative():
    model = load_demand_model()
    product = Product(product_id=1, name="Test", category="Fruit", sku="TEST", unit="each", price=10, supplier="Test")
    row = prepare_feature_row(product, date(2026, 11, 1), [0] * 30, 20, 0, 10, 365)
    prediction = float(model.predict(row)[0])
    assert prediction >= 0
