"""Trash and Data Recovery API endpoints."""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db
from app.models.file import File
from app.models.folder import Folder
from app.models.user import User
from app.schemas.common import MessageResponse, PaginatedResponse
from app.schemas.file import FileResponse
from app.schemas.folder import FolderResponse
from app.services.file_service import FileService
from app.services.folder_service import FolderService

router = APIRouter(prefix="/api/trash", tags=["Trash"])


@router.get("/folders", response_model=PaginatedResponse[FolderResponse])
def get_trashed_folders(
    current_user: Annotated[User, Depends(get_current_user)], db: Annotated[Session, Depends(get_db)],
    page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=100),
):
    query = select(Folder).where(Folder.owner_id == current_user.id, Folder.is_trashed.is_(True))
    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    items = db.scalars(query.order_by(Folder.trashed_at.desc(), Folder.id).offset((page - 1) * page_size).limit(page_size)).all()
    return PaginatedResponse(items=[FolderResponse.model_validate(folder) for folder in items], total=total, page=page, page_size=page_size, total_pages=max(1, (total + page_size - 1) // page_size))


@router.post("/folders/{folder_id}/restore", response_model=MessageResponse)
def restore_trashed_folder(folder_id: uuid.UUID, current_user: Annotated[User, Depends(get_current_user)], db: Annotated[Session, Depends(get_db)]):
    count = FolderService.restore_folder(db, folder_id, current_user.id)
    return MessageResponse(message=f"Folder restored with {count} files. Independently deleted items remain in trash.")


@router.delete("/folders/{folder_id}/permanent", response_model=MessageResponse)
async def purge_trashed_folder(folder_id: uuid.UUID, current_user: Annotated[User, Depends(get_current_user)], db: Annotated[Session, Depends(get_db)]):
    count = await FolderService.permanent_delete_folder(db, folder_id, current_user.id)
    return MessageResponse(message=f"Folder permanently deleted with {count} files.")


@router.get("", response_model=PaginatedResponse[FileResponse])
def get_trash_items(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=100),
):
    """List all files in trash."""
    files, total = FileService.get_files(
        db,
        user_id=current_user.id,
        trashed_only=True,
        sort_by="trashed_at",
        sort_order="desc",
        page=page,
        page_size=page_size,
    )
    items = [FileResponse.model_validate(f) for f in files]
    total_pages = (total + page_size - 1) // page_size if total > 0 else 1
    return PaginatedResponse(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
        total_pages=total_pages,
    )


@router.post("/{file_id}/restore", response_model=MessageResponse)
def restore_trashed_file(
    file_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    """Restore a deleted file from trash back to its location."""
    FileService.restore_file(db, file_id, current_user.id)
    return MessageResponse(message="File restored successfully.")


@router.delete("/{file_id}/permanent", response_model=MessageResponse)
async def permanently_delete_file(
    file_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    """Permanently delete file and purge all version objects from storage."""
    await FileService.permanent_delete_file(db, file_id, current_user.id)
    return MessageResponse(message="File permanently deleted and storage freed.")


@router.delete("/empty", response_model=MessageResponse)
async def empty_trash(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    """Permanently purge all items currently in trash."""
    trashed_files = db.scalars(
        select(File.id).where(File.owner_id == current_user.id, File.is_trashed.is_(True))
    ).all()
    count = 0
    for fid in trashed_files:
        await FileService.permanent_delete_file(db, fid, current_user.id)
        count += 1

    # Also permanently remove trashed folders
    trashed_folders = db.scalars(
        select(Folder.id).where(Folder.owner_id == current_user.id, Folder.is_trashed.is_(True))
    ).all()
    for folder_id in trashed_folders:
        if db.get(Folder, folder_id):
            await FolderService.permanent_delete_folder(db, folder_id, current_user.id)

    return MessageResponse(message=f"Trash emptied. Permanently purged {count} files.")
