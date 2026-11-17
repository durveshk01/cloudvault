"""User schemas."""

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator


class UserResponse(BaseModel):
    id: uuid.UUID
    email: EmailStr
    full_name: str
    storage_quota_bytes: int
    storage_used_bytes: int
    is_active: bool
    created_at: datetime
    updated_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)


class UserUpdate(BaseModel):
    full_name: str | None = Field(None, min_length=2, max_length=255)

    @field_validator("full_name", mode="before")
    @classmethod
    def trim_name(cls, value):
        return value.strip() if isinstance(value, str) else value


class CollaboratorResponse(BaseModel):
    id: uuid.UUID
    full_name: str
    email: EmailStr

    model_config = ConfigDict(from_attributes=True)
