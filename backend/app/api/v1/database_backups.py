import logging
from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, Path, UploadFile, status
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.security import require_admin
from app.db.session import get_db
from app.models import User
from app.services.database_backup import (
    BACKUP_ARCHIVE_LIMIT,
    BackupError,
    create_backup,
    download_backup,
    import_backup,
    list_backups,
    record_backup_failure,
    record_restore_failure,
    restore_backup,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/backups", tags=["database-backups"])


class RestoreConfirmation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    confirm_restore: bool = Field(
        description="Must be true to explicitly authorize replacing live database records."
    )
    confirmation_text: str = Field(min_length=1, max_length=40)


@router.get("")
def get_backup_history(
    _: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> list[dict[str, object]]:
    try:
        return list_backups(db)
    except (BackupError, OSError) as exc:
        detail = exc.args[0] if isinstance(exc, BackupError) else "Backup history is temporarily unavailable."
        status_code = exc.status_code if isinstance(exc, BackupError) else status.HTTP_503_SERVICE_UNAVAILABLE
        raise HTTPException(status_code=status_code, detail=detail) from exc
    except SQLAlchemyError as exc:
        logger.exception("Could not load database backup history.")
        raise HTTPException(status_code=503, detail="Backup history is temporarily unavailable.") from exc


@router.post("", status_code=status.HTTP_201_CREATED)
def create_database_backup(
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    try:
        return create_backup(db, user.user_id)
    except BackupError as exc:
        record_backup_failure(db, user.user_id)
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except (SQLAlchemyError, OSError) as exc:
        record_backup_failure(db, user.user_id)
        logger.exception("Database backup creation failed.")
        raise HTTPException(
            status_code=503,
            detail="The database backup could not be completed. No backup was created.",
        ) from exc


@router.post("/upload", status_code=status.HTTP_201_CREATED)
async def upload_database_backup(
    file: UploadFile = File(...),
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    try:
        if file.size is not None and file.size > BACKUP_ARCHIVE_LIMIT:
            raise HTTPException(status_code=413, detail="Backup files must be 256 MB or smaller.")
        contents = await file.read(BACKUP_ARCHIVE_LIMIT + 1)
        if len(contents) > BACKUP_ARCHIVE_LIMIT:
            raise HTTPException(status_code=413, detail="Backup files must be 256 MB or smaller.")
        return import_backup(db, user.user_id, file.filename, contents)
    except BackupError as exc:
        record_backup_failure(db, user.user_id, operation="import")
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except HTTPException as exc:
        record_backup_failure(db, user.user_id, operation="import")
        raise
    except (SQLAlchemyError, OSError) as exc:
        record_backup_failure(db, user.user_id, operation="import")
        logger.exception("Database backup import failed.")
        raise HTTPException(
            status_code=503,
            detail="The backup could not be validated or stored.",
        ) from exc
    finally:
        await file.close()


@router.get("/{backup_id}/download")
def get_database_backup(
    backup_id: Annotated[str, Path(pattern=r"^[0-9a-fA-F]{32}$")],
    _: User = Depends(require_admin),
) -> Response:
    try:
        filename, contents = download_backup(backup_id)
    except BackupError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except OSError as exc:
        logger.exception("Database backup download failed.")
        raise HTTPException(status_code=503, detail="The backup file could not be downloaded.") from exc
    if len(contents) > BACKUP_ARCHIVE_LIMIT:
        raise HTTPException(status_code=413, detail="The backup file exceeds the supported download size.")
    return Response(
        content=contents,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/{backup_id}/restore")
def restore_database_backup(
    backup_id: Annotated[str, Path(pattern=r"^[0-9a-fA-F]{32}$")],
    confirmation: RestoreConfirmation,
    user: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    if not confirmation.confirm_restore:
        record_restore_failure(db, user.user_id, backup_id)
        raise HTTPException(status_code=400, detail="Explicit restore confirmation is required.")
    try:
        return restore_backup(db, backup_id, user.user_id, confirmation.confirmation_text)
    except BackupError as exc:
        record_restore_failure(db, user.user_id, backup_id)
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except SQLAlchemyError as exc:
        record_restore_failure(db, user.user_id, backup_id)
        logger.exception("Database restore failed.")
        raise HTTPException(
            status_code=503,
            detail="The restore could not be completed. The database transaction was rolled back.",
        ) from exc
    except OSError as exc:
        record_restore_failure(db, user.user_id, backup_id)
        logger.exception("Database restore backup file could not be accessed.")
        raise HTTPException(status_code=503, detail="The selected backup could not be read.") from exc
