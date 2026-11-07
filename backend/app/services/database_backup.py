import base64
import hashlib
import hmac
import json
import logging
import os
import re
import stat
import uuid
import zipfile
from datetime import date, datetime, time, timezone
from decimal import Decimal
from io import BytesIO
from pathlib import Path
from pathlib import PurePath
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import MetaData, Table, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import BACKEND_DIR, get_auth_secret, get_database_settings
from app.models import UserActivity

logger = logging.getLogger(__name__)

_DEFAULT_BACKUP_DIRECTORY = (
    Path(os.getenv("LOCALAPPDATA", str(BACKEND_DIR / "var")))
    / "WasteWiseAI"
    / "backups"
    if os.name == "nt"
    else BACKEND_DIR / "var" / "backups"
)
BACKUP_DIRECTORY = Path(
    os.getenv("WASTEWISE_BACKUP_DIR", str(_DEFAULT_BACKUP_DIRECTORY))
).expanduser()
BACKUP_FILENAME_RE = re.compile(
    r"^wastewise-db-(\d{8}T\d{6}Z)-([0-9a-f]{32})\.wwbackup$"
)
BACKUP_ARCHIVE_LIMIT = 256 * 1024 * 1024
BACKUP_PAYLOAD_LIMIT = 512 * 1024 * 1024
BACKUP_FORMAT_VERSION = 1
RESTORE_CONFIRMATION = "RESTORE DATABASE"
_ENCRYPTED_FILE_MAGIC = b"WWB1"
_ENCRYPTION_NONCE_BYTES = 12
_TYPE_KEY = "__wastewise_backup_value__"


class BackupError(Exception):
    def __init__(self, message: str, *, status_code: int = 422) -> None:
        super().__init__(message)
        self.status_code = status_code


def _backup_key() -> bytes:
    return hashlib.sha256(
        b"wastewise-database-backup-v1:" + get_auth_secret().encode("utf-8")
    ).digest()


def _sign(payload: bytes) -> str:
    return hmac.new(_backup_key(), payload, hashlib.sha256).hexdigest()


def _encryption_key() -> bytes:
    return hmac.new(_backup_key(), b"wastewise-backup-encryption-v1", hashlib.sha256).digest()


def _encode_value(value: Any) -> Any:
    if isinstance(value, datetime):
        return {_TYPE_KEY: ["datetime", value.isoformat()]}
    if isinstance(value, date):
        return {_TYPE_KEY: ["date", value.isoformat()]}
    if isinstance(value, time):
        return {_TYPE_KEY: ["time", value.isoformat()]}
    if isinstance(value, Decimal):
        return {_TYPE_KEY: ["decimal", str(value)]}
    if isinstance(value, bytes):
        return {_TYPE_KEY: ["bytes", base64.b64encode(value).decode("ascii")]}
    if isinstance(value, dict):
        if _TYPE_KEY in value:
            return {
                _TYPE_KEY: [
                    "mapping",
                    [[str(key), _encode_value(item)] for key, item in value.items()],
                ]
            }
        return {str(key): _encode_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_encode_value(item) for item in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise BackupError(f"Database value type {type(value).__name__} is not supported.")


def _decode_value(value: Any) -> Any:
    if isinstance(value, list):
        return [_decode_value(item) for item in value]
    if not isinstance(value, dict):
        return value
    if set(value) == {_TYPE_KEY} and isinstance(value[_TYPE_KEY], list):
        tag = value[_TYPE_KEY]
        if len(tag) != 2 or not isinstance(tag[0], str):
            raise BackupError("The backup contains an invalid encoded value.")
        kind, data = tag
        if kind == "mapping" and isinstance(data, list):
            return {key: _decode_value(item) for key, item in data}
        if not isinstance(data, str):
            raise BackupError("The backup contains an invalid encoded value.")
        try:
            if kind == "datetime":
                return datetime.fromisoformat(data)
            if kind == "date":
                return date.fromisoformat(data)
            if kind == "time":
                return time.fromisoformat(data)
            if kind == "decimal":
                return Decimal(data)
            if kind == "bytes":
                return base64.b64decode(data, validate=True)
        except (ValueError, ArithmeticError) as exc:
            raise BackupError("The backup contains an invalid encoded value.") from exc
        raise BackupError("The backup contains an unsupported encoded value.")
    return {key: _decode_value(item) for key, item in value.items()}


def _canonical_json(value: Any) -> bytes:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise BackupError("The database contains values that cannot be safely backed up.") from exc


def _reflect(connection: Any) -> MetaData:
    metadata = MetaData()
    metadata.reflect(bind=connection)
    if not metadata.tables:
        raise BackupError("No database tables were found to back up.", status_code=503)
    return metadata


def _schema_signature(metadata: MetaData, dialect: Any) -> str:
    schema = []
    for table in sorted(metadata.tables.values(), key=lambda item: item.fullname):
        schema.append(
            {
                "name": table.fullname,
                "columns": [
                    {
                        "name": column.name,
                        "type": column.type.compile(dialect=dialect),
                        "nullable": column.nullable,
                        "primary_key": column.primary_key,
                    }
                    for column in table.columns
                ],
            }
        )
    return hashlib.sha256(_canonical_json(schema)).hexdigest()


def _database_fingerprint() -> str:
    settings = get_database_settings()
    identity = f"{settings.host}:{settings.port}/{settings.name}".encode("utf-8")
    return hmac.new(_backup_key(), b"database:" + identity, hashlib.sha256).hexdigest()


def _private_backup_directory() -> Path:
    directory = BACKUP_DIRECTORY
    if directory.exists() and directory.is_symlink():
        raise BackupError("The configured backup directory must not be a symbolic link.", status_code=503)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    resolved = directory.resolve(strict=True)
    if not resolved.is_dir():
        raise BackupError("The configured backup location is not a directory.", status_code=503)
    project_root = BACKEND_DIR.parent
    static_directories = (
        BACKEND_DIR / "static",
        BACKEND_DIR / "app" / "static",
        project_root / "frontend" / "public",
        project_root / "frontend" / "dist",
    )
    if any(resolved == item.resolve() or item.resolve() in resolved.parents for item in static_directories):
        raise BackupError("The backup directory must be outside static or web-served directories.", status_code=503)
    try:
        os.chmod(resolved, stat.S_IRWXU)
    except OSError:
        if os.name != "nt":
            raise BackupError("The backup directory permissions could not be secured.", status_code=503)
    return resolved


def _backup_path(backup_id: str) -> Path:
    try:
        parsed_id = uuid.UUID(hex=backup_id)
    except (ValueError, AttributeError) as exc:
        raise BackupError("The requested backup was not found.", status_code=404) from exc
    if parsed_id.hex != backup_id.casefold():
        raise BackupError("The requested backup was not found.", status_code=404)
    directory = _private_backup_directory()
    matches = [
        path for path in directory.iterdir()
        if BACKUP_FILENAME_RE.fullmatch(path.name)
        and path.name.endswith(f"-{parsed_id.hex}.wwbackup")
        and not path.is_symlink()
    ]
    if len(matches) != 1:
        raise BackupError("The requested backup was not found.", status_code=404)
    return matches[0]


def _make_archive(payload: dict[str, Any]) -> bytes:
    payload_bytes = _canonical_json(payload)
    if len(payload_bytes) > BACKUP_PAYLOAD_LIMIT:
        raise BackupError("The database snapshot exceeds the 512 MB uncompressed backup limit.", status_code=413)
    envelope = _canonical_json({"payload": payload, "signature": _sign(payload_bytes)})
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("backup.json", envelope)
    nonce = os.urandom(_ENCRYPTION_NONCE_BYTES)
    encrypted_bytes = AESGCM(_encryption_key()).encrypt(nonce, buffer.getvalue(), _ENCRYPTED_FILE_MAGIC)
    archive_bytes = _ENCRYPTED_FILE_MAGIC + nonce + encrypted_bytes
    if len(archive_bytes) > BACKUP_ARCHIVE_LIMIT:
        raise BackupError("The database snapshot exceeds the 256 MB backup file limit.", status_code=413)
    return archive_bytes


def _parse_archive(
    archive_bytes: bytes,
    *,
    expected_backup_id: str | None = None,
) -> dict[str, Any]:
    if not archive_bytes or len(archive_bytes) > BACKUP_ARCHIVE_LIMIT:
        raise BackupError("The backup file is empty or exceeds the supported size.")
    if (
        len(archive_bytes) <= len(_ENCRYPTED_FILE_MAGIC) + _ENCRYPTION_NONCE_BYTES
        or not archive_bytes.startswith(_ENCRYPTED_FILE_MAGIC)
    ):
        raise BackupError("The backup file is not a supported encrypted WasteWise backup.")
    nonce_start = len(_ENCRYPTED_FILE_MAGIC)
    nonce = archive_bytes[nonce_start : nonce_start + _ENCRYPTION_NONCE_BYTES]
    try:
        decrypted = AESGCM(_encryption_key()).decrypt(
            nonce,
            archive_bytes[nonce_start + _ENCRYPTION_NONCE_BYTES :],
            _ENCRYPTED_FILE_MAGIC,
        )
        with zipfile.ZipFile(BytesIO(decrypted), "r") as archive:
            entries = archive.infolist()
            if (
                len(entries) != 1
                or entries[0].filename != "backup.json"
                or entries[0].file_size > BACKUP_PAYLOAD_LIMIT
                or entries[0].is_dir()
            ):
                raise BackupError("The backup archive structure is invalid.")
            envelope = json.loads(archive.read(entries[0]).decode("utf-8"))
    except (InvalidTag, zipfile.BadZipFile, UnicodeDecodeError, json.JSONDecodeError, OSError, RuntimeError) as exc:
        raise BackupError("The backup file is corrupt or has an unsupported format.") from exc
    if not isinstance(envelope, dict) or set(envelope) != {"payload", "signature"}:
        raise BackupError("The backup file is missing required integrity metadata.")
    payload = envelope["payload"]
    signature = envelope["signature"]
    if not isinstance(payload, dict) or not isinstance(signature, str):
        raise BackupError("The backup file is missing required integrity metadata.")
    if not hmac.compare_digest(_sign(_canonical_json(payload)), signature):
        raise BackupError("The backup integrity check failed.")
    if payload.get("format_version") != BACKUP_FORMAT_VERSION:
        raise BackupError("This backup was created with an unsupported format version.")
    if expected_backup_id and payload.get("backup_id") != expected_backup_id:
        raise BackupError("The backup identifier does not match the requested backup.")
    if payload.get("database_fingerprint") != _database_fingerprint():
        raise BackupError("This backup belongs to a different configured database.")
    if not isinstance(payload.get("created_at"), str) or not isinstance(payload.get("tables"), list):
        raise BackupError("The backup metadata is incomplete.")
    return payload


def _write_archive(archive_bytes: bytes, backup_id: str, created_at: datetime) -> Path:
    directory = _private_backup_directory()
    filename = f"wastewise-db-{created_at:%Y%m%dT%H%M%SZ}-{backup_id}.wwbackup"
    path = directory / filename
    temporary_path = path.with_name(f"{filename}.tmp")
    try:
        with temporary_path.open("xb") as backup_file:
            if os.name != "nt":
                os.chmod(temporary_path, stat.S_IRUSR | stat.S_IWUSR)
            backup_file.write(archive_bytes)
            backup_file.flush()
            os.fsync(backup_file.fileno())
        os.replace(temporary_path, path)
    except OSError:
        temporary_path.unlink(missing_ok=True)
        raise
    return path


def create_backup(db: Session, actor_id: int) -> dict[str, Any]:
    backup_id = uuid.uuid4().hex
    created_at = datetime.now(timezone.utc).replace(microsecond=0)
    backup_path: Path | None = None
    try:
        connection = db.connection()
        metadata = _reflect(connection)
        tables = []
        total_rows = 0
        for table in sorted(metadata.tables.values(), key=lambda item: item.fullname):
            rows = [
                {column: _encode_value(value) for column, value in row.items()}
                for row in connection.execute(select(table)).mappings()
            ]
            total_rows += len(rows)
            tables.append(
                {
                    "name": table.fullname,
                    "columns": [column.name for column in table.columns],
                    "rows": rows,
                }
            )
        payload = {
            "format_version": BACKUP_FORMAT_VERSION,
            "backup_id": backup_id,
            "created_at": created_at.isoformat(),
            "database_fingerprint": _database_fingerprint(),
            "schema_signature": _schema_signature(metadata, connection.dialect),
            "tables": tables,
            "row_count": total_rows,
        }
        archive_bytes = _make_archive(payload)
        backup_path = _write_archive(archive_bytes, backup_id, created_at)
        db.add(
            UserActivity(
                user_id=actor_id,
                action="database_backup_created",
                entity_type="database_backup",
                entity_id=None,
                details={
                    "backup_id": backup_id,
                    "filename": backup_path.name,
                    "size_bytes": len(archive_bytes),
                    "row_count": total_rows,
                    "status": "completed",
                },
            )
        )
        db.commit()
    except Exception:
        db.rollback()
        if backup_path is not None:
            try:
                backup_path.unlink(missing_ok=True)
            except OSError:
                logger.exception("Could not remove a backup file after its database audit failed.")
        raise
    return {
        "backup_id": backup_id,
        "filename": backup_path.name,
        "created_at": created_at.isoformat(),
        "size_bytes": len(archive_bytes),
        "row_count": total_rows,
        "status": "completed",
    }


def _verified_backup(backup_id: str) -> tuple[Path, bytes, dict[str, Any]]:
    path = _backup_path(backup_id)
    try:
        if path.stat().st_size > BACKUP_ARCHIVE_LIMIT:
            raise BackupError("The backup file exceeds the supported size.")
        archive_bytes = path.read_bytes()
    except OSError as exc:
        logger.exception("Could not read the selected database backup.")
        raise BackupError("The backup file could not be read.", status_code=503) from exc
    payload = _parse_archive(archive_bytes, expected_backup_id=uuid.UUID(hex=backup_id).hex)
    return path, archive_bytes, payload


def download_backup(backup_id: str) -> tuple[str, bytes]:
    path, archive_bytes, _ = _verified_backup(backup_id)
    return path.name, archive_bytes


def import_backup(
    db: Session,
    actor_id: int,
    filename: str | None,
    archive_bytes: bytes,
) -> dict[str, Any]:
    if (
        not filename
        or PurePath(filename).name != filename
        or "/" in filename
        or "\\" in filename
        or PurePath(filename).suffix.casefold() != ".wwbackup"
    ):
        raise BackupError("Choose a WasteWise .wwbackup file without a path.", status_code=415)
    if not archive_bytes or len(archive_bytes) > BACKUP_ARCHIVE_LIMIT:
        raise BackupError("The backup file is empty or exceeds the 256 MB limit.", status_code=413)

    payload = _parse_archive(archive_bytes)
    backup_id = payload.get("backup_id")
    if not isinstance(backup_id, str) or not re.fullmatch(r"[0-9a-f]{32}", backup_id):
        raise BackupError("The backup contains an invalid identifier.")
    try:
        created_at = datetime.fromisoformat(payload["created_at"])
    except (TypeError, ValueError) as exc:
        raise BackupError("The backup contains an invalid creation date.") from exc
    if created_at.tzinfo is None or created_at.utcoffset() is None:
        raise BackupError("The backup creation date must include a timezone.")
    created_at = created_at.astimezone(timezone.utc).replace(microsecond=0)

    connection = db.connection()
    metadata = _reflect(connection)
    _validate_restore_payload(payload, metadata, connection.dialect)
    backup_path: Path | None = None
    try:
        try:
            _backup_path(backup_id)
        except BackupError as exc:
            if exc.status_code != 404:
                raise
        else:
            raise BackupError("A backup with this identifier already exists.", status_code=409)

        backup_path = _write_archive(archive_bytes, backup_id, created_at)
        db.add(
            UserActivity(
                user_id=actor_id,
                action="database_backup_imported",
                entity_type="database_backup",
                details={
                    "backup_id": backup_id,
                    "filename": backup_path.name,
                    "size_bytes": len(archive_bytes),
                    "row_count": payload.get("row_count", 0),
                    "status": "available",
                },
            )
        )
        db.commit()
    except Exception:
        db.rollback()
        if backup_path is not None:
            try:
                backup_path.unlink(missing_ok=True)
            except OSError:
                logger.exception("Could not remove an imported backup after its audit failed.")
        raise
    return {
        "backup_id": backup_id,
        "filename": backup_path.name,
        "created_at": created_at.isoformat(),
        "size_bytes": len(archive_bytes),
        "row_count": payload.get("row_count", 0),
        "status": "available",
    }


def _validate_restore_payload(
    payload: dict[str, Any],
    metadata: MetaData,
    dialect: Any,
) -> list[tuple[Table[Any], list[dict[str, Any]]]]:
    if payload.get("schema_signature") != _schema_signature(metadata, dialect):
        raise BackupError(
            "The backup schema does not match the current database. No data was changed.",
            status_code=409,
        )
    raw_tables = payload.get("tables")
    if not isinstance(raw_tables, list) or len(raw_tables) != len(metadata.tables):
        raise BackupError("The backup does not contain the complete current schema.")
    by_name: dict[str, dict[str, Any]] = {}
    for item in raw_tables:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            raise BackupError("The backup contains invalid table metadata.")
        if item["name"] in by_name:
            raise BackupError("The backup contains duplicate table entries.")
        by_name[item["name"]] = item
    if set(by_name) != set(metadata.tables):
        raise BackupError(
            "The backup schema does not match the current database. No data was changed.",
            status_code=409,
        )
    decoded: list[tuple[Table[Any], list[dict[str, Any]]]] = []
    for table in metadata.sorted_tables:
        item = by_name[table.fullname]
        columns = item.get("columns")
        rows = item.get("rows")
        expected_columns = [column.name for column in table.columns]
        if columns != expected_columns or not isinstance(rows, list):
            raise BackupError("The backup contains invalid or incomplete table data.")
        decoded_rows: list[dict[str, Any]] = []
        for row in rows:
            if not isinstance(row, dict) or set(row) != set(expected_columns):
                raise BackupError("The backup contains an invalid table row.")
            decoded_row = {column: _decode_value(value) for column, value in row.items()}
            decoded_rows.append(decoded_row)
        decoded.append((table, decoded_rows))
    return decoded


def record_restore_failure(db: Session, actor_id: int, backup_id: str) -> None:
    try:
        db.rollback()
        db.add(
            UserActivity(
                user_id=actor_id,
                action="database_restore_failed",
                entity_type="database_backup",
                details={"backup_id": backup_id, "status": "failed"},
            )
        )
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        logger.exception("Could not record the failed database restore attempt.")


def restore_backup(db: Session, backup_id: str, actor_id: int, confirmation_text: str) -> dict[str, Any]:
    if confirmation_text != RESTORE_CONFIRMATION:
        raise BackupError(
            f'Type "{RESTORE_CONFIRMATION}" exactly to confirm this restore.',
            status_code=400,
        )
    _, _, payload = _verified_backup(backup_id)
    connection = db.connection()
    metadata = _reflect(connection)
    decoded_tables = _validate_restore_payload(payload, metadata, connection.dialect)

    safety_backup = create_backup(db, actor_id)
    connection = db.connection()
    preserved_events = db.execute(
        select(
            UserActivity.user_id,
            UserActivity.action,
            UserActivity.entity_type,
            UserActivity.entity_id,
            UserActivity.details,
            UserActivity.created_at,
        ).where(
            UserActivity.action.in_(
                (
                    "session_revoked",
                    "database_backup_created",
                    "database_backup_imported",
                    "database_backup_failed",
                    "database_backup_import_failed",
                    "database_restore_completed",
                    "database_restore_failed",
                )
            )
        )
    ).all()
    foreign_key_checks_disabled = False
    try:
        if connection.dialect.name == "mysql":
            connection.exec_driver_sql("SET FOREIGN_KEY_CHECKS=0")
            foreign_key_checks_disabled = True
        for table in reversed(metadata.sorted_tables):
            connection.execute(table.delete())
        for table, rows in decoded_tables:
            if rows:
                connection.execute(table.insert(), rows)
        for event in preserved_events:
            details = dict(event.details) if isinstance(event.details, dict) else {}
            if event.user_id is not None:
                details.setdefault("actor_user_id", event.user_id)
            db.add(
                UserActivity(
                    user_id=None,
                    action=event.action,
                    entity_type=event.entity_type,
                    entity_id=event.entity_id,
                    details=details,
                    created_at=event.created_at,
                )
            )
        db.add(
            UserActivity(
                user_id=None,
                action="database_restore_completed",
                entity_type="database_backup",
                details={
                    "backup_id": backup_id,
                    "actor_user_id": actor_id,
                    "safety_backup_id": safety_backup["backup_id"],
                    "status": "completed",
                },
            )
        )
        if foreign_key_checks_disabled:
            connection.exec_driver_sql("SET FOREIGN_KEY_CHECKS=1")
            foreign_key_checks_disabled = False
        db.commit()
    except Exception:
        db.rollback()
        if foreign_key_checks_disabled:
            try:
                db.connection().exec_driver_sql("SET FOREIGN_KEY_CHECKS=1")
            except SQLAlchemyError:
                logger.exception("Could not re-enable MySQL foreign-key checks after a failed restore.")
        record_restore_failure(db, actor_id, backup_id)
        raise
    return {
        "backup_id": backup_id,
        "status": "completed",
        "restored_at": datetime.now(timezone.utc).isoformat(),
        "safety_backup_id": safety_backup["backup_id"],
    }


def list_backups(db: Session) -> list[dict[str, Any]]:
    directory = _private_backup_directory()
    backups: dict[str, dict[str, Any]] = {}
    for path in directory.iterdir():
        match = BACKUP_FILENAME_RE.fullmatch(path.name)
        if not match or path.is_symlink() or not path.is_file():
            continue
        backup_id = match.group(2)
        try:
            if path.stat().st_size > BACKUP_ARCHIVE_LIMIT:
                raise BackupError("The backup file exceeds the supported size.")
            archive_bytes = path.read_bytes()
            payload = _parse_archive(archive_bytes, expected_backup_id=backup_id)
            backups[backup_id] = {
                "backup_id": backup_id,
                "filename": path.name,
                "created_at": payload["created_at"],
                "size_bytes": len(archive_bytes),
                "row_count": payload.get("row_count", 0),
                "status": "available",
            }
        except BackupError:
            backups[backup_id] = {
                "backup_id": backup_id,
                "filename": path.name,
                "created_at": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(),
                "size_bytes": path.stat().st_size,
                "row_count": 0,
                "status": "invalid",
            }

    created = db.query(UserActivity).filter(
        UserActivity.action.in_(("database_backup_created", "database_backup_imported"))
    ).order_by(UserActivity.created_at.desc()).limit(100)
    for activity in created:
        details = activity.details or {}
        backup_id = details.get("backup_id")
        if not isinstance(backup_id, str) or not re.fullmatch(r"[0-9a-f]{32}", backup_id):
            continue
        if backup_id in backups:
            continue
        backups[backup_id] = {
            "backup_id": backup_id,
            "filename": str(details.get("filename") or "Backup file missing"),
            "created_at": activity.created_at.replace(tzinfo=timezone.utc).isoformat(),
            "size_bytes": int(details.get("size_bytes") or 0),
            "row_count": int(details.get("row_count") or 0),
            "status": "missing",
        }

    failures = db.query(UserActivity).filter(
        UserActivity.action.in_(("database_backup_failed", "database_backup_import_failed"))
    ).order_by(UserActivity.created_at.desc()).limit(50)
    for activity in failures:
        details = activity.details or {}
        backups[f"failed-{activity.activity_id}"] = {
            "backup_id": None,
            "filename": str(details.get("filename") or "Backup not created"),
            "created_at": activity.created_at.replace(tzinfo=timezone.utc).isoformat(),
            "size_bytes": 0,
            "row_count": 0,
            "status": "failed",
        }
    return sorted(backups.values(), key=lambda item: item["created_at"], reverse=True)[:100]


def record_backup_failure(db: Session, actor_id: int, *, operation: str = "create") -> None:
    action = "database_backup_import_failed" if operation == "import" else "database_backup_failed"
    try:
        db.rollback()
        db.add(
            UserActivity(
                user_id=actor_id,
                action=action,
                entity_type="database_backup",
                details={
                    "status": "failed",
                    "operation": operation,
                    "filename": "Backup not created" if operation == "create" else "Backup import rejected",
                },
            )
        )
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        logger.exception("Could not record the failed database backup attempt.")
