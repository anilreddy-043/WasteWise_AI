from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ProfileUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    full_name: str = Field(min_length=1, max_length=120)

    @field_validator("full_name")
    @classmethod
    def trim_full_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Full name cannot be empty.")
        return value


class ProfileResponse(BaseModel):
    user_id: int
    full_name: str
    email: str
    role: str
    approval_status: str
    is_active: bool
    created_at: datetime
    profile_image_url: str | None
