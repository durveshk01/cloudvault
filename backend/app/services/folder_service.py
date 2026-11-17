"""Folder management service."""

import uuid
from datetime import UTC, datetime

from fastapi import HTTPException, status
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from app.models.file import File
from app.models.folder import Folder
from app.schemas.folder import BreadcrumbItem, FolderCreate, FolderUpdate
from app.services.activity_service import ActivityService


class FolderService:
    @staticmethod
    def create_folder(db: Session, user_id: uuid.UUID, req: FolderCreate) -> Folder:
        clean_name = req.name.strip()
        if not clean_name:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Folder name cannot be empty.")

        # If parent_id provided, verify parent exists and belongs to user
        if req.parent_id:
            parent = db.scalar(
                select(Folder).where(
                    Folder.id == req.parent_id,
                    Folder.owner_id == user_id,
                    Folder.is_trashed.is_(False),
                )
            )
            if not parent:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Parent folder not found.")

        # Check duplicate name in same parent
        existing = db.scalar(
            select(Folder).where(
                Folder.owner_id == user_id,
                Folder.parent_id == req.parent_id,
                Folder.name == clean_name,
                Folder.is_trashed.is_(False),
            )
        )
        if existing:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="A folder with this name already exists here.")

        folder = Folder(
            owner_id=user_id,
            parent_id=req.parent_id,
            name=clean_name,
        )
        db.add(folder)
        db.commit()
        db.refresh(folder)

        ActivityService.log_activity(
            db,
            user_id=user_id,
            action="folder_created",
            resource_type="folder",
            resource_id=folder.id,
            resource_name=folder.name,
        )
        return folder

    @staticmethod
    def get_user_folders(
        db: Session,
        user_id: uuid.UUID,
        parent_id: uuid.UUID | None = None,
        include_trashed: bool = False,
    ) -> list[Folder]:
        if parent_id:
            FolderService.get_folder_by_id(db, parent_id, user_id)
        query = select(Folder).where(
            Folder.owner_id == user_id,
            Folder.parent_id == parent_id,
        )
        if not include_trashed:
            query = query.where(Folder.is_trashed.is_(False))
        query = query.order_by(Folder.name.asc())
        return list(db.scalars(query).all())

    @staticmethod
    def get_folder_by_id(db: Session, folder_id: uuid.UUID, user_id: uuid.UUID, include_trashed: bool = False) -> Folder:
        folder = db.scalar(
            select(Folder).where(
                Folder.id == folder_id,
                Folder.owner_id == user_id,
            )
        )
        if not folder or (folder.is_trashed and not include_trashed):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Folder not found.")
        return folder

    @staticmethod
    def get_breadcrumbs(db: Session, folder_id: uuid.UUID | None, user_id: uuid.UUID) -> list[BreadcrumbItem]:
        breadcrumbs = []
        current_id = folder_id
        # Prevent infinite loops with depth limit
        depth = 0
        while current_id and depth < 50:
            folder = db.scalar(
                select(Folder).where(Folder.id == current_id, Folder.owner_id == user_id)
            )
            if not folder:
                break
            breadcrumbs.insert(0, BreadcrumbItem(id=folder.id, name=folder.name))
            current_id = folder.parent_id
            depth += 1
        return breadcrumbs

    @staticmethod
    def rename_folder(db: Session, folder_id: uuid.UUID, user_id: uuid.UUID, req: FolderUpdate) -> Folder:
        folder = FolderService.get_folder_by_id(db, folder_id, user_id)
        clean_name = req.name.strip()
        if not clean_name:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Folder name cannot be empty.")

        # Check duplicate name
        existing = db.scalar(
            select(Folder).where(
                Folder.owner_id == user_id,
                Folder.parent_id == folder.parent_id,
                Folder.name == clean_name,
                Folder.id != folder_id,
                Folder.is_trashed.is_(False),
            )
        )
        if existing:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="A folder with this name already exists in this directory.")

        old_name = folder.name
        folder.name = clean_name
        db.commit()
        db.refresh(folder)

        ActivityService.log_activity(
            db,
            user_id=user_id,
            action="folder_renamed",
            resource_type="folder",
            resource_id=folder.id,
            resource_name=clean_name,
            details={"old_name": old_name, "new_name": clean_name},
        )
        return folder

    @staticmethod
    def move_folder(db: Session, folder_id: uuid.UUID, user_id: uuid.UUID, target_parent_id: uuid.UUID | None) -> Folder:
        folder = FolderService.get_folder_by_id(db, folder_id, user_id)

        if folder.id == target_parent_id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot move folder into itself.")

        if target_parent_id:
            target_parent = FolderService.get_folder_by_id(db, target_parent_id, user_id)
            # Check if target_parent is a descendant of folder
            curr = target_parent
            depth = 0
            while curr and depth < 50:
                if curr.id == folder.id:
                    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot move folder into one of its descendants.")
                if curr.parent_id:
                    curr = db.scalar(select(Folder).where(Folder.id == curr.parent_id, Folder.owner_id == user_id))
                else:
                    curr = None
                depth += 1
            if curr:
                raise HTTPException(status_code=400, detail="The target folder hierarchy exceeds the supported depth.")

        duplicate = db.scalar(select(Folder.id).where(
            Folder.owner_id == user_id, Folder.parent_id == target_parent_id,
            Folder.name == folder.name, Folder.id != folder.id, Folder.is_trashed.is_(False),
        ))
        if duplicate:
            raise HTTPException(status_code=400, detail="A folder with this name already exists at the destination.")

        folder.parent_id = target_parent_id
        db.commit()
        db.refresh(folder)

        ActivityService.log_activity(
            db,
            user_id=user_id,
            action="folder_moved",
            resource_type="folder",
            resource_id=folder.id,
            resource_name=folder.name,
            details={"target_parent_id": str(target_parent_id) if target_parent_id else None},
        )
        return folder

    @staticmethod
    def delete_folder(db: Session, folder_id: uuid.UUID, user_id: uuid.UUID) -> None:
        """Move folder and all its contents to trash."""
        folder = FolderService.get_folder_by_id(db, folder_id, user_id)
        now = datetime.now(UTC)
        batch = uuid.uuid4()
        folder_ids = FolderService.descendant_ids(db, folder.id, user_id)
        # Preserve independently trashed descendants so restoring the parent cannot resurrect them.
        db.execute(update(Folder).where(Folder.id.in_(folder_ids), Folder.is_trashed.is_(False)).values(
            is_trashed=True, trashed_at=now, trash_batch_id=batch,
        ))
        db.execute(update(File).where(File.folder_id.in_(folder_ids), File.owner_id == user_id, File.is_trashed.is_(False)).values(
            is_trashed=True, trashed_at=now, trash_batch_id=batch,
        ))

        db.commit()

        ActivityService.log_activity(
            db,
            user_id=user_id,
            action="folder_deleted",
            resource_type="folder",
            resource_id=folder.id,
            resource_name=folder.name,
        )

    @staticmethod
    def get_folder_counts(db: Session, folder_id: uuid.UUID, user_id: uuid.UUID) -> tuple[int, int]:
        file_count = db.scalar(
            select(func.count(File.id)).where(
                File.folder_id == folder_id,
                File.owner_id == user_id,
                File.is_trashed.is_(False),
            )
        ) or 0
        subfolder_count = db.scalar(
            select(func.count(Folder.id)).where(
                Folder.parent_id == folder_id,
                Folder.owner_id == user_id,
                Folder.is_trashed.is_(False),
            )
        ) or 0
        return file_count, subfolder_count

    @staticmethod
    def descendant_ids(db: Session, folder_id: uuid.UUID, user_id: uuid.UUID) -> list[uuid.UUID]:
        tree = select(Folder.id).where(Folder.id == folder_id, Folder.owner_id == user_id).cte("folder_tree", recursive=True)
        tree = tree.union(select(Folder.id).join(tree, Folder.parent_id == tree.c.id).where(Folder.owner_id == user_id))
        return list(db.scalars(select(tree.c.id)))

    @staticmethod
    def get_counts_for_folders(db: Session, ids: list[uuid.UUID], user_id: uuid.UUID) -> dict:
        if not ids:
            return {}
        files = dict(db.execute(select(File.folder_id, func.count(File.id)).where(
            File.folder_id.in_(ids), File.owner_id == user_id, File.is_trashed.is_(False),
        ).group_by(File.folder_id)).all())
        children = dict(db.execute(select(Folder.parent_id, func.count(Folder.id)).where(
            Folder.parent_id.in_(ids), Folder.owner_id == user_id, Folder.is_trashed.is_(False),
        ).group_by(Folder.parent_id)).all())
        return {fid: (files.get(fid, 0), children.get(fid, 0)) for fid in ids}

    @staticmethod
    def restore_folder(db: Session, folder_id: uuid.UUID, user_id: uuid.UUID) -> int:
        folder = FolderService.get_folder_by_id(db, folder_id, user_id, include_trashed=True)
        if not folder.is_trashed:
            raise HTTPException(status_code=404, detail="Folder not found in trash.")
        ids = FolderService.descendant_ids(db, folder.id, user_id)
        if folder.trash_batch_id:
            folder_batch = Folder.trash_batch_id == folder.trash_batch_id
            file_batch = File.trash_batch_id == folder.trash_batch_id
        else:
            # Compatible with trash entries created before batch IDs existed.
            folder_batch = Folder.trashed_at == folder.trashed_at
            file_batch = File.trashed_at == folder.trashed_at
        restoring = list(db.scalars(select(Folder).where(Folder.id.in_(ids), Folder.is_trashed.is_(True), folder_batch)))
        restoring_ids = {item.id for item in restoring}
        parent = db.get(Folder, folder.parent_id) if folder.parent_id else None
        if parent and parent.is_trashed and parent.id not in restoring_ids:
            folder.parent_id = None
        original_name = folder.name
        suffix = 0
        while db.scalar(select(Folder.id).where(
            Folder.owner_id == user_id, Folder.parent_id == folder.parent_id,
            Folder.name == folder.name, Folder.id != folder.id, Folder.is_trashed.is_(False),
        )):
            suffix += 1
            folder.name = f"{original_name[:230]} (restored {suffix})"
        result = db.execute(update(File).where(
            File.owner_id == user_id, File.folder_id.in_(ids), File.is_trashed.is_(True), file_batch,
        ).values(is_trashed=False, trashed_at=None, trash_batch_id=None))
        for item in restoring:
            item.is_trashed = False
            item.trashed_at = None
            item.trash_batch_id = None
        db.commit()
        ActivityService.log_activity(db, user_id=user_id, action="folder_restored", resource_type="folder", resource_id=folder.id, resource_name=folder.name)
        return result.rowcount

    @staticmethod
    async def permanent_delete_folder(db: Session, folder_id: uuid.UUID, user_id: uuid.UUID) -> int:
        from app.services.file_service import FileService
        folder = FolderService.get_folder_by_id(db, folder_id, user_id, include_trashed=True)
        if not folder.is_trashed:
            raise HTTPException(status_code=409, detail="Move this folder to trash before permanently deleting it.")
        ids = FolderService.descendant_ids(db, folder.id, user_id)
        if db.scalar(select(File.id).where(File.folder_id.in_(ids), File.owner_id == user_id, File.is_trashed.is_(False)).limit(1)):
            raise HTTPException(status_code=409, detail="This folder contains a restored file. Move that file out before purging the folder.")
        files = list(db.scalars(select(File.id).where(File.folder_id.in_(ids), File.owner_id == user_id)))
        name = folder.name
        for fid in files:
            await FileService.permanent_delete_file(db, fid, user_id)
        db.execute(delete(Folder).where(Folder.id.in_(ids), Folder.owner_id == user_id), execution_options={"synchronize_session": False})
        db.commit()
        ActivityService.log_activity(db, user_id=user_id, action="folder_permanently_deleted", resource_type="folder", resource_id=folder_id, resource_name=name)
        return len(files)
