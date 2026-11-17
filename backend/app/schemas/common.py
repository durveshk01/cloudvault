"""Common Pydantic schemas for pagination, errors, and messages."""

from pydantic import BaseModel


class PaginatedResponse[T](BaseModel):
    items: list[T]
    total: int
    page: int
    page_size: int
    total_pages: int


class MessageResponse(BaseModel):
    message: str


class ErrorResponse(BaseModel):
    detail: str
