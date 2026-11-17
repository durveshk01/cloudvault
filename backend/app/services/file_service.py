"""File management service handling upload, download, metadata, versions, and trash."""

import asyncio
import hashlib
import logging
import tempfile
import uuid
from collections.abc import Callable
from datetime import UTC, datetime

from fastapi import HTTPException, UploadFile, status
from sqlalchemy import and_, asc, case, desc, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.core.config import settings
from app.models.file import File, FileVersion
from app.models.folder import Folder
from app.models.share import FileShare
from app.models.tag import FileTag, Tag
from app.models.user import User
from app.schemas.file import (
    BulkActionFailure,
    BulkActionRequest,
    BulkActionResponse,
    FileCopyRequest,
    FileMoveRequest,
)
from app.services.activity_service import ActivityService
from app.storage import get_storage_provider
from app.utils.file_utils import (
    CATEGORY_MAP,
    determine_mime_type,
    generate_storage_key,
    sanitize_filename,
)

logger = logging.getLogger(__name__)


async def inspect_upload(upload: UploadFile) -> tuple[int, str]:
    """Hash bounded chunks from Starlette's spooled file; reject oversize versions too."""
    size = 0
    checksum = hashlib.sha256()
    try:
        while chunk := await upload.read(1024 * 1024):
            size += len(chunk)
            if size > settings.max_file_size_bytes:
                raise HTTPException(status_code=413, detail=f"File exceeds the {settings.MAX_FILE_SIZE_MB} MB limit.")
            checksum.update(chunk)
        if not size:
            raise HTTPException(status_code=400, detail="Cannot upload an empty file.")
        return size, checksum.hexdigest()
    finally:
        await upload.seek(0)


def validate_folder(db: Session, folder_id: uuid.UUID | None, user_id: uuid.UUID) -> None:
    if folder_id and not db.scalar(select(Folder.id).where(Folder.id == folder_id, Folder.owner_id == user_id, Folder.is_trashed.is_(False))):
        raise HTTPException(status_code=404, detail="Target folder not found.")


def reserve_quota(db: Session, owner_id: uuid.UUID, size: int) -> None:
    result = db.execute(update(User).where(
        User.id == owner_id, User.storage_used_bytes + size <= User.storage_quota_bytes,
    ).values(storage_used_bytes=User.storage_used_bytes + size))
    if result.rowcount != 1:
        raise HTTPException(status_code=400, detail="The file owner's storage quota is exceeded. Free up space and try again.")


async def cleanup_failed_upload(db: Session, storage, key: str) -> None:
    db.rollback()
    try:
        await storage.delete_file(key)
    except Exception:
        logger.exception("Could not clean up a failed upload object")


def category_condition(category: str):
    filename = func.lower(File.original_filename)
    known = or_(*(filename.endswith(f".{extension}") for extensions in CATEGORY_MAP.values() for extension in extensions))
    extensions = or_(*(filename.endswith(f".{extension}") for extension in CATEGORY_MAP.get(category, set())))
    prefix = {"image": "image/", "video": "video/", "audio": "audio/", "document": "text/"}.get(category)
    fallback = and_(~known, File.mime_type.startswith(prefix)) if prefix else None
    return or_(extensions, fallback) if fallback is not None else extensions


class FileService:
    @staticmethod
    def check_file_access(db: Session, file_id: uuid.UUID, user_id: uuid.UUID) -> tuple[File, str]:
        """Verify user has access to file. Returns (File, permission: 'owner' | 'editor' | 'viewer')."""
        file = db.scalar(
            select(File)
            .options(selectinload(File.file_tags).selectinload(FileTag.tag))
            .where(File.id == file_id)
        )
        if not file or (file.is_trashed and file.owner_id != user_id):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found.")

        if file.owner_id == user_id:
            return file, "owner"

        # Check direct share
        share = db.scalar(
            select(FileShare).where(
                FileShare.file_id == file_id,
                FileShare.shared_with == user_id,
            )
        )
        if share:
            return file, share.permission

        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to access this file.",
        )

    @staticmethod
    async def upload_file(
        db: Session,
        user: User,
        upload: UploadFile,
        folder_id: uuid.UUID | None = None,
        request_id: uuid.UUID | None = None,
        before_commit: Callable[[], None] | None = None,
    ) -> File:
        """Stream an upload and atomically commit metadata, quota, receipt and activity.

        A scoped deterministic UUID uses the existing primary-key index as the
        idempotency receipt, including races and retries after a lost response.
        """
        owner_id = user.id
        size_bytes, checksum = await inspect_upload(upload)
        clean_filename = sanitize_filename(upload.filename or "uploaded_file")
        mime_type = determine_mime_type(clean_filename, upload.content_type)
        receipt_id = uuid.uuid5(owner_id, f"upload:{request_id}") if request_id else None

        def completed_upload():
            if receipt_id is None:
                return None
            existing = db.get(File, receipt_id)
            if existing is None:
                return None
            original = db.scalar(select(FileVersion).where(FileVersion.file_id == receipt_id, FileVersion.version_number == 1))
            if existing.owner_id != owner_id or original is None or original.checksum != checksum or original.size_bytes != size_bytes:
                raise HTTPException(status_code=409, detail="This idempotency key was already used for a different upload.")
            if existing.is_trashed:
                raise HTTPException(status_code=409, detail="This upload already completed and is now in trash. Restore it instead of retrying.")
            return existing

        existing = completed_upload()
        if existing is not None:
            return existing
        validate_folder(db, folder_id, owner_id)
        storage_key = generate_storage_key(owner_id, clean_filename)
        # End read-only validation before external storage I/O; acquire write locks
        # only for the short final transaction. Callers stage claims in before_commit.
        db.commit()

        storage = get_storage_provider()
        try:
            await storage.save_file_object(storage_key, upload.file)
            validate_folder(db, folder_id, owner_id)
            if before_commit is not None:
                before_commit()
            file_record = File(
                id=receipt_id or uuid.uuid4(), owner_id=owner_id, folder_id=folder_id,
                original_filename=clean_filename, storage_key=storage_key,
                mime_type=mime_type, size_bytes=size_bytes, checksum=checksum, current_version=1,
            )
            db.add(file_record)
            db.flush()
            db.add(FileVersion(
                file_id=file_record.id, version_number=1, storage_key=storage_key,
                size_bytes=size_bytes, checksum=checksum, uploaded_by=owner_id,
            ))
            reserve_quota(db, owner_id, size_bytes)
            ActivityService.log_activity(
                db, user_id=owner_id, action="file_uploaded", resource_type="file",
                resource_id=file_record.id, resource_name=clean_filename,
                details={"size_bytes": size_bytes, "mime_type": mime_type}, commit=False,
            )
            db.commit()
        except IntegrityError:
            await cleanup_failed_upload(db, storage, storage_key)
            existing = completed_upload()
            if existing is not None:
                return existing
            raise HTTPException(status_code=409, detail="Upload conflicted with another change. Please retry.") from None
        except Exception:
            await cleanup_failed_upload(db, storage, storage_key)
            raise
        db.refresh(file_record)
        return file_record

    @staticmethod
    def get_files(
        db: Session,
        user_id: uuid.UUID,
        folder_id: uuid.UUID | None = None,
        category: str | None = None,
        tag: str | None = None,
        starred_only: bool = False,
        trashed_only: bool = False,
        search_query: str | None = None,
        sort_by: str = "created_at",
        sort_order: str = "desc",
        page: int = 1,
        page_size: int = 50,
    ) -> tuple[list[File], int]:
        """Fetch files matching filters, search criteria, sorting, and pagination."""
        query = (
            select(File)
            .options(selectinload(File.file_tags).selectinload(FileTag.tag))
            .where(File.owner_id == user_id)
        )

        # Trash filter
        if trashed_only:
            query = query.where(File.is_trashed.is_(True))
        else:
            query = query.where(File.is_trashed.is_(False))

        # Starred filter
        if starred_only:
            query = query.where(File.is_starred.is_(True))

        # Folder filter (only when not searching globally and not filtering by category or starred)
        if not search_query and not category and not starred_only and not trashed_only:
            query = query.where(File.folder_id == folder_id)

        # Search filter
        if search_query:
            term = search_query.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            pattern = f"%{term}%"
            query = query.where(
                or_(
                    File.original_filename.ilike(pattern, escape="\\"),
                    File.mime_type.ilike(pattern, escape="\\"),
                )
            )

        # Tag filter
        if tag:
            query = query.join(File.file_tags).join(FileTag.tag).where(Tag.name == tag)

        if category and category != "all":
            query = query.where(category_condition(category))

        # Total count query before pagination
        count_stmt = select(func.count()).select_from(query.subquery())
        total = db.scalar(count_stmt) or 0

        # Sorting
        sort_col = getattr(File, sort_by, File.created_at)
        if sort_order.lower() == "asc":
            query = query.order_by(asc(sort_col), File.id)
        else:
            query = query.order_by(desc(sort_col), File.id)

        # Pagination
        offset = (page - 1) * page_size
        query = query.offset(offset).limit(page_size)

        files = list(db.scalars(query).unique().all())

        return files, total

    @staticmethod
    def rename_file(db: Session, file_id: uuid.UUID, user_id: uuid.UUID, new_name: str) -> File:
        file, perm = FileService.check_file_access(db, file_id, user_id)
        if perm == "viewer":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Viewer cannot rename file.")

        clean_name = sanitize_filename(new_name)
        old_name = file.original_filename
        file.original_filename = clean_name
        file.mime_type = determine_mime_type(clean_name, file.mime_type)
        db.commit()
        db.refresh(file)

        ActivityService.log_activity(
            db,
            user_id=user_id,
            action="file_renamed",
            resource_type="file",
            resource_id=file.id,
            resource_name=clean_name,
            details={"old_name": old_name, "new_name": clean_name},
        )
        return file

    @staticmethod
    def move_file(db: Session, file_id: uuid.UUID, user_id: uuid.UUID, req: FileMoveRequest) -> File:
        file, perm = FileService.check_file_access(db, file_id, user_id)
        if perm == "viewer":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Viewer cannot move file.")

        if req.folder_id:
            folder = db.scalar(
                select(Folder).where(
                    Folder.id == req.folder_id,
                    Folder.owner_id == file.owner_id,
                    Folder.is_trashed.is_(False),
                )
            )
            if not folder:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Target folder not found.")

        file.folder_id = req.folder_id
        db.commit()
        db.refresh(file)

        ActivityService.log_activity(
            db,
            user_id=user_id,
            action="file_moved",
            resource_type="file",
            resource_id=file.id,
            resource_name=file.original_filename,
            details={"folder_id": str(req.folder_id) if req.folder_id else None},
        )
        return file

    @staticmethod
    async def copy_file(db: Session, file_id: uuid.UUID, user: User, req: FileCopyRequest) -> File:
        source_file, _ = FileService.check_file_access(db, file_id, user.id)

        if source_file.is_trashed:
            raise HTTPException(status_code=409, detail="Restore this file before copying it.")
        target_folder = req.folder_id if "folder_id" in req.model_fields_set else (source_file.folder_id if source_file.owner_id == user.id else None)
        validate_folder(db, target_folder, user.id)
        storage = get_storage_provider()
        copy_filename = sanitize_filename(req.new_name or f"Copy of {source_file.original_filename}")
        new_storage_key = generate_storage_key(user.id, copy_filename)
        try:
            with tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024) as temporary:
                def copy_stream():
                    for chunk in storage.get_file_stream(source_file.storage_key):
                        temporary.write(chunk)
                    temporary.seek(0)
                await asyncio.to_thread(copy_stream)
                await storage.save_file_object(new_storage_key, temporary)
            reserve_quota(db, user.id, source_file.size_bytes)
        except FileNotFoundError:
            await cleanup_failed_upload(db, storage, new_storage_key)
            raise HTTPException(status_code=404, detail="The original file content is unavailable.") from None
        except Exception:
            await cleanup_failed_upload(db, storage, new_storage_key)
            raise

        new_file = File(
            owner_id=user.id,
            folder_id=target_folder,
            original_filename=copy_filename,
            storage_key=new_storage_key,
            mime_type=source_file.mime_type,
            size_bytes=source_file.size_bytes,
            checksum=source_file.checksum,
            current_version=1,
        )
        db.add(new_file)
        db.flush()

        new_version = FileVersion(
            file_id=new_file.id,
            version_number=1,
            storage_key=new_storage_key,
            size_bytes=source_file.size_bytes,
            checksum=source_file.checksum,
            uploaded_by=user.id,
        )
        db.add(new_version)

        try:
            db.commit()
        except Exception:
            await cleanup_failed_upload(db, storage, new_storage_key)
            raise
        db.refresh(new_file)

        ActivityService.log_activity(
            db,
            user_id=user.id,
            action="file_copied",
            resource_type="file",
            resource_id=new_file.id,
            resource_name=new_file.original_filename,
        )
        return new_file

    @staticmethod
    def toggle_star(db: Session, file_id: uuid.UUID, user_id: uuid.UUID) -> bool:
        file, perm = FileService.check_file_access(db, file_id, user_id)
        if perm != "owner":
            raise HTTPException(status_code=403, detail="Only the owner can change this file's favorite state.")
        file.is_starred = not file.is_starred
        db.commit()
        db.refresh(file)
        return file.is_starred

    @staticmethod
    def soft_delete_file(db: Session, file_id: uuid.UUID, user_id: uuid.UUID) -> None:
        file, perm = FileService.check_file_access(db, file_id, user_id)
        if perm != "owner":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only owner can delete file.")

        file.is_trashed = True
        file.trashed_at = datetime.now(UTC).replace(tzinfo=None)
        file.trash_batch_id = uuid.uuid4()
        db.commit()

        ActivityService.log_activity(
            db,
            user_id=user_id,
            action="file_deleted",
            resource_type="file",
            resource_id=file.id,
            resource_name=file.original_filename,
        )

    @staticmethod
    def restore_file(db: Session, file_id: uuid.UUID, user_id: uuid.UUID) -> None:
        file = db.scalar(
            select(File).where(File.id == file_id, File.owner_id == user_id)
        )
        if not file or not file.is_trashed:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found in trash.")

        parent = db.get(Folder, file.folder_id) if file.folder_id else None
        if parent and parent.is_trashed:
            file.folder_id = None
        file.is_trashed = False
        file.trashed_at = None
        file.trash_batch_id = None
        db.commit()

        ActivityService.log_activity(
            db,
            user_id=user_id,
            action="file_restored",
            resource_type="file",
            resource_id=file.id,
            resource_name=file.original_filename,
        )

    @staticmethod
    async def permanent_delete_file(db: Session, file_id: uuid.UUID, user_id: uuid.UUID) -> None:
        file = db.scalar(
            select(File)
            .options(selectinload(File.versions))
            .where(File.id == file_id, File.owner_id == user_id)
        )
        if not file or not file.is_trashed:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found in trash.")

        user = db.scalar(select(User).where(User.id == user_id))
        storage = get_storage_provider()

        objects = {v.storage_key: v.size_bytes for v in file.versions}
        objects.setdefault(file.storage_key, file.size_bytes)
        try:
            for key in objects:
                await storage.delete_file(key)
        except Exception:
            logger.exception("Could not delete all stored versions; retaining the trash record")
            db.rollback()
            raise HTTPException(status_code=503, detail="Storage could not delete all versions. The trash record is retained; try again.") from None

        # Adjust quota
        if user:
            reclaimed = sum(objects.values())
            db.execute(update(User).where(User.id == user_id).values(storage_used_bytes=case(
                (User.storage_used_bytes >= reclaimed, User.storage_used_bytes - reclaimed), else_=0,
            )))

        filename = file.original_filename
        db.delete(file)
        db.commit()

        ActivityService.log_activity(
            db,
            user_id=user_id,
            action="file_permanently_deleted",
            resource_type="file",
            resource_id=file_id,
            resource_name=filename,
        )

    @staticmethod
    async def upload_new_version(
        db: Session,
        file_id: uuid.UUID,
        user: User,
        upload: UploadFile,
        request_id: uuid.UUID | None = None,
    ) -> FileVersion:
        file, perm = FileService.check_file_access(db, file_id, user.id)
        if perm == "viewer":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Viewer cannot upload new versions.")

        if file.is_trashed:
            raise HTTPException(status_code=409, detail="Restore this file before uploading a version.")
        size_bytes, checksum = await inspect_upload(upload)
        uploader_id = user.id
        owner_id = file.owner_id
        receipt_id = uuid.uuid5(file_id, f"version:{uploader_id}:{request_id}") if request_id else None

        def completed_version():
            existing = db.get(FileVersion, receipt_id) if receipt_id else None
            if existing is not None and (existing.file_id != file_id or existing.uploaded_by != uploader_id or existing.checksum != checksum or existing.size_bytes != size_bytes):
                raise HTTPException(status_code=409, detail="This idempotency key was already used for a different version.")
            return existing

        existing = completed_version()
        if existing is not None:
            return existing
        storage = get_storage_provider()
        storage_key = generate_storage_key(owner_id, file.original_filename)
        db.commit()
        try:
            await storage.save_file_object(storage_key, upload.file)
            db.refresh(file, with_for_update=True)
            file, perm = FileService.check_file_access(db, file_id, uploader_id)
            if perm == "viewer":
                raise HTTPException(status_code=403, detail="Editing access was revoked during this upload.")
            if file.is_trashed:
                raise HTTPException(status_code=409, detail="The file was moved to trash during this upload.")
            existing = completed_version()
            if existing is not None:
                await cleanup_failed_upload(db, storage, storage_key)
                return existing
            new_version_num = (db.scalar(select(func.max(FileVersion.version_number)).where(FileVersion.file_id == file.id)) or 0) + 1
            version = FileVersion(
                id=receipt_id or uuid.uuid4(), file_id=file.id, version_number=new_version_num,
                storage_key=storage_key, size_bytes=size_bytes, checksum=checksum, uploaded_by=uploader_id,
            )
            db.add(version)
            file.storage_key = storage_key
            file.size_bytes = size_bytes
            file.checksum = checksum
            file.current_version = new_version_num
            reserve_quota(db, owner_id, size_bytes)
            ActivityService.log_activity(
                db, user_id=uploader_id, action="file_version_uploaded", resource_type="file",
                resource_id=file.id, resource_name=file.original_filename,
                details={"version": new_version_num, "size_bytes": size_bytes}, commit=False,
            )
            db.commit()
        except IntegrityError:
            await cleanup_failed_upload(db, storage, storage_key)
            existing = completed_version()
            if existing is not None:
                return existing
            raise HTTPException(status_code=409, detail="Another version was uploaded concurrently. Please retry.") from None
        except Exception:
            await cleanup_failed_upload(db, storage, storage_key)
            raise
        db.refresh(version)

        return version

    @staticmethod
    def get_file_versions(db: Session, file_id: uuid.UUID, user_id: uuid.UUID) -> list[FileVersion]:
        FileService.check_file_access(db, file_id, user_id)
        query = (
            select(FileVersion)
            .where(FileVersion.file_id == file_id)
            .order_by(desc(FileVersion.version_number))
        )
        return list(db.scalars(query).all())

    @staticmethod
    async def restore_version(
        db: Session,
        file_id: uuid.UUID,
        version_id: uuid.UUID,
        user_id: uuid.UUID,
    ) -> File:
        file, perm = FileService.check_file_access(db, file_id, user_id)
        if perm == "viewer":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Viewer cannot restore version.")

        target_version = db.scalar(
            select(FileVersion).where(
                FileVersion.id == version_id,
                FileVersion.file_id == file_id,
            )
        )
        if not target_version:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Target version not found.")

        # Set active file pointer to target version
        file.storage_key = target_version.storage_key
        file.size_bytes = target_version.size_bytes
        file.checksum = target_version.checksum
        file.current_version = target_version.version_number
        db.commit()
        db.refresh(file)

        ActivityService.log_activity(
            db,
            user_id=user_id,
            action="file_version_restored",
            resource_type="file",
            resource_id=file.id,
            resource_name=file.original_filename,
            details={"version": target_version.version_number},
        )
        return file

    @staticmethod
    async def execute_bulk_action(
        db: Session,
        user: User,
        req: BulkActionRequest,
    ) -> BulkActionResponse:
        # Validate every owner before performing any action; do not silently skip unauthorized IDs.
        owned = list(db.scalars(select(File).where(File.id.in_(req.file_ids), File.owner_id == user.id)))
        if len(owned) != len(req.file_ids):
            raise HTTPException(status_code=404, detail="One or more selected files are unavailable or not owned by you.")
        if req.action == "move":
            validate_folder(db, req.folder_id, user.id)
        if req.action in ("restore", "permanent_delete") and any(not file.is_trashed for file in owned):
            raise HTTPException(status_code=409, detail="Select only files already in trash for this action.")
        if req.action in ("delete", "move", "star", "unstar") and any(file.is_trashed for file in owned):
            raise HTTPException(status_code=409, detail="Restore selected files before changing them.")
        count = 0
        failed = []
        for fid in req.file_ids:
            try:
                if req.action == "delete":
                    FileService.soft_delete_file(db, fid, user.id)
                    count += 1
                elif req.action == "restore":
                    FileService.restore_file(db, fid, user.id)
                    count += 1
                elif req.action == "permanent_delete":
                    await FileService.permanent_delete_file(db, fid, user.id)
                    count += 1
                elif req.action == "star":
                    f, _ = FileService.check_file_access(db, fid, user.id)
                    f.is_starred = True
                    db.commit()
                    count += 1
                elif req.action == "unstar":
                    f, _ = FileService.check_file_access(db, fid, user.id)
                    f.is_starred = False
                    db.commit()
                    count += 1
                elif req.action == "move":
                    FileService.move_file(db, fid, user.id, FileMoveRequest(folder_id=req.folder_id))
                    count += 1
            except HTTPException as error:
                db.rollback()
                failed.append(BulkActionFailure(id=fid, message=str(error.detail)))
        return BulkActionResponse(message=f"Processed {count} of {len(req.file_ids)} files.", processed_count=count, failed=failed)
