from typing import Any

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.core.security import require_roles
from app.db.session import get_db
from app.models import User
from app.services.system_health import collect_system_health

router = APIRouter(prefix="/system-health", tags=["system-health"])


@router.get("")
def get_system_health(
    request: Request,
    user: User = Depends(require_roles("admin", "store_manager")),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    return collect_system_health(
        db,
        is_admin=user.role == "admin",
        app_version=request.app.version,
    )
