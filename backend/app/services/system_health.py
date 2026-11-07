from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from threading import Lock
from typing import Any

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.services.model_artifacts import load_model_artifact

logger = logging.getLogger(__name__)
_PROCESS_STARTED_AT = time.monotonic()
_HEALTH_STATE_LOCK = Lock()
_LAST_SUCCESSFUL_HEALTH_CHECK: str | None = None
MODEL_ARTIFACTS = (
    ("demand_forecast", "demand_forecast.joblib"),
    ("discount_recommendation", "discount_recommendation.joblib"),
    ("expiry_risk", "expiry_risk.joblib"),
)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _check_database(db: Session) -> dict[str, str]:
    try:
        result = db.execute(text("SELECT 1")).scalar_one()
        if result != 1:
            raise RuntimeError("Unexpected connectivity check result.")
        return {"status": "available"}
    except SQLAlchemyError as exc:
        error_name = type(exc).__name__
        logger.warning("System health database check failed (%s).", error_name)
        return {
            "status": "unavailable",
            "message": f"Database connectivity check failed ({error_name}).",
        }
    except RuntimeError:
        logger.error("System health database check returned an unexpected result.")
        return {"status": "unavailable", "message": "Database connectivity check returned an unexpected result."}


def _check_models() -> list[dict[str, str]]:
    models: list[dict[str, str]] = []
    for model_name, artifact_name in MODEL_ARTIFACTS:
        try:
            load_model_artifact(model_name)
        except Exception as exc:
            error_name = type(exc).__name__
            logger.warning("System health model check failed for %s (%s).", model_name, error_name)
            models.append({
                "name": model_name,
                "artifact": artifact_name,
                "status": "unavailable",
                "message": f"Model could not be loaded ({error_name}).",
            })
        else:
            models.append({
                "name": model_name,
                "artifact": artifact_name,
                "status": "available",
            })
    return models


def collect_system_health(
    db: Session,
    *,
    is_admin: bool,
    app_version: str,
) -> dict[str, Any]:
    global _LAST_SUCCESSFUL_HEALTH_CHECK

    checked_at = _utc_now()
    database = _check_database(db)
    models = _check_models()
    healthy = database["status"] == "available" and all(
        model["status"] == "available" for model in models
    )
    with _HEALTH_STATE_LOCK:
        if healthy:
            _LAST_SUCCESSFUL_HEALTH_CHECK = checked_at
        last_successful = _LAST_SUCCESSFUL_HEALTH_CHECK

    result: dict[str, Any] = {
        "status": "healthy" if healthy else "degraded",
        "checked_at": checked_at,
        "last_successful_check": last_successful,
        "api": {"status": "available"},
        "frontend_backend": {
            "status": "connected",
            "message": "The authenticated health request reached the backend API.",
        },
        "database": database,
        "ml_models": models,
    }
    if is_admin:
        result["app_version"] = app_version
        result["uptime_seconds"] = max(0, int(time.monotonic() - _PROCESS_STARTED_AT))
        result["errors"] = [
            {"service": service, "message": check["message"]}
            for service, check in (
                ("database", database),
                *((model["name"], model) for model in models),
            )
            if check["status"] == "unavailable"
        ]
    return result
