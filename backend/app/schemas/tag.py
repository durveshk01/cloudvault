"""Tag schemas."""

import uuid

from pydantic import BaseModel, ConfigDict, Field, field_validator


class TagCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)

    @field_validator("name", mode="before")
    @classmethod
    def trim_name(cls, value):
        return value.strip().lower() if isinstance(value, str) else value


class TagResponse(BaseModel):
    id: uuid.UUID
    name: str

    model_config = ConfigDict(from_attributes=True)


class FileTagRequest(BaseModel):
    tag_ids: list[uuid.UUID] = Field(..., max_length=100)

    @field_validator("tag_ids")
    @classmethod
    def unique_ids(cls, values):
        return list(dict.fromkeys(values))
