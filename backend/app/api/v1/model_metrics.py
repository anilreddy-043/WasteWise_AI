from __future__ import annotations

from datetime import date
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import get_current_user, require_admin
from app.db.session import get_db
from app.models import ModelMetric, User
from app.services.model_metrics_service import (
    MODEL_NAMES,
    create_retraining_job,
    evaluate_model,
    get_feature_importance,
    get_model_catalog,
    get_model_details,
    get_overview,
    get_performance,
    get_performance_trend,
    get_prediction_distribution,
    get_recent_predictions,
    get_retraining_job,
    run_retraining_job,
    save_evaluation,
    validate_date_range,
)

router = APIRouter(prefix="/model-metrics", tags=["model-metrics"])
ModelName = Literal["demand_forecast", "expiry_risk", "discount_recommendation"]


class RetrainingRequest(BaseModel):
    confirm: bool = False


def _validate_model_name(model_name: str) -> None:
    if model_name not in MODEL_NAMES:
        raise HTTPException(status_code=404, detail=f"Unknown model: {model_name}.")


def _artifact_error(exc: FileNotFoundError) -> HTTPException:
    return HTTPException(status_code=503, detail=str(exc))


@router.get("")
def list_model_metrics(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    model_name: str | None = None,
    limit: int = Query(default=100, ge=1, le=500),
) -> list[dict[str, object]]:
    query = select(ModelMetric).order_by(ModelMetric.evaluated_at.desc(), ModelMetric.metric_id.desc())
    if model_name:
        query = query.where(ModelMetric.model_name == model_name)
    persisted = db.scalars(query.limit(limit)).all()
    if persisted:
        return [
            {
                "metric_id": row.metric_id,
                "model_name": row.model_name,
                "model_version": row.model_version,
                "evaluated_at": row.evaluated_at,
                "mae": row.mae,
                "rmse": row.rmse,
                "r2_score": row.r2_score,
                "sample_size": row.sample_size,
                "metrics_json": row.metrics_json,
                "source": "database",
            }
            for row in persisted[:limit]
        ]
    return [
        {
            "metric_id": 0,
            "model_name": item["model_name"],
            "model_version": item.get("model_version"),
            "evaluated_at": None,
            "mae": (item.get("metrics") or {}).get("mae"),
            "rmse": (item.get("metrics") or {}).get("rmse"),
            "r2_score": (item.get("metrics") or {}).get("r2", (item.get("metrics") or {}).get("r2_score")),
            "sample_size": item.get("test_records") or 0,
            "metrics_json": item.get("dataset_metadata"),
            "source": "artifact_metrics",
        }
        for item in get_model_catalog()
        if item.get("status") == "available"
        and (model_name is None or item["model_name"] == model_name)
    ][:limit]


@router.get("/overview")
def model_metrics_overview(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    start_date: date | None = None,
    end_date: date | None = None,
) -> dict[str, object]:
    validate_date_range(start_date, end_date)
    return get_overview(db, start_date, end_date)


@router.get("/models")
def models(_: User = Depends(get_current_user)) -> list[dict[str, object]]:
    return get_model_catalog()


@router.get("/performance")
def model_performance(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    start_date: date | None = None,
    end_date: date | None = None,
) -> list[dict[str, object]]:
    validate_date_range(start_date, end_date)
    return get_performance(db, start_date, end_date)


@router.get("/performance-trend")
def model_performance_trend(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    model_name: ModelName | None = None,
    start_date: date | None = None,
    end_date: date | None = None,
    limit: int = Query(default=500, ge=1, le=5000),
) -> dict[str, object]:
    validate_date_range(start_date, end_date)
    return get_performance_trend(db, start_date, end_date, model_name, limit)


@router.get("/prediction-distribution")
def prediction_distribution(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    start_date: date | None = None,
    end_date: date | None = None,
) -> dict[str, object]:
    validate_date_range(start_date, end_date)
    return get_prediction_distribution(db, start_date, end_date)


@router.get("/feature-importance/{model_name}")
def feature_importance(
    model_name: ModelName,
    _: User = Depends(get_current_user),
    top_n: int = Query(default=20, ge=1, le=100),
) -> dict[str, object]:
    try:
        return get_feature_importance(model_name, top_n)
    except FileNotFoundError as exc:
        raise _artifact_error(exc) from exc


@router.get("/recent-predictions")
def recent_predictions(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    model_name: ModelName | None = None,
    start_date: date | None = None,
    end_date: date | None = None,
    limit: int = Query(default=50, ge=1, le=500),
) -> dict[str, object]:
    validate_date_range(start_date, end_date)
    return get_recent_predictions(db, model_name, start_date, end_date, limit)


@router.get("/demand/actual-vs-predicted")
def actual_vs_predicted_demand(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    start_date: date | None = None,
    end_date: date | None = None,
    limit: int = Query(default=1000, ge=1, le=5000),
) -> dict[str, object]:
    from app.services.model_metrics_service import get_demand_actual_vs_predicted

    validate_date_range(start_date, end_date)
    return get_demand_actual_vs_predicted(db, start_date, end_date, limit)


@router.get("/models/{model_name}/details")
def model_details(
    model_name: str,
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    _validate_model_name(model_name)
    try:
        return get_model_details(db, model_name)
    except FileNotFoundError as exc:
        raise _artifact_error(exc) from exc


@router.post("/models/{model_name}/evaluate", status_code=status.HTTP_201_CREATED)
def evaluate_model_endpoint(
    model_name: str,
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    _validate_model_name(model_name)
    try:
        result = evaluate_model(model_name)
    except FileNotFoundError as exc:
        raise _artifact_error(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    saved = save_evaluation(db, result)
    result["metric_id"] = saved.metric_id
    result["source"] = "database"
    return result


@router.post("/retrain-all", status_code=status.HTTP_202_ACCEPTED)
def retrain_all(
    payload: RetrainingRequest,
    background_tasks: BackgroundTasks,
    _: User = Depends(require_admin),
) -> dict[str, object]:
    if not payload.confirm:
        raise HTTPException(status_code=400, detail="Set confirm=true to explicitly start model retraining.")
    try:
        job = create_retraining_job()
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    background_tasks.add_task(run_retraining_job, job["job_id"])
    return job


@router.get("/retrain-all/{job_id}")
def retraining_status(
    job_id: str,
    _: User = Depends(require_admin),
) -> dict[str, object]:
    job = get_retraining_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Retraining job was not found in this API process.")
    return job