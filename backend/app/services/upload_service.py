"""Validate direct uploads against single-use server-owned sessions."""

import asyncio
import hashlib
import logging
import tempfile
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException, UploadFile
from sqlalchemy import select, update
from sqlalchemy.orm import Session
from starlette.datastructures import Headers

from app.core.config import settings
from app.models.upload import UploadSession
from app.models.user import User
from app.schemas.file import (
    UploadCompleteRequest,
    UploadInitiateRequest,
    UploadInitiateResponse,
)
from app.services.file_service import FileService, validate_folder
from app.storage import get_storage_provider
from app.utils.file_utils import determine_mime_type, sanitize_filename

logger = logging.getLogger(__name__)


class UploadService:
    @staticmethod
    def initiate(db: Session, user: User, req: UploadInitiateRequest) -> UploadInitiateResponse:
        if req.size_bytes > settings.max_file_size_bytes:
            raise HTTPException(status_code=413, detail="File exceeds the configured upload size limit.")
        if user.storage_used_bytes + req.size_bytes > user.storage_quota_bytes:
            raise HTTPException(status_code=400, detail="Storage quota exceeded.")
        validate_folder(db, req.folder_id, user.id)
        filename = sanitize_filename(req.filename)
        sid = uuid.uuid4()
        key = f"users/{user.id}/temp/{sid.hex}_{filename}"
        storage = get_storage_provider()
        url = storage.generate_presigned_upload_url(key, expires_in=900)
        if not url:
            raise HTTPException(status_code=400, detail="Direct uploads require S3 storage. Use /api/files/upload for this server.")
        db.add(UploadSession(
            id=sid, owner_id=user.id, folder_id=req.folder_id, filename=filename,
            storage_key=key, size_bytes=req.size_bytes,
            mime_type=determine_mime_type(filename, req.mime_type),
            expires_at=datetime.now(UTC) + timedelta(minutes=15),
        ))
        db.commit()
        return UploadInitiateResponse(upload_id=str(sid), storage_key=key, upload_url=url)

    @staticmethod
    async def complete(db: Session, user: User, req: UploadCompleteRequest):
        session = db.scalar(select(UploadSession).where(
            UploadSession.id == req.upload_id, UploadSession.owner_id == user.id,
            UploadSession.expires_at > datetime.now(UTC), UploadSession.completed.is_(False),
        ))
        if not session:
            raise HTTPException(status_code=404, detail="Upload session is invalid, expired, or already completed.")
        if (req.storage_key != session.storage_key or sanitize_filename(req.filename) != session.filename
                or req.size_bytes != session.size_bytes or req.folder_id != session.folder_id):
            raise HTTPException(status_code=400, detail="Upload metadata does not match the original session.")
        validate_folder(db, session.folder_id, user.id)
        storage = get_storage_provider()
        try:
            actual_size = await storage.get_file_size(session.storage_key)
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="The upload has not reached object storage yet.") from None
        if actual_size != session.size_bytes or actual_size > settings.max_file_size_bytes:
            raise HTTPException(status_code=400, detail="Uploaded object size does not match the declared size.")

        with tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024) as temporary:
            def verify_object():
                size = 0
                checksum = hashlib.sha256()
                for chunk in storage.get_file_stream(session.storage_key):
                    size += len(chunk)
                    if size > session.size_bytes:
                        raise HTTPException(status_code=400, detail="Uploaded object changed during validation.")
                    checksum.update(chunk)
                    temporary.write(chunk)
                if size != session.size_bytes or (req.checksum and checksum.hexdigest() != req.checksum.lower()):
                    raise HTTPException(status_code=400, detail="Uploaded file integrity verification failed.")
                temporary.seek(0)

            await asyncio.to_thread(verify_object)
            session_id, staged_key = session.id, session.storage_key

            def claim_session():
                claimed = db.execute(update(UploadSession).where(
                    UploadSession.id == session_id, UploadSession.completed.is_(False),
                    UploadSession.expires_at > datetime.now(UTC),
                ).values(completed=True))
                if claimed.rowcount != 1:
                    raise HTTPException(status_code=409, detail="This upload session was already completed.")

            upload = UploadFile(file=temporary, filename=session.filename, headers=Headers({"content-type": session.mime_type}))
            # Claim only after the private object is written, keeping DB locks short.
            result = await FileService.upload_file(db, user, upload, session.folder_id, before_commit=claim_session)

        try:
            await storage.delete_file(staged_key)
        except Exception:
            logger.warning("Staged direct upload awaits object storage lifecycle cleanup", exc_info=True)
        return result
