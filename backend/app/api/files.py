"""File management API endpoints."""

import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query, UploadFile, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db
from app.models.user import User
from app.schemas.common import MessageResponse, PaginatedResponse
from app.schemas.file import (
    BulkActionRequest,
    BulkActionResponse,
    FileCopyRequest,
    FileMoveRequest,
    FileResponse,
    FileUpdate,
    FileVersionResponse,
    TagResponse,
    UploadCompleteRequest,
    UploadInitiateRequest,
    UploadInitiateResponse,
)
from app.services.download_service import stored_response
from app.services.file_service import FileService, validate_folder
from app.services.upload_service import UploadService
from app.storage import get_storage_provider

router = APIRouter(prefix="/api/files", tags=["Files"])


def _to_file_response(file) -> FileResponse:
    tags = []
    if hasattr(file, "file_tags") and file.file_tags:
        tags = [TagResponse(id=ft.tag.id, name=ft.tag.name) for ft in file.file_tags if ft.tag]
    resp = FileResponse.model_validate(file)
    resp.tags = tags
    return resp


@router.get("", response_model=PaginatedResponse[FileResponse])
def list_files(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    folder_id: uuid.UUID | None = Query(None),
    category: Literal["all", "document", "image", "video", "audio", "archive", "code"] | None = Query(None),
    tag: str | None = Query(None, max_length=100),
    search: str | None = Query(None, max_length=255),
    sort_by: Literal["created_at", "updated_at", "original_filename", "size_bytes"] = Query("created_at"),
    sort_order: Literal["asc", "desc"] = Query("desc"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    """List files with search, filtering, sorting, and pagination."""
    files, total = FileService.get_files(
        db=db,
        user_id=current_user.id,
        folder_id=folder_id,
        category=category,
        tag=tag,
        starred_only=False,
        trashed_only=False,
        search_query=search,
        sort_by=sort_by,
        sort_order=sort_order,
        page=page,
        page_size=page_size,
    )
    items = [_to_file_response(f) for f in files]
    total_pages = (total + page_size - 1) // page_size if total > 0 else 1
    return PaginatedResponse(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
        total_pages=total_pages,
    )


@router.post("/upload", response_model=FileResponse, status_code=status.HTTP_201_CREATED)
async def upload_file(
    file: UploadFile,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    folder_id: uuid.UUID | None = Query(None),
    idempotency_key: uuid.UUID | None = Header(None, alias="Idempotency-Key"),
):
    """Upload a file with size, type, and quota validation."""
    uploaded = await FileService.upload_file(db, current_user, file, folder_id=folder_id, request_id=idempotency_key)
    return _to_file_response(uploaded)


@router.post("/upload/initiate", response_model=UploadInitiateResponse)
def initiate_upload(
    req: UploadInitiateRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    """Initiate an upload session for direct or presigned transfers."""
    return UploadService.initiate(db, current_user, req)


@router.post("/upload/complete", response_model=FileResponse)
async def complete_upload(
    req: UploadCompleteRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    """Finalize an upload initiated via presigned URL."""
    return _to_file_response(await UploadService.complete(db, current_user, req))


@router.get("/{file_id}", response_model=FileResponse)
def get_file_metadata(
    file_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    """Get metadata for a specific file (owner or shared collaborator)."""
    file, _ = FileService.check_file_access(db, file_id, current_user.id)
    return _to_file_response(file)


@router.patch("/{file_id}", response_model=FileResponse)
def update_file(
    file_id: uuid.UUID,
    req: FileUpdate,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    """Update file filename or starred state."""
    file, permission = FileService.check_file_access(db, file_id, current_user.id)
    if file.is_trashed:
        raise HTTPException(status_code=409, detail="Restore this file before updating it.")
    if req.is_starred is not None and permission != "owner":
        raise HTTPException(status_code=403, detail="Only the owner can change favorites.")
    if req.original_filename is not None and permission == "viewer":
        raise HTTPException(status_code=403, detail="Viewers cannot rename files.")
    if "folder_id" in req.model_fields_set:
        if permission == "viewer":
            raise HTTPException(status_code=403, detail="Viewers cannot move files.")
        validate_folder(db, req.folder_id, file.owner_id)
    if req.original_filename:
        file = FileService.rename_file(db, file_id, current_user.id, req.original_filename)
    if req.is_starred is not None:
        file.is_starred = req.is_starred
        db.commit()
        db.refresh(file)
    if "folder_id" in req.model_fields_set:
        file = FileService.move_file(db, file_id, current_user.id, FileMoveRequest(folder_id=req.folder_id))
    return _to_file_response(file)


@router.delete("/{file_id}", response_model=MessageResponse)
def delete_file(
    file_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    """Move file to trash."""
    FileService.soft_delete_file(db, file_id, current_user.id)
    return MessageResponse(message="File moved to trash.")


@router.get("/{file_id}/download")
@router.post("/{file_id}/download")
async def download_file(
    file_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    direct: bool = Query(True, deprecated=True, description="Legacy option; all downloads now stream verified content."),
):
    """Download file contents securely."""
    file, _ = FileService.check_file_access(db, file_id, current_user.id)
    if file.is_trashed:
        raise HTTPException(status_code=409, detail="Restore this file before downloading it.")
    storage = get_storage_provider()

    # A mutable presigned object can differ from any bytes checked here.
    # Always serve the exact verified spool, including legacy direct=false requests.
    return await stored_response(storage, file)


@router.get("/{file_id}/preview")
async def preview_file(
    file_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    """Inline safe preview of file content for supported types."""
    file, _ = FileService.check_file_access(db, file_id, current_user.id)
    if file.is_trashed:
        raise HTTPException(status_code=409, detail="Restore this file before previewing it.")
    storage = get_storage_provider()
    return await stored_response(storage, file, preview=True)


@router.post("/{file_id}/move", response_model=FileResponse)
def move_file(
    file_id: uuid.UUID,
    req: FileMoveRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    """Move file into a different folder."""
    file = FileService.move_file(db, file_id, current_user.id, req)
    return _to_file_response(file)


@router.post("/{file_id}/copy", response_model=FileResponse)
async def copy_file(
    file_id: uuid.UUID,
    req: FileCopyRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    """Make a duplicate copy of a file."""
    new_file = await FileService.copy_file(db, file_id, current_user, req)
    return _to_file_response(new_file)


@router.post("/{file_id}/favorite", response_model=MessageResponse)
def toggle_favorite(
    file_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    """Toggle starred/favorite status of a file."""
    is_starred = FileService.toggle_star(db, file_id, current_user.id)
    return MessageResponse(message=f"File {'starred' if is_starred else 'unstarred'}.")


@router.delete("/{file_id}/favorite", response_model=MessageResponse)
def remove_favorite(
    file_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    file, permission = FileService.check_file_access(db, file_id, current_user.id)
    if permission != "owner":
        raise HTTPException(status_code=403, detail="Only the owner can change favorites.")
    file.is_starred = False
    db.commit()
    return MessageResponse(message="File unstarred.")


@router.post("/bulk-action", response_model=BulkActionResponse)
async def bulk_action(
    req: BulkActionRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    """Execute bulk actions across multiple files."""
    return await FileService.execute_bulk_action(db, current_user, req)


# --- Versioning endpoints ---


@router.get("/{file_id}/versions", response_model=list[FileVersionResponse])
def get_file_versions(
    file_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    """Retrieve complete version history for a file."""
    versions = FileService.get_file_versions(db, file_id, current_user.id)
    return [FileVersionResponse.model_validate(v) for v in versions]


@router.post("/{file_id}/versions", response_model=FileVersionResponse, status_code=status.HTTP_201_CREATED)
async def upload_new_version(
    file_id: uuid.UUID,
    file: UploadFile,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    idempotency_key: uuid.UUID | None = Header(None, alias="Idempotency-Key"),
):
    """Upload a new version of an existing file."""
    version = await FileService.upload_new_version(db, file_id, current_user, file, request_id=idempotency_key)
    return FileVersionResponse.model_validate(version)


@router.post("/{file_id}/versions/{version_id}/restore", response_model=FileResponse)
async def restore_version(
    file_id: uuid.UUID,
    version_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    """Restore file to a previous historical version."""
    file = await FileService.restore_version(db, file_id, version_id, current_user.id)
    return _to_file_response(file)
