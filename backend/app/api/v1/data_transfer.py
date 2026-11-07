import logging
from pathlib import PurePath
from typing import Literal

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import Response
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.security import require_admin
from app.db.session import get_db
from app.models import User, UserActivity
from app.services.data_transfer import (
    MAX_IMPORT_BYTES,
    CsvImportError,
    decode_csv,
    export_bytes,
    import_csv,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/data", tags=["data-transfer"])


def _record_import_failure(
    db: Session,
    user: User,
    dataset: str,
    reason: str,
    *,
    failed_records: int | None = None,
    total_records: int | None = None,
) -> None:
    try:
        db.rollback()
        details: dict[str, object] = {"dataset": dataset, "failure_reason": reason}
        if failed_records is not None:
            details["failed_records"] = failed_records
        if total_records is not None:
            details["total_records"] = total_records
        db.add(
            UserActivity(
                user_id=user.user_id,
                action="data_import_failed",
                entity_type=dataset,
                details=details,
            )
        )
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("Could not record a failed %s import.", dataset)
        raise HTTPException(
            status_code=503,
            detail="The import failed, and its audit event could not be saved.",
        ) from exc


@router.post("/imports/{dataset}")
async def import_data(
    dataset: Literal["products", "inventory", "sales"],
    file: UploadFile = File(...),
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    try:
        filename = PurePath(file.filename or "").name
        if not filename or PurePath(filename).suffix.casefold() != ".csv":
            _record_import_failure(db, user, dataset, "invalid_file_type")
            raise HTTPException(status_code=415, detail="Choose a .csv file.")

        contents = await file.read(MAX_IMPORT_BYTES + 1)
        if len(contents) > MAX_IMPORT_BYTES:
            _record_import_failure(db, user, dataset, "file_too_large")
            raise HTTPException(status_code=413, detail="CSV files must be 5 MB or smaller.")
        csv_text = decode_csv(contents)
        result = import_csv(
            db,
            dataset,
            csv_text,
            user_id=user.user_id,
            filename=filename[:255],
        )
        if result["failed_records"]:
            _record_import_failure(
                db,
                user,
                dataset,
                "row_validation_failed",
                failed_records=int(result["failed_records"]),
                total_records=int(result["total_records"]),
            )
        return result
    except CsvImportError as exc:
        _record_import_failure(db, user, dataset, "invalid_csv")
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except IntegrityError as exc:
        db.rollback()
        _record_import_failure(db, user, dataset, "record_conflict")
        logger.info("CSV import for %s conflicted with existing records.", dataset)
        raise HTTPException(
            status_code=409,
            detail="The import conflicts with existing records. No rows were committed.",
        ) from exc
    except SQLAlchemyError as exc:
        db.rollback()
        _record_import_failure(db, user, dataset, "database_error")
        logger.exception("CSV import for %s failed.", dataset)
        raise HTTPException(
            status_code=503,
            detail="The import could not be completed. No rows were committed.",
        ) from exc
    finally:
        await file.close()


@router.get("/exports/{dataset}")
def export_data(
    dataset: Literal["products", "inventory", "sales", "waste", "reports"],
    file_format: Literal["csv", "xlsx"] = Query(default="csv", alias="format"),
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> Response:
    try:
        contents = export_bytes(db, dataset, file_format)
        db.add(
            UserActivity(
                user_id=user.user_id,
                action="data_exported",
                entity_type=dataset,
                details={"dataset": dataset, "format": file_format},
            )
        )
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("Could not export %s data.", dataset)
        raise HTTPException(status_code=503, detail="The requested export is temporarily unavailable.") from exc
    suffix = "xlsx" if file_format == "xlsx" else "csv"
    media_type = (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        if file_format == "xlsx"
        else "text/csv; charset=utf-8"
    )
    return Response(
        content=contents,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="wastewise-{dataset}-export.{suffix}"'},
    )
