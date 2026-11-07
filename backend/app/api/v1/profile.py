import logging

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.security import get_current_user
from app.db.session import get_db
from app.models import User, UserActivity
from app.schemas.profile import ProfileResponse, ProfileUpdate
from app.services.product_images import IMAGE_EXTENSIONS, MAX_PRODUCT_IMAGE_BYTES, validate_product_image
from app.services.profile_images import (
    delete_profile_image,
    profile_image_path,
    profile_image_url,
    save_profile_image,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/profile", tags=["profile"])


def _profile_response(user: User) -> ProfileResponse:
    return ProfileResponse(
        user_id=user.user_id,
        full_name=user.full_name,
        email=user.email,
        role=user.role,
        approval_status=user.approval_status,
        is_active=user.is_active,
        created_at=user.created_at,
        profile_image_url=profile_image_url(user.user_id),
    )


def _commit_activity(db: Session, *, user: User, action: str) -> None:
    db.add(
        UserActivity(
            user_id=user.user_id,
            action=action,
            entity_type="user",
            entity_id=user.user_id,
            details={"changed_fields": ["full_name"]} if action == "profile_updated" else None,
        )
    )
    try:
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        logger.exception("Profile activity could not be committed.")
        raise HTTPException(status_code=503, detail="The profile change could not be saved.") from exc


@router.get("", response_model=ProfileResponse)
def get_profile(user: User = Depends(get_current_user)) -> ProfileResponse:
    return _profile_response(user)


@router.patch("", response_model=ProfileResponse)
def update_profile(
    payload: ProfileUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ProfileResponse:
    if payload.full_name != user.full_name:
        user.full_name = payload.full_name
        db.add(
            UserActivity(
                user_id=user.user_id,
                action="profile_updated",
                entity_type="user",
                entity_id=user.user_id,
                details={"changed_fields": ["full_name"]},
            )
        )
        try:
            db.commit()
            db.refresh(user)
        except SQLAlchemyError as exc:
            db.rollback()
            logger.exception("Profile update could not be committed.")
            raise HTTPException(status_code=503, detail="The profile change could not be saved.") from exc
    return _profile_response(user)


@router.post("/image")
async def upload_profile_image(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    contents = await file.read(MAX_PRODUCT_IMAGE_BYTES + 1)
    if len(contents) > MAX_PRODUCT_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Profile images must be 5 MB or smaller.")
    if file.content_type not in IMAGE_EXTENSIONS:
        raise HTTPException(status_code=415, detail="Upload a PNG, JPG, JPEG, or WebP image.")

    extension = validate_product_image(file.content_type, contents)
    if extension is None:
        raise HTTPException(status_code=422, detail="The uploaded file is not a valid supported image.")

    previous_path = profile_image_path(user.user_id)
    previous_contents = previous_path.read_bytes() if previous_path is not None else None
    previous_extension = previous_path.suffix if previous_path is not None else None
    try:
        save_profile_image(user.user_id, extension, contents)
        _commit_activity(db, user=user, action="profile_image_updated")
    except HTTPException:
        if previous_contents is None:
            delete_profile_image(user.user_id)
        else:
            save_profile_image(user.user_id, previous_extension or "", previous_contents)
        raise
    except OSError as exc:
        db.rollback()
        logger.exception("Profile image could not be stored.")
        if previous_contents is None:
            delete_profile_image(user.user_id)
        else:
            save_profile_image(user.user_id, previous_extension or "", previous_contents)
        raise HTTPException(status_code=500, detail="The profile image could not be stored.") from exc

    image_url = profile_image_url(user.user_id)
    if image_url is None:
        raise HTTPException(status_code=500, detail="The uploaded profile image could not be retrieved.")
    return {"profile_image_url": image_url}


@router.get("/image", include_in_schema=False)
def get_profile_image(user: User = Depends(get_current_user)) -> FileResponse:
    path = profile_image_path(user.user_id)
    if path is None:
        raise HTTPException(status_code=404, detail="No profile image is available.")
    media_type = {
        ".jpg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
    }[path.suffix]
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "private, no-store"})


@router.delete("/image", status_code=status.HTTP_204_NO_CONTENT)
def remove_profile_image(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    previous_path = profile_image_path(user.user_id)
    if previous_path is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    previous_contents = previous_path.read_bytes()
    previous_extension = previous_path.suffix
    try:
        delete_profile_image(user.user_id)
        _commit_activity(db, user=user, action="profile_image_removed")
    except HTTPException:
        save_profile_image(user.user_id, previous_extension, previous_contents)
        raise
    except OSError as exc:
        db.rollback()
        logger.exception("Profile image could not be removed.")
        save_profile_image(user.user_id, previous_extension, previous_contents)
        raise HTTPException(status_code=500, detail="The profile image could not be removed.") from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)
