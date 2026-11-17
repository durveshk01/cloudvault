"""Share and ShareLink schemas."""

import uuid
from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.schemas.file import FileResponse
from app.schemas.user import CollaboratorResponse


class FileShareCreate(BaseModel):
    shared_with_email: EmailStr
    permission: Literal["viewer", "editor"] = "viewer"


class FileShareResponse(BaseModel):
    id: uuid.UUID
    file_id: uuid.UUID
    shared_by: uuid.UUID
    shared_with: uuid.UUID
    permission: str
    created_at: datetime
    file: FileResponse | None = None
    sharer: CollaboratorResponse | None = None
    recipient: CollaboratorResponse | None = None

    model_config = ConfigDict(from_attributes=True)


class ShareLinkCreate(BaseModel):
    expires_at: datetime | None = None
    password: str | None = Field(None, min_length=4, max_length=100)
    max_downloads: int | None = Field(None, ge=1, le=1000000)
    permission: Literal["view", "download"] = "view"

    @field_validator("expires_at")
    @classmethod
    def expiry_in_utc(cls, value):
        if value is None:
            return None
        return (value.replace(tzinfo=UTC) if value.tzinfo is None else value).astimezone(UTC)


class ShareLinkResponse(BaseModel):
    id: uuid.UUID
    file_id: uuid.UUID
    token: str | None = None
    expires_at: datetime | None = None
    max_downloads: int | None = None
    download_count: int = 0
    permission: str
    is_revoked: bool = False
    created_at: datetime
    share_url: str | None = None

    model_config = ConfigDict(from_attributes=True)


class ShareLinkPublicResponse(BaseModel):
    token: str
    filename: str
    file_size: int
    mime_type: str | None
    permission: str
    requires_password: bool
    is_expired: bool
    downloads_remaining: int | None = None
    preview_supported: bool = False


class ShareLinkVerifyRequest(BaseModel):
    password: str | None = Field(None, max_length=100)
