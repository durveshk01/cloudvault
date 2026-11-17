"""Verify stored bytes before serving them as a download or preview."""

import asyncio
import hashlib
import tempfile

from fastapi import HTTPException
from fastapi.responses import StreamingResponse

from app.utils.file_utils import content_disposition, safe_preview_mime


class VerifiedFileResponse(StreamingResponse):
    """Own the spool until delivery completes, fails, or is cancelled."""

    def __init__(self, content, *, spool, **kwargs):
        self.spool = spool
        super().__init__(content, **kwargs)

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            # Background tasks and a suspended generator are not sufficient
            # when ASGI send() raises ClientDisconnect or the task is cancelled.
            self.spool.close()


async def stored_size(storage, file, *, shared: bool = False) -> int:
    recovery = "Ask the owner to upload the file again." if shared else "Please upload the file again."
    try:
        size = await storage.get_file_size(file.storage_key)
    except FileNotFoundError as exc:
        raise HTTPException(404, f"The stored file content is unavailable. {recovery}") from exc
    if not size or size != file.size_bytes:
        raise HTTPException(409, f"The stored file content is incomplete or corrupted. {recovery}")
    return size


async def stored_response(storage, file, *, preview: bool = False, shared: bool = False):
    """Use a bounded spool so corrupt objects never become successful downloads.

    Fetch the object only once. Large files roll to temporary disk rather than
    consuming unbounded RAM, and the response serves the exact verified bytes.
    """
    size = await stored_size(storage, file, shared=shared)
    recovery = "Ask the owner to upload the file again." if shared else "Please upload the file again."

    def verify():
        # Ownership passes to the response; stream/background closes it.
        content = tempfile.SpooledTemporaryFile(max_size=1024 * 1024, mode="w+b")  # noqa: SIM115
        try:
            digest = hashlib.sha256()
            received = 0
            for chunk in storage.get_file_stream(file.storage_key):
                received += len(chunk)
                if received > size:
                    raise HTTPException(409, f"The stored file content is corrupted. {recovery}")
                digest.update(chunk)
                content.write(chunk)
            checksum = digest.hexdigest()
            if received != size or (file.checksum and checksum != file.checksum):
                raise HTTPException(409, f"The stored file content is incomplete or corrupted. {recovery}")
            content.seek(0)
            if file.mime_type == "application/pdf" or file.original_filename.lower().endswith(".pdf"):
                if b"%PDF-" not in content.read(1024):
                    raise HTTPException(409, f"The stored document is not a valid PDF. {recovery}")
                content.seek(0)
            return content, checksum
        except BaseException:
            content.close()
            raise

    verification = asyncio.create_task(asyncio.to_thread(verify))

    def close_cancelled_result(task):
        # Cancelling the HTTP request cannot stop a running storage thread.
        # Retain its result until it finishes, then release the owned spool.
        if not task.cancelled() and task.exception() is None:
            task.result()[0].close()

    try:
        content, checksum = await asyncio.shield(verification)
    except asyncio.CancelledError:
        verification.add_done_callback(close_cancelled_result)
        raise
    except FileNotFoundError as exc:
        raise HTTPException(404, f"The stored file content is unavailable. {recovery}") from exc

    def stream():
        try:
            while chunk := content.read(65536):
                yield chunk
        finally:
            content.close()

    headers = {"Content-Length": str(size), "X-File-Size": str(size), "X-Content-SHA256": checksum}
    if not preview:
        headers["Content-Disposition"] = content_disposition(file.original_filename)
    return VerifiedFileResponse(
        stream(),
        spool=content,
        media_type=safe_preview_mime(file.mime_type) if preview else "application/octet-stream",
        headers=headers,
    )
