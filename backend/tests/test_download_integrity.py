"""Regressions for corrupt PDF downloads and unsafe demo storage recovery."""

import asyncio
import hashlib
import io
import threading
import uuid
from types import SimpleNamespace

import pytest
from botocore.response import StreamingBody
from botocore.stub import Stubber
from sqlalchemy import select
from starlette.requests import ClientDisconnect

from app.api import files as files_api
from app.core.config import settings
from app.models.file import File
from app.models.user import User
from app.scripts.seed import SAMPLE_CONTENTS, restore_demo_files
from app.services import download_service
from app.storage import get_storage_provider
from app.storage.s3 import S3StorageProvider

PDF = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n"


def upload(client, headers, name="report.pdf", content=PDF):
    response = client.post("/api/files/upload", headers=headers,
                           files={"file": (name, io.BytesIO(content), "application/pdf" if name.endswith(".pdf") else "text/plain")})
    assert response.status_code == 201
    return response.json()


@pytest.mark.parametrize("endpoint", ["download?direct=true", "preview"])
def test_pdf_bytes_and_integrity_headers_are_preserved(client, auth_headers, endpoint):
    file = upload(client, auth_headers, "résumé.pdf")
    response = client.get(f"/api/files/{file['id']}/{endpoint}", headers=auth_headers)
    assert response.status_code == 200
    assert response.content == PDF
    assert response.headers["x-file-size"] == str(len(PDF))
    assert response.headers["x-content-sha256"] == hashlib.sha256(PDF).hexdigest()
    assert response.headers["cache-control"] == "no-store"
    if endpoint.startswith("download"):
        assert "r%C3%A9sum%C3%A9.pdf" in response.headers["content-disposition"]
    else:
        assert response.headers["content-type"] == "application/pdf"


@pytest.mark.parametrize("corruption", ["missing", "truncated", "same_size"])
@pytest.mark.parametrize("endpoint", ["download", "download?direct=true", "preview"])
def test_corrupted_documents_return_json_error_not_a_fake_pdf(client, auth_headers, endpoint, corruption):
    file = upload(client, auth_headers)
    path = get_storage_provider()._resolve_path(file["storage_key"])
    if corruption == "missing":
        path.unlink()
    else:
        path.write_bytes(PDF[:10] if corruption == "truncated" else b"x" * len(PDF))
    response = client.get(f"/api/files/{file['id']}/{endpoint}", headers=auth_headers)
    assert response.status_code == (404 if corruption == "missing" else 409)
    assert "upload the file again" in response.json()["detail"]
    assert "content-disposition" not in response.headers


def test_invalid_source_pdf_is_not_presented_as_a_valid_document(client, auth_headers):
    file = upload(client, auth_headers, content=b"Sample file content for report.pdf\n")
    for endpoint in ("download?direct=true", "preview"):
        response = client.get(f"/api/files/{file['id']}/{endpoint}", headers=auth_headers)
        assert response.status_code == 409
        assert "not a valid PDF" in response.json()["detail"]


@pytest.mark.parametrize("query", ["", "?direct=false", "?direct=true"])
@pytest.mark.parametrize("content,valid", [(PDF, True), (b"x" * len(PDF), False), (b"Sample file content for report.pdf\n", False)])
def test_s3_downloads_never_return_unverified_presigned_urls(client, auth_headers, monkeypatch, query, content, valid):
    file = upload(client, auth_headers, content=content if content.startswith(b"Sample") else PDF)
    monkeypatch.setattr(settings, "S3_ENDPOINT_URL", "https://s3.example.invalid")
    monkeypatch.setattr(settings, "S3_ACCESS_KEY_ID", "test-only-access")
    monkeypatch.setattr(settings, "S3_SECRET_ACCESS_KEY", "test-only-secret")
    storage = S3StorageProvider()
    params = {"Bucket": storage.bucket, "Key": file["storage_key"]}
    # Keep the real S3 provider and signer; stub only the remote object API.
    with Stubber(storage.client) as remote:
        remote.add_response("head_object", {"ContentLength": len(content)}, params)
        remote.add_response("get_object", {"Body": StreamingBody(io.BytesIO(content), len(content)), "ContentLength": len(content)}, params)
        monkeypatch.setattr(files_api, "get_storage_provider", lambda: storage)
        response = client.get(f"/api/files/{file['id']}/download{query}", headers=auth_headers)
        assert response.status_code == (200 if valid else 409)
        if valid:
            assert response.content == PDF
            assert response.headers["x-content-sha256"] == hashlib.sha256(PDF).hexdigest()
        else:
            assert "upload the file again" in response.json()["detail"]
        remote.assert_no_pending_responses()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["headers", "body", "cancel"])
async def test_delivery_failure_closes_verified_spool_immediately(monkeypatch, failure):
    retained = []
    original = download_service.tempfile.SpooledTemporaryFile

    def tracked_spool(*args, **kwargs):
        spool = original(*args, **kwargs)
        retained.append(spool)
        return spool

    class Storage:
        async def get_file_size(self, _key):
            return len(PDF)

        def get_file_stream(self, _key):
            yield PDF

    async def receive():
        return {"type": "http.disconnect"}

    async def send(message):
        if failure == "headers" or message["type"] == "http.response.body":
            if failure == "cancel":
                raise asyncio.CancelledError
            raise OSError("client connection closed")

    monkeypatch.setattr(download_service.tempfile, "SpooledTemporaryFile", tracked_spool)
    file = SimpleNamespace(storage_key="test.pdf", original_filename="test.pdf", mime_type="application/pdf", size_bytes=len(PDF), checksum=None)
    response = await download_service.stored_response(Storage(), file)
    try:
        with pytest.raises(asyncio.CancelledError if failure == "cancel" else ClientDisconnect):
            await response({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send)
        assert retained[0].closed, "The response must release its spool before returning on a failed send"
    finally:
        for spool in retained:
            spool.close()


def test_large_download_spooled_to_disk_remains_byte_exact(client, auth_headers):
    content = b"cloudvault" * 150000
    file = upload(client, auth_headers, "large.txt", content)
    response = client.get(f"/api/files/{file['id']}/download?direct=true", headers=auth_headers)
    assert response.status_code == 200
    assert response.content == content


def test_public_corruption_does_not_consume_download_limit(client, auth_headers):
    file = upload(client, auth_headers)
    link = client.post(f"/api/files/{file['id']}/share-links", headers=auth_headers,
                       json={"permission": "download", "max_downloads": 1}).json()
    path = get_storage_provider()._resolve_path(file["storage_key"])
    path.write_bytes(b"x" * len(PDF))
    endpoint = f"/api/public/shares/{link['token']}"
    client.cookies.clear()
    for action in ("download", "preview"):
        response = client.post(f"{endpoint}/{action}")
        assert response.status_code == 409
        assert "Ask the owner" in response.json()["detail"]
    assert client.get(endpoint).json()["downloads_remaining"] == 1
    path.write_bytes(PDF)
    response = client.post(f"{endpoint}/download")
    assert response.status_code == 200 and response.content == PDF
    assert client.post(f"{endpoint}/download").status_code == 410


@pytest.mark.asyncio
async def test_demo_restart_never_fabricates_uploaded_or_modified_files(client, auth_headers, db_session):
    original = upload(client, auth_headers)
    renamed_demo = upload(client, auth_headers, "Welcome_to_CloudVault.md", b"My own edited welcome document")
    storage = get_storage_provider()
    for file in (original, renamed_demo):
        await storage.delete_file(file["storage_key"])
    user = db_session.scalar(select(User).where(User.email == "testuser@cloudvault.com"))
    await restore_demo_files(db_session, storage, user)
    assert not await storage.file_exists(original["storage_key"])
    assert not await storage.file_exists(renamed_demo["storage_key"])


@pytest.mark.asyncio
async def test_only_checksum_matching_demo_files_can_be_restored(client, auth_headers, db_session):
    user = db_session.scalar(select(User).where(User.email == "testuser@cloudvault.com"))
    name, content = next(iter(SAMPLE_CONTENTS.items()))
    file = File(owner_id=user.id, original_filename=name, storage_key=f"seed/{uuid.uuid4()}",
                mime_type="text/markdown", size_bytes=len(content), checksum=hashlib.sha256(content).hexdigest())
    db_session.add(file)
    db_session.commit()
    storage = get_storage_provider()
    await restore_demo_files(db_session, storage, user)
    assert await storage.get_file(file.storage_key) == content
    # Do not overwrite an existing object, even if it is a corrupt legacy one.
    await storage.save_file(file.storage_key, b"existing user data")
    await restore_demo_files(db_session, storage, user)
    assert await storage.get_file(file.storage_key) == b"existing user data"


@pytest.mark.asyncio
async def test_cancelled_verification_closes_its_temporary_spool(monkeypatch):
    started = threading.Event()
    release = threading.Event()
    closed = threading.Event()
    retained = []
    original = download_service.tempfile.SpooledTemporaryFile

    def tracked_spool(*args, **kwargs):
        spool = original(*args, **kwargs)
        close = spool.close

        def tracked_close():
            close()
            closed.set()

        spool.close = tracked_close
        retained.append(spool)
        return spool

    class SlowStorage:
        async def get_file_size(self, _key):
            return len(PDF)

        def get_file_stream(self, _key):
            started.set()
            release.wait(5)
            yield PDF

    monkeypatch.setattr(download_service.tempfile, "SpooledTemporaryFile", tracked_spool)
    file = SimpleNamespace(storage_key="test.pdf", original_filename="test.pdf", mime_type="application/pdf", size_bytes=len(PDF), checksum=None)
    task = asyncio.create_task(download_service.stored_response(SlowStorage(), file))
    try:
        assert await asyncio.to_thread(started.wait, 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        release.set()
        assert await asyncio.to_thread(closed.wait, 2), "Cancelled downloads must close the spool when verification finishes"
        assert retained[0].closed
    finally:
        release.set()
        for spool in retained:
            spool.close()
