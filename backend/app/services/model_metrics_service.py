from __future__ import annotations

import json
import math
import threading
import uuid
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any

import numpy as np
import pandas as pd
from fastapi import HTTPException
from sklearn.metrics import (
    accuracy_score,
    confusion_matrix,
    f1_score,
    mean_absolute_error,
    mean_squared_error,
    precision_score,
    r2_score,
    recall_score,
)
from sklearn.model_selection import GroupShuffleSplit
from sqlalchemy import case, extract, func, inspect, select
from sqlalchemy.orm import Session

from app.core.config import BACKEND_DIR
from app.models import (
    DemandForecast,
    ExpiryRiskPrediction,
    InventoryBatch,
    ModelMetric,
    Product,
    Recommendation,
    SaleRecord,
)
from app.services.model_artifacts import (
    ARTIFACT_DIR,
    artifact_path,
    load_model_artifact,
    model_version,
)

PROJECT_ROOT = BACKEND_DIR.parent
DATA_DIR = PROJECT_ROOT / "ml" / "data" / "raw"
MODEL_DATASETS = {
    "demand_forecast": "perishable_inventory.csv",
    "expiry_risk": "inventory_batches.csv",
    "discount_recommendation": "discount_scenarios_simulated.csv",
}
MODEL_NAMES = tuple(MODEL_DATASETS)
RISK_CLASSES = ("Expired", "High Risk", "Medium Risk", "Low Risk", "Safe")

_RETRAIN_LOCK = threading.Lock()
_RETRAIN_JOBS: dict[str, dict[str, Any]] = {}
_ACTIVE_RETRAIN_JOB: str | None = None


def _read_sidecar(model_name: str) -> dict[str, Any] | None:
    path = ARTIFACT_DIR / f"{model_name}_metrics.json"
    if not path.is_file():
        return None
    with path.open(encoding="utf-8") as source:
        data = json.load(source)
    if not isinstance(data, dict):
        raise ValueError(f"Invalid metrics metadata in {path}.")
    return data


def _estimator(model: Any) -> Any:
    steps = getattr(model, "steps", None)
    return steps[-1][1] if steps else model


def _algorithm(model: Any) -> str:
    return type(_estimator(model)).__name__


def _artifact_info(model_name: str, include_model: bool = True) -> dict[str, Any]:
    path = artifact_path(model_name)
    sidecar = _read_sidecar(model_name)
    model = load_model_artifact(model_name) if include_model else None
    estimator = _estimator(model) if model is not None else None
    info: dict[str, Any] = {
        "model_name": model_name,
        "model_version": model_version(model_name),
        "algorithm": _algorithm(model) if model is not None else None,
        "artifact_status": "available",
        "artifact_path": str(path.relative_to(PROJECT_ROOT)),
        "artifact_size_bytes": path.stat().st_size,
        "training_timestamp": None,
        "training_timestamp_status": "unavailable",
        "training_dataset": MODEL_DATASETS[model_name],
        "training_records": sidecar.get("train_rows") if sidecar else None,
        "test_records": sidecar.get("test_rows") if sidecar else None,
        "dataset_metadata": sidecar,
        "metrics": sidecar.get("test") if sidecar else None,
        "features": sidecar.get("features") if sidecar else None,
        "task": sidecar.get("task") if sidecar else None,
        "data_caveat": sidecar.get("data_caveat") if sidecar else None,
    }
    if estimator is not None:
        info["classes"] = [value.item() if hasattr(value, "item") else value for value in getattr(estimator, "classes_", [])]
    return info


def get_model_catalog() -> list[dict[str, Any]]:
    models = []
    for model_name in MODEL_NAMES:
        try:
            info = _artifact_info(model_name)
            info["status"] = "available"
        except FileNotFoundError as exc:
            sidecar = _read_sidecar(model_name)
            info = {
                "model_name": model_name,
                "model_version": None,
                "algorithm": None,
                "status": "unavailable",
                "artifact_status": "missing",
                "training_timestamp": None,
                "training_timestamp_status": "unavailable",
                "training_dataset": MODEL_DATASETS[model_name],
                "training_records": sidecar.get("train_rows") if sidecar else None,
                "test_records": sidecar.get("test_rows") if sidecar else None,
                "dataset_metadata": sidecar,
                "metrics": sidecar.get("test") if sidecar else None,
                "features": sidecar.get("features") if sidecar else None,
                "task": sidecar.get("task") if sidecar else None,
                "data_caveat": sidecar.get("data_caveat") if sidecar else None,
                "message": str(exc),
            }
        models.append(info)
    return models


def _latest_database_metrics(db: Session, model_name: str) -> ModelMetric | None:
    return db.scalar(
        select(ModelMetric)
        .where(ModelMetric.model_name == model_name)
        .order_by(ModelMetric.evaluated_at.desc(), ModelMetric.metric_id.desc())
        .limit(1)
    )


def get_performance(db: Session, start_date: date | None, end_date: date | None) -> list[dict[str, Any]]:
    results = []
    for model_name in MODEL_NAMES:
        query = select(ModelMetric).where(ModelMetric.model_name == model_name)
        if start_date is not None:
            query = query.where(ModelMetric.evaluated_at >= datetime.combine(start_date, datetime.min.time()))
        if end_date is not None:
            query = query.where(ModelMetric.evaluated_at < datetime.combine(end_date + timedelta(days=1), datetime.min.time()))
        metric = db.scalar(query.order_by(ModelMetric.evaluated_at.desc(), ModelMetric.metric_id.desc()).limit(1))
        if metric is not None:
            values = dict(metric.metrics_json or {})
            values.update({
                "model_name": model_name,
                "model_version": metric.model_version,
                "evaluated_at": metric.evaluated_at,
                "sample_size": metric.sample_size,
                "mae": float(metric.mae) if metric.mae is not None else values.get("mae"),
                "rmse": float(metric.rmse) if metric.rmse is not None else values.get("rmse"),
                "r2_score": float(metric.r2_score) if metric.r2_score is not None else values.get("r2_score"),
                "source": "database",
                "training_timestamp": values.get("training_timestamp"),
                "training_timestamp_status": values.get("training_timestamp_status", "unavailable"),
            })
            results.append(values)
            continue
        sidecar = _read_sidecar(model_name)
        baseline = sidecar.get("test") if sidecar else {}
        item = {
            "model_name": model_name,
            "model_version": model_version(model_name) if (ARTIFACT_DIR / f"{model_name}.joblib").is_file() else None,
            "algorithm": _algorithm(load_model_artifact(model_name)) if (ARTIFACT_DIR / f"{model_name}.joblib").is_file() else None,
            "evaluated_at": None,
            "sample_size": sidecar.get("test_rows") if sidecar else None,
            "training_records": sidecar.get("train_rows") if sidecar else None,
            "metrics": baseline,
            "source": "artifact_metrics" if sidecar else "unavailable",
            "status": "baseline_metadata_only" if sidecar else "unavailable",
            "training_timestamp": None,
            "training_timestamp_status": "unavailable",
        }
        item.update(baseline)
        item["mae"] = baseline.get("mae")
        item["rmse"] = baseline.get("rmse")
        item["r2_score"] = baseline.get("r2", baseline.get("r2_score"))
        item["accuracy"] = baseline.get("accuracy")
        results.append(item)
    return results


def get_performance_trend(
    db: Session,
    start_date: date | None,
    end_date: date | None,
    model_name: str | None,
    limit: int = 500,
) -> dict[str, Any]:
    query = select(ModelMetric).order_by(ModelMetric.evaluated_at.asc(), ModelMetric.metric_id.asc())
    if model_name is not None:
        query = query.where(ModelMetric.model_name == model_name)
    if start_date is not None:
        query = query.where(ModelMetric.evaluated_at >= datetime.combine(start_date, datetime.min.time()))
    if end_date is not None:
        query = query.where(ModelMetric.evaluated_at < datetime.combine(end_date + timedelta(days=1), datetime.min.time()))
    rows = db.scalars(query.limit(limit)).all()
    points = []
    for row in rows:
        values = dict(row.metrics_json or {})
        points.append({
            "model_name": row.model_name,
            "model_version": row.model_version,
            "evaluated_at": row.evaluated_at,
            "sample_size": row.sample_size,
            "metrics": values,
            "mae": float(row.mae) if row.mae is not None else values.get("mae"),
            "rmse": float(row.rmse) if row.rmse is not None else values.get("rmse"),
            "r2_score": float(row.r2_score) if row.r2_score is not None else values.get("r2_score"),
        })
    return {
        "status": "available" if points else "unavailable",
        "data": points,
        "message": None if points else "No persisted evaluation history is available for this date range.",
    }


def _expiry_prediction_table_available(db: Session) -> bool:
    return inspect(db.get_bind()).has_table(ExpiryRiskPrediction.__tablename__)


def _risk_label(probability: float, expiry_date: date | None, today: date) -> str:
    if expiry_date is not None and expiry_date < today:
        return "Expired"
    if probability >= 0.70:
        return "High Risk"
    if probability >= 0.45:
        return "Medium Risk"
    if probability >= 0.20:
        return "Low Risk"
    return "Safe"


def get_overview(db: Session, start_date: date | None, end_date: date | None) -> dict[str, Any]:
    date_filter_start = datetime.combine(start_date, datetime.min.time()) if start_date else None
    date_filter_end = datetime.combine(end_date + timedelta(days=1), datetime.min.time()) if end_date else None
    now = datetime.now()
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    def monthly_statistics(model: Any, column: Any) -> tuple[int, int, Counter[str]]:
        year = extract("year", column)
        month = extract("month", column)
        query = select(
            year,
            month,
            func.count(),
            func.sum(case((column >= month_start, 1), else_=0)),
        ).select_from(model)
        if date_filter_start is not None:
            query = query.where(column >= date_filter_start)
        if date_filter_end is not None:
            query = query.where(column < date_filter_end)
        rows = db.execute(query.group_by(year, month)).all()
        monthly_counts: Counter[str] = Counter()
        total = 0
        current_month = 0
        for row_year, row_month, row_count, row_month_count in rows:
            count = int(row_count or 0)
            total += count
            current_month += int(row_month_count or 0)
            monthly_counts[f"{int(row_year):04d}-{int(row_month):02d}"] += count
        return total, current_month, monthly_counts

    forecast_total, forecast_month, forecast_trend = monthly_statistics(
        DemandForecast, DemandForecast.created_at
    )
    recommendation_total, recommendation_month, recommendation_trend = monthly_statistics(
        Recommendation, Recommendation.created_at
    )
    expiry_available = _expiry_prediction_table_available(db)
    if expiry_available:
        expiry_total, expiry_month, expiry_trend = monthly_statistics(
            ExpiryRiskPrediction, ExpiryRiskPrediction.predicted_at
        )
    else:
        expiry_total, expiry_month, expiry_trend = 0, 0, Counter()
    counts = {
        "demand_forecast": forecast_total,
        "expiry_risk": expiry_total if expiry_available else None,
        "discount_recommendation": recommendation_total,
    }
    trend_counts = forecast_trend + recommendation_trend + expiry_trend
    total_predictions = forecast_total + recommendation_total + expiry_total
    monthly_predictions = forecast_month + recommendation_month + expiry_month
    return {
        "status": "available" if total_predictions else "unavailable",
        "total_predictions": total_predictions,
        "monthly_predictions": monthly_predictions,
        "predictions_by_model": counts,
        "monthly_by_model": {
            "demand_forecast": forecast_month,
            "expiry_risk": expiry_month if expiry_available else None,
            "discount_recommendation": recommendation_month,
        },
        "monthly_trend": [
            {"month": month, "count": trend_counts[month]}
            for month in sorted(trend_counts)
        ],
        "prediction_sources": {
            "demand_forecast": "demand_forecasts",
            "expiry_risk": "expiry_risk_predictions" if expiry_available else None,
            "discount_recommendation": "recommendations",
        },
        "unavailable": ["expiry_risk"] if not expiry_available else [],
    }


def get_prediction_distribution(db: Session, start_date: date | None, end_date: date | None) -> dict[str, Any]:
    recommendation_query = select(Recommendation.recommendation_type, func.count()).group_by(Recommendation.recommendation_type)
    if start_date is not None:
        recommendation_query = recommendation_query.where(Recommendation.created_at >= datetime.combine(start_date, datetime.min.time()))
    if end_date is not None:
        recommendation_query = recommendation_query.where(Recommendation.created_at < datetime.combine(end_date + timedelta(days=1), datetime.min.time()))
    recommendation_counts = [
        {"type": kind, "count": count}
        for kind, count in db.execute(recommendation_query).all()
    ]

    today = date.today()
    risk_distribution = None
    if _expiry_prediction_table_available(db):
        risk_label = case(
            (InventoryBatch.expiry_date < today, "Expired"),
            (ExpiryRiskPrediction.risk_probability >= 0.70, "High Risk"),
            (ExpiryRiskPrediction.risk_probability >= 0.45, "Medium Risk"),
            (ExpiryRiskPrediction.risk_probability >= 0.20, "Low Risk"),
            else_="Safe",
        )
        risk_query = (
            select(risk_label, func.count())
            .select_from(ExpiryRiskPrediction)
            .join(InventoryBatch, InventoryBatch.batch_id == ExpiryRiskPrediction.batch_id)
        )
        if start_date is not None:
            risk_query = risk_query.where(ExpiryRiskPrediction.predicted_at >= datetime.combine(start_date, datetime.min.time()))
        if end_date is not None:
            risk_query = risk_query.where(ExpiryRiskPrediction.predicted_at < datetime.combine(end_date + timedelta(days=1), datetime.min.time()))
        risk_counts = dict(db.execute(risk_query.group_by(risk_label)).all())
        risk_distribution = [
            {"risk_level": label, "count": int(risk_counts.get(label, 0))}
            for label in RISK_CLASSES
        ]

    demand_query = select(
        func.count(),
        func.min(DemandForecast.predicted_demand),
        func.max(DemandForecast.predicted_demand),
        func.avg(DemandForecast.predicted_demand),
    )
    demand_query = demand_query.select_from(DemandForecast)
    if start_date is not None:
        demand_query = demand_query.where(DemandForecast.created_at >= datetime.combine(start_date, datetime.min.time()))
    if end_date is not None:
        demand_query = demand_query.where(DemandForecast.created_at < datetime.combine(end_date + timedelta(days=1), datetime.min.time()))
    demand_count, demand_minimum, demand_maximum, demand_mean = db.execute(demand_query).one()
    demand_summary = None
    if demand_count:
        demand_summary = {
            "count": int(demand_count),
            "minimum": float(demand_minimum),
            "maximum": float(demand_maximum),
            "mean": float(demand_mean),
        }
    return {
        "status": "available" if demand_count or recommendation_counts or risk_distribution is not None else "unavailable",
        "demand_forecasts": demand_summary,
        "expiry_risk": risk_distribution,
        "discount_recommendations": recommendation_counts,
        "unavailable": ["expiry_risk"] if risk_distribution is None else [],
    }


def get_feature_importance(model_name: str, top_n: int) -> dict[str, Any]:
    if model_name not in MODEL_NAMES:
        raise KeyError(model_name)
    model = load_model_artifact(model_name)
    estimator = _estimator(model)
    importances = getattr(estimator, "feature_importances_", None)
    if importances is None:
        return {
            "model_name": model_name,
            "status": "unavailable",
            "message": f"{_algorithm(model)} does not expose native feature importances.",
            "features": [],
        }
    if not getattr(model, "steps", None):
        names = list(getattr(model, "feature_names_in_", []))
        return {
            "model_name": model_name,
            "status": "available" if names else "unavailable",
            "features": [
                {"feature": name, "importance": float(value), "importance_percent": float(value) * 100}
                for name, value in sorted(zip(names, importances), key=lambda row: row[1], reverse=True)[:top_n]
            ],
        }

    preprocessor = model.named_steps.get("preprocessor")
    transformed_names = list(preprocessor.get_feature_names_out()) if preprocessor is not None else []
    raw_features = list(model.named_steps["preprocessor"].feature_names_in_) if preprocessor is not None else transformed_names
    totals: defaultdict[str, float] = defaultdict(float)
    for transformed_name, value in zip(transformed_names, importances):
        normalized = transformed_name.split("__", 1)[-1]
        matched = next(
            (feature for feature in raw_features if normalized == feature or normalized.startswith(f"{feature}_")),
            normalized,
        )
        totals[matched] += float(value)
    total_importance = sum(totals.values())
    features = [
        {
            "feature": feature,
            "importance": value,
            "importance_percent": (value / total_importance * 100) if total_importance else 0.0,
        }
        for feature, value in sorted(totals.items(), key=lambda row: row[1], reverse=True)[:top_n]
    ]
    return {
        "model_name": model_name,
        "algorithm": _algorithm(model),
        "status": "available",
        "importance_method": "Random Forest impurity-based feature_importances_, one-hot columns aggregated to source feature",
        "features": features,
    }


def _chronological_split(frame: pd.DataFrame, column: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    dates = np.sort(frame[column].dropna().unique())
    if len(dates) < 2:
        raise ValueError(f"At least two distinct dates are required in {column}.")
    split_index = min(max(int(len(dates) * 0.8), 1), len(dates) - 1)
    cutoff = dates[split_index]
    train = frame.loc[frame[column] < cutoff]
    test = frame.loc[frame[column] >= cutoff]
    if train.empty or test.empty:
        raise ValueError(f"Chronological holdout split is empty for {column}.")
    return train, test


def _regression_results(actual: pd.Series, predicted: np.ndarray) -> dict[str, float]:
    mse = float(mean_squared_error(actual, predicted))
    return {
        "mae": float(mean_absolute_error(actual, predicted)),
        "mse": mse,
        "rmse": math.sqrt(mse),
        "r2": float(r2_score(actual, predicted)),
    }


def _prepare_demand_holdout(frame: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series, pd.DataFrame]:
    required = {
        "product_id", "date", "category", "opening_stock", "units_received",
        "units_sold", "unit_price", "discount_pct", "days_to_expiry",
    }
    missing = required.difference(frame.columns)
    if missing:
        raise ValueError(f"Demand evaluation data is missing columns: {sorted(missing)}.")
    data = frame.copy()
    data["date"] = pd.to_datetime(data["date"], errors="raise")
    data = data.sort_values(["product_id", "date"]).reset_index(drop=True)
    sales = data.groupby("product_id", sort=False)["units_sold"]
    data["sales_lag_1"] = sales.shift(1)
    data["sales_lag_7"] = sales.shift(7)
    data["sales_mean_previous_7d"] = sales.transform(lambda values: values.shift(1).rolling(7, min_periods=7).mean())
    data["calendar_month"] = data["date"].dt.month
    data["calendar_day_of_week"] = data["date"].dt.day_of_week
    data["calendar_day_of_month"] = data["date"].dt.day
    data["calendar_day_of_year"] = data["date"].dt.day_of_year
    data = data.dropna(subset=["sales_lag_1", "sales_lag_7", "sales_mean_previous_7d"])
    features = [
        column for column in data.columns
        if column not in {"date", "units_sold", "temperature_c", "stockout_flag", "waste_units"}
    ]
    _, test = _chronological_split(data, "date")
    return test[features], test["units_sold"], test


def _prepare_expiry_holdout(frame: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series, pd.DataFrame]:
    required = {
        "product_id", "category", "snapshot_date", "received_at", "expiry_date",
        "initial_quantity", "quantity_remaining", "days_to_expiry", "avg_daily_sales_7d",
        "expected_demand_before_expiry", "unit_price", "unit_cost", "discount_pct",
        "expiry_risk_label",
    }
    missing = required.difference(frame.columns)
    if missing:
        raise ValueError(f"Expiry evaluation data is missing columns: {sorted(missing)}.")
    data = frame.copy()
    for column in ("snapshot_date", "received_at", "expiry_date"):
        data[column] = pd.to_datetime(data[column], errors="raise")
    data["received_age_days"] = (data["snapshot_date"] - data["received_at"]).dt.days
    data["calendar_month"] = data["snapshot_date"].dt.month
    data["calendar_day_of_week"] = data["snapshot_date"].dt.day_of_week
    data["shelf_life_days"] = (data["expiry_date"] - data["received_at"]).dt.days
    target = "expiry_risk_label"
    excluded = {
        target, "batch_id", "waste_units_actual_simulated", "snapshot_date",
        "received_at", "expiry_date",
    }
    features = [column for column in data.columns if column not in excluded]
    _, test = _chronological_split(data, "snapshot_date")
    return test[features], test[target].astype(int), test


def _prepare_discount_holdout(frame: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series, pd.DataFrame, pd.DataFrame]:
    required = {
        "batch_id", "product_id", "days_to_expiry", "quantity_remaining",
        "discount_pct", "estimated_gross_margin_simulated",
    }
    missing = required.difference(frame.columns)
    if missing:
        raise ValueError(f"Discount evaluation data is missing columns: {sorted(missing)}.")
    data = frame.copy()
    data["product_id"] = data["product_id"].astype(str)
    features = ["product_id", "days_to_expiry", "quantity_remaining", "discount_pct"]
    splitter = GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=42)
    train_indices, test_indices = next(
        splitter.split(data[features], data["estimated_gross_margin_simulated"], groups=data["batch_id"])
    )
    train, test = data.iloc[train_indices], data.iloc[test_indices]
    return test[features], test["estimated_gross_margin_simulated"], test, train


def evaluate_model(model_name: str) -> dict[str, Any]:
    if model_name not in MODEL_NAMES:
        raise KeyError(model_name)
    model = load_model_artifact(model_name)
    data_path = DATA_DIR / MODEL_DATASETS[model_name]
    if not data_path.is_file():
        raise FileNotFoundError(f"Evaluation dataset not found: {data_path}")
    frame = pd.read_csv(data_path)

    if model_name == "demand_forecast":
        features, actual, holdout = _prepare_demand_holdout(frame)
        predicted = model.predict(features)
        metrics = _regression_results(actual, predicted)
        task = "regression"
        training_rows = max(int(len(frame) - len(holdout)), 0)
        split_description = "chronological 80/20 date holdout; fitted model evaluated without refitting"
        confusion = None
    elif model_name == "expiry_risk":
        features, actual, holdout = _prepare_expiry_holdout(frame)
        predicted = model.predict(features)
        metrics = {
            "accuracy": float(accuracy_score(actual, predicted)),
            "precision": float(precision_score(actual, predicted, zero_division=0)),
            "recall": float(recall_score(actual, predicted, zero_division=0)),
            "f1": float(f1_score(actual, predicted, zero_division=0)),
            "balanced_accuracy": float(__import__("sklearn.metrics", fromlist=["balanced_accuracy_score"]).balanced_accuracy_score(actual, predicted)),
        }
        classes = [int(value) for value in getattr(_estimator(model), "classes_", sorted(pd.unique(actual)))]
        confusion = confusion_matrix(actual, predicted, labels=classes).tolist()
        metrics["confusion_matrix"] = {"labels": classes, "matrix": confusion}
        task = "binary_classification"
        training_rows = max(int(len(frame) - len(holdout)), 0)
        split_description = "chronological 80/20 snapshot_date holdout; fitted model evaluated without refitting"
        confusion = metrics["confusion_matrix"]
    else:
        features, actual, holdout, train = _prepare_discount_holdout(frame)
        predicted = model.predict(features)
        metrics = _regression_results(actual, predicted)
        task = "regression"
        training_rows = len(train)
        split_description = "80/20 GroupShuffleSplit by batch_id; fitted model evaluated without refitting"
        confusion = None

    return {
        "model_name": model_name,
        "algorithm": _algorithm(model),
        "model_version": model_version(model_name),
        "evaluated_at": datetime.now(timezone.utc).replace(tzinfo=None),
        "task": task,
        "metrics": metrics,
        "sample_size": int(len(actual)),
        "training_records": int(training_rows),
        "test_records": int(len(actual)),
        "training_dataset": MODEL_DATASETS[model_name],
        "training_timestamp": None,
        "training_timestamp_status": "unavailable",
        "split": split_description,
        "data_caveat": _read_sidecar(model_name).get("data_caveat") if _read_sidecar(model_name) else None,
        "confusion_matrix": confusion,
        "source": "held_out_dataset_re_evaluation",
    }


def save_evaluation(db: Session, result: dict[str, Any]) -> ModelMetric:
    values = result["metrics"]
    metric = ModelMetric(
        model_name=result["model_name"],
        model_version=result["model_version"],
        evaluated_at=result["evaluated_at"],
        mae=values.get("mae"),
        rmse=values.get("rmse"),
        r2_score=values.get("r2"),
        sample_size=result["sample_size"],
        metrics_json={
            **values,
            "algorithm": result["algorithm"],
            "task": result["task"],
            "training_records": result["training_records"],
            "test_records": result["test_records"],
            "training_dataset": result["training_dataset"],
            "training_timestamp": result["training_timestamp"],
            "training_timestamp_status": result["training_timestamp_status"],
            "split": result["split"],
            "data_caveat": result["data_caveat"],
            "source": result["source"],
        },
    )
    db.add(metric)
    db.commit()
    db.refresh(metric)
    return metric


def get_model_details(db: Session, model_name: str) -> dict[str, Any]:
    if model_name not in MODEL_NAMES:
        raise KeyError(model_name)
    info = _artifact_info(model_name)
    latest = _latest_database_metrics(db, model_name)
    info["latest_evaluation"] = None
    if latest is not None:
        info["latest_evaluation"] = {
            "evaluated_at": latest.evaluated_at,
            "model_version": latest.model_version,
            "sample_size": latest.sample_size,
            "metrics": latest.metrics_json or {},
            "source": "database",
        }
    return info


def _apply_datetime_filter(query: Any, column: Any, start_date: date | None, end_date: date | None) -> Any:
    if start_date is not None:
        query = query.where(column >= datetime.combine(start_date, datetime.min.time()))
    if end_date is not None:
        query = query.where(column < datetime.combine(end_date + timedelta(days=1), datetime.min.time()))
    return query


def get_recent_predictions(
    db: Session,
    model_name: str | None,
    start_date: date | None,
    end_date: date | None,
    limit: int,
) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    if model_name in (None, "demand_forecast"):
        query = select(DemandForecast, Product.name).join(Product, Product.product_id == DemandForecast.product_id)
        query = _apply_datetime_filter(query, DemandForecast.created_at, start_date, end_date)
        for forecast, product_name in db.execute(query.order_by(DemandForecast.created_at.desc()).limit(limit)).all():
            rows.append({
                "model_name": "demand_forecast",
                "prediction_id": forecast.forecast_id,
                "predicted_at": forecast.created_at,
                "product_id": forecast.product_id,
                "product_name": product_name,
                "forecast_date": forecast.forecast_date,
                "predicted_demand": float(forecast.predicted_demand),
                "lower_bound": float(forecast.lower_bound) if forecast.lower_bound is not None else None,
                "upper_bound": float(forecast.upper_bound) if forecast.upper_bound is not None else None,
                "model_version": forecast.model_version,
            })
    expiry_available = _expiry_prediction_table_available(db)
    if expiry_available and model_name in (None, "expiry_risk"):
        query = (
            select(
                ExpiryRiskPrediction.prediction_id,
                ExpiryRiskPrediction.batch_id,
                ExpiryRiskPrediction.predicted_class,
                ExpiryRiskPrediction.risk_probability,
                ExpiryRiskPrediction.model_version,
                ExpiryRiskPrediction.predicted_at,
                InventoryBatch.product_id,
                InventoryBatch.expiry_date,
                Product.name,
            )
            .join(InventoryBatch, InventoryBatch.batch_id == ExpiryRiskPrediction.batch_id)
            .join(Product, Product.product_id == InventoryBatch.product_id)
        )
        query = _apply_datetime_filter(query, ExpiryRiskPrediction.predicted_at, start_date, end_date)
        for item in db.execute(query.order_by(ExpiryRiskPrediction.predicted_at.desc()).limit(limit)).all():
            rows.append({
                "model_name": "expiry_risk",
                "prediction_id": item.prediction_id,
                "predicted_at": item.predicted_at,
                "batch_id": item.batch_id,
                "product_id": item.product_id,
                "product_name": item.name,
                "expiry_date": item.expiry_date,
                "predicted_class": item.predicted_class,
                "risk_probability": float(item.risk_probability),
                "risk_level": _risk_label(float(item.risk_probability), item.expiry_date, date.today()),
                "model_version": item.model_version,
            })
    if model_name in (None, "discount_recommendation"):
        query = (
            select(Recommendation, Product.name)
            .join(Product, Product.product_id == Recommendation.product_id)
        )
        query = _apply_datetime_filter(query, Recommendation.created_at, start_date, end_date)
        for recommendation, product_name in db.execute(query.order_by(Recommendation.created_at.desc()).limit(limit)).all():
            rows.append({
                "model_name": "discount_recommendation",
                "prediction_id": recommendation.recommendation_id,
                "predicted_at": recommendation.created_at,
                "product_id": recommendation.product_id,
                "product_name": product_name,
                "batch_id": recommendation.batch_id,
                "recommendation_type": recommendation.recommendation_type,
                "recommended_quantity": float(recommendation.recommended_quantity) if recommendation.recommended_quantity is not None else None,
                "discount_percent": float(recommendation.discount_percent) if recommendation.discount_percent is not None else None,
                "status": recommendation.status,
                "model_version": None,
                "prediction_source": "persisted_recommendation_record",
            })
    rows.sort(key=lambda row: row["predicted_at"], reverse=True)
    return {
        "status": "available" if rows else "unavailable",
        "items": rows[:limit],
        "count": len(rows[:limit]),
        "unavailable": ["expiry_risk"] if not expiry_available and model_name in (None, "expiry_risk") else [],
    }


def get_demand_actual_vs_predicted(
    db: Session, start_date: date | None, end_date: date | None, limit: int = 1000
) -> dict[str, Any]:
    query = select(DemandForecast).order_by(DemandForecast.forecast_date.desc()).limit(limit)
    if start_date is not None:
        query = query.where(DemandForecast.forecast_date >= start_date)
    if end_date is not None:
        query = query.where(DemandForecast.forecast_date <= end_date)
    forecasts = db.scalars(query).all()
    if not forecasts:
        return {"status": "unavailable", "items": [], "message": "No stored demand forecasts are available."}
    product_ids = {row.product_id for row in forecasts}
    min_date = min(row.forecast_date for row in forecasts)
    max_date = max(row.forecast_date for row in forecasts)
    sales = db.execute(
        select(SaleRecord.product_id, SaleRecord.sold_at, SaleRecord.quantity).where(
            SaleRecord.product_id.in_(product_ids),
            SaleRecord.sold_at >= datetime.combine(min_date, datetime.min.time()),
            SaleRecord.sold_at < datetime.combine(max_date + timedelta(days=1), datetime.min.time()),
        )
    ).all()
    actuals: defaultdict[tuple[int, date], float] = defaultdict(float)
    for product_id, sold_at, quantity in sales:
        actuals[(product_id, sold_at.date())] += float(quantity)
    items = []
    for row in forecasts:
        actual = actuals.get((row.product_id, row.forecast_date))
        predicted = float(row.predicted_demand)
        items.append({
            "product_id": row.product_id,
            "forecast_date": row.forecast_date,
            "predicted_demand": predicted,
            "actual_demand": actual,
            "error": (predicted - actual) if actual is not None else None,
            "model_version": row.model_version,
        })
    return {
        "status": "available",
        "items": items,
        "count": len(items),
        "actual_data_source": "sales_records",
        "unmatched_forecasts": sum(item["actual_demand"] is None for item in items),
    }


def validate_date_range(start_date: date | None, end_date: date | None) -> None:
    if start_date is not None and end_date is not None and start_date > end_date:
        raise HTTPException(status_code=422, detail="start_date must be on or before end_date.")


def create_retraining_job() -> dict[str, Any]:
    global _ACTIVE_RETRAIN_JOB
    with _RETRAIN_LOCK:
        if _ACTIVE_RETRAIN_JOB is not None and _RETRAIN_JOBS.get(_ACTIVE_RETRAIN_JOB, {}).get("status") in {"queued", "running"}:
            raise RuntimeError("A model retraining job is already active.")
        job_id = str(uuid.uuid4())
        _RETRAIN_JOBS[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "progress_percent": 0,
            "completed_models": [],
            "total_models": 4,
            "started_at": None,
            "completed_at": None,
            "error": None,
        }
        _ACTIVE_RETRAIN_JOB = job_id
        return dict(_RETRAIN_JOBS[job_id])


def update_retraining_job(job_id: str, **values: Any) -> None:
    with _RETRAIN_LOCK:
        if job_id in _RETRAIN_JOBS:
            _RETRAIN_JOBS[job_id].update(values)


def get_retraining_job(job_id: str) -> dict[str, Any] | None:
    with _RETRAIN_LOCK:
        item = _RETRAIN_JOBS.get(job_id)
        return dict(item) if item else None


def run_retraining_job(job_id: str) -> None:
    import subprocess
    import sys

    update_retraining_job(
        job_id,
        status="running",
        started_at=datetime.now(timezone.utc).isoformat(),
        progress_percent=5,
    )
    command = [
        sys.executable,
        "-c",
        (
            "import json; "
            "from ml.src.train_all import train_all; "
            "train_all(progress_callback=lambda name, done, total: "
            "print(json.dumps({'model': name, 'done': done, 'total': total}), flush=True))"
        ),
    ]
    completed_models: list[str] = []
    try:
        process = subprocess.Popen(
            command,
            cwd=PROJECT_ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
        )
        assert process.stdout is not None
        for line in process.stdout:
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            model_name = message.get("model")
            done = message.get("done")
            total = message.get("total")
            if isinstance(model_name, str) and isinstance(done, int) and isinstance(total, int) and total > 0:
                completed_models.append(model_name)
                update_retraining_job(
                    job_id,
                    progress_percent=min(95, int(done / total * 95)),
                    completed_models=list(completed_models),
                )
        return_code = process.wait()
        if return_code != 0:
            raise RuntimeError(f"Training process exited with status {return_code}.")
        update_retraining_job(
            job_id,
            status="completed",
            progress_percent=100,
            completed_models=completed_models,
            completed_at=datetime.now(timezone.utc).isoformat(),
        )
    except Exception as exc:
        update_retraining_job(
            job_id,
            status="failed",
            error=f"{type(exc).__name__}: {exc}",
            completed_models=completed_models,
            completed_at=datetime.now(timezone.utc).isoformat(),
        )
    finally:
        global _ACTIVE_RETRAIN_JOB
        with _RETRAIN_LOCK:
            if _ACTIVE_RETRAIN_JOB == job_id:
                _ACTIVE_RETRAIN_JOB = None
