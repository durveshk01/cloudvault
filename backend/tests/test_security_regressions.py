"""Regression tests for session security, user isolation, limits and recovery."""

import hashlib
import io
import uuid

import pytest
from pydantic import ValidationError
from sqlalchemy import select

from app.core.config import Settings, settings
from app.models.notification import Notification
from app.models.user import User
from app.storage import get_storage_provider


def upload(client, headers, name="regression.txt", content=b"original"):
    response = client.post("/api/files/upload", headers=headers, files={"file": (name, io.BytesIO(content), "text/plain")})
    assert response.status_code == 201, response.text
    return response.json()


def login(client):
    return client.post("/api/auth/login", json={"email": "testuser@cloudvault.com", "password": "Password123!"}).json()


def test_refresh_rotation_and_logout_revocation(client, auth_headers):
    first = login(client)
    refreshed = client.post("/api/auth/refresh", json={"refresh_token": first["refresh_token"]})
    assert refreshed.status_code == 200
    second = refreshed.json()
    assert second["refresh_token"] != first["refresh_token"]
    assert client.post("/api/auth/refresh", json={"refresh_token": first["refresh_token"]}).status_code == 401
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {second['access_token']}"}).status_code == 200
    assert client.post("/api/auth/logout", json={"refresh_token": second["refresh_token"]}).status_code == 200
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {second['access_token']}"}).status_code == 401
    assert client.post("/api/auth/refresh", json={"refresh_token": second["refresh_token"]}).status_code == 401


def test_cookie_refresh_is_httponly_and_rotates_both_cookies(client, auth_headers):
    old_refresh = client.cookies["refresh_token"]
    response = client.post("/api/auth/refresh")
    assert response.status_code == 200
    assert client.cookies["refresh_token"] != old_refresh
    cookies = response.headers.get_list("set-cookie")
    assert len(cookies) == 2 and all("HttpOnly" in cookie for cookie in cookies)
    assert response.headers["cache-control"] == "no-store"


def test_query_tokens_rejected_and_cross_origin_mutations_blocked(client, auth_headers):
    client.cookies.clear()
    assert client.get("/api/auth/me", params={"token": auth_headers["Authorization"][7:]}).status_code == 401
    response = client.post("/api/folders", headers={**auth_headers, "Origin": "https://untrusted.example"}, json={"name": "Untrusted"})
    assert response.status_code == 403
    assert client.get("/api/folders", headers=auth_headers).json() == []


def test_password_change_revokes_other_device_sessions(client, auth_headers):
    other_device = login(client)
    changed = client.post("/api/auth/change-password", headers=auth_headers, json={
        "current_password": "Password123!", "new_password": "ChangedPassword456!", "confirm_password": "ChangedPassword456!",
    })
    assert changed.status_code == 200
    assert client.get("/api/auth/me", headers={"Authorization": f"Bearer {other_device['access_token']}"}).status_code == 401


def test_notifications_read_unread_and_missing_are_correct(client, auth_headers, db_session):
    user = db_session.scalar(select(User).where(User.email == "testuser@cloudvault.com"))
    notification = Notification(user_id=user.id, type="test", title="A real notification")
    db_session.add(notification)
    db_session.commit()
    path = f"/api/notifications/{notification.id}"
    assert client.patch(path, headers=auth_headers, json={"is_read": True}).json()["is_read"] is True
    assert client.patch(path, headers=auth_headers, json={"is_read": False}).json()["is_read"] is False
    assert client.patch(f"/api/notifications/{uuid.uuid4()}", headers=auth_headers, json={"is_read": True}).status_code == 404


def test_category_filter_precedes_pagination(client, auth_headers):
    for index in range(5):
        upload(client, auth_headers, f"photo-{index}.png", b"image bytes")
        upload(client, auth_headers, f"note-{index}.txt")
    first = client.get("/api/files?category=image&page_size=2&page=1", headers=auth_headers).json()
    second = client.get("/api/files?category=image&page_size=2&page=2", headers=auth_headers).json()
    assert first["total"] == 5 and first["total_pages"] == 3
    assert len(first["items"]) == len(second["items"]) == 2
    assert not ({item["id"] for item in first["items"]} & {item["id"] for item in second["items"]})


def test_editor_versions_charge_owner_and_do_not_reuse_numbers(client, auth_headers, second_user_headers):
    file = upload(client, auth_headers)
    assert client.post(f"/api/files/{file['id']}/shares", headers=auth_headers, json={"shared_with_email": "second@cloudvault.com", "permission": "editor"}).status_code == 201
    response = client.post(f"/api/files/{file['id']}/versions", headers=second_user_headers, files={"file": ("regression.txt", io.BytesIO(b"edited"), "text/plain")})
    assert response.status_code == 201
    versions = client.get(f"/api/files/{file['id']}/versions", headers=auth_headers).json()
    original = next(version for version in versions if version["version_number"] == 1)
    assert client.post(f"/api/files/{file['id']}/versions/{original['id']}/restore", headers=auth_headers).status_code == 200
    third = client.post(f"/api/files/{file['id']}/versions", headers=auth_headers, files={"file": ("regression.txt", io.BytesIO(b"third"), "text/plain")})
    assert third.status_code == 201 and third.json()["version_number"] == 3
    owner = client.get("/api/storage/usage", headers=auth_headers).json()
    editor = client.get("/api/storage/usage", headers=second_user_headers).json()
    assert owner["used_bytes"] == len(b"originaleditedthird")
    assert editor["used_bytes"] == 0


def test_shared_copy_cannot_attach_to_other_users_folder(client, auth_headers, second_user_headers):
    folder = client.post("/api/folders", headers=auth_headers, json={"name": "Owner private folder"}).json()
    file = upload(client, auth_headers)
    client.post(f"/api/files/{file['id']}/shares", headers=auth_headers, json={"shared_with_email": "second@cloudvault.com"})
    assert client.post(f"/api/files/{file['id']}/copy", headers=second_user_headers, json={"folder_id": folder["id"]}).status_code == 404
    assert client.patch(f"/api/files/{file['id']}", headers=second_user_headers, json={"is_starred": True}).status_code == 403
    copied = client.post(f"/api/files/{file['id']}/copy", headers=second_user_headers, json={})
    assert copied.status_code == 200 and copied.json()["folder_id"] is None


def test_folder_restore_preserves_independently_deleted_files(client, auth_headers):
    folder = client.post("/api/folders", headers=auth_headers, json={"name": "Recoverable"}).json()
    active = upload(client, auth_headers, "active.txt")
    old_trash = upload(client, auth_headers, "already-deleted.txt")
    for file in (active, old_trash):
        assert client.post(f"/api/files/{file['id']}/move", headers=auth_headers, json={"folder_id": folder["id"]}).status_code == 200
    client.delete(f"/api/files/{old_trash['id']}", headers=auth_headers)
    assert client.delete(f"/api/folders/{folder['id']}", headers=auth_headers).status_code == 200
    assert client.get("/api/trash/folders", headers=auth_headers).json()["total"] == 1
    restored = client.post(f"/api/trash/folders/{folder['id']}/restore", headers=auth_headers)
    assert restored.status_code == 200
    visible = client.get(f"/api/files?folder_id={folder['id']}", headers=auth_headers).json()["items"]
    assert [file["id"] for file in visible] == [active["id"]]
    assert client.get("/api/trash", headers=auth_headers).json()["items"][0]["id"] == old_trash["id"]


def test_unknown_bulk_action_and_forged_upload_completion_rejected(client, auth_headers):
    assert client.post("/api/files/bulk-action", headers=auth_headers, json={"file_ids": [str(uuid.uuid4())], "action": "invented"}).status_code == 422
    completion = client.post("/api/files/upload/complete", headers=auth_headers, json={
        "upload_id": str(uuid.uuid4()), "storage_key": "another-users-secret-file", "filename": "stolen.txt", "size_bytes": 12,
    })
    assert completion.status_code == 404
    assert client.get("/api/storage/usage", headers=auth_headers).json()["used_bytes"] == 0


def test_versions_are_size_limited_and_failed_quota_upload_leaves_no_object(client, auth_headers, db_session, monkeypatch):
    file = upload(client, auth_headers)
    monkeypatch.setattr(settings, "MAX_FILE_SIZE_MB", 1)
    oversized = client.post(f"/api/files/{file['id']}/versions", headers=auth_headers, files={"file": ("large.txt", io.BytesIO(b"x" * (1024 * 1024 + 1)), "text/plain")})
    assert oversized.status_code == 413
    user = db_session.scalar(select(User).where(User.email == "testuser@cloudvault.com"))
    user.storage_quota_bytes = user.storage_used_bytes
    db_session.commit()
    storage = get_storage_provider()
    before = {path for path in storage.base_path.rglob("*") if path.is_file()}
    failed = client.post("/api/files/upload", headers=auth_headers, files={"file": ("no-space.txt", io.BytesIO(b"cannot fit"), "text/plain")})
    assert failed.status_code == 400
    assert {path for path in storage.base_path.rglob("*") if path.is_file()} == before


def test_public_password_is_header_only_and_download_limit_is_enforced(client, auth_headers):
    file = upload(client, auth_headers)
    link = client.post(f"/api/files/{file['id']}/share-links", headers=auth_headers, json={"permission": "download", "password": "Secret456", "max_downloads": 1}).json()
    path = f"/api/public/shares/{link['token']}/download"
    assert client.get(path, params={"password": "Secret456"}).status_code == 401
    assert client.get(path, headers={"X-Share-Password": "Secret456"}).status_code == 200
    assert client.get(path, headers={"X-Share-Password": "Secret456"}).status_code == 410


def test_production_configuration_rejects_insecure_defaults():
    with pytest.raises(ValidationError):
        Settings(_env_file=None, ENVIRONMENT="production")


def test_download_filename_header_is_unicode_safe(client, auth_headers):
    file = upload(client, auth_headers, 'résumé\r\n-injection.txt')
    response = client.get(f"/api/files/{file['id']}/download", headers=auth_headers)
    assert response.status_code == 200
    assert "filename*=UTF-8''" in response.headers["content-disposition"]
    assert "\r" not in response.headers["content-disposition"] and "\n" not in response.headers["content-disposition"]
    assert hashlib.sha256(response.content).hexdigest() == file["checksum"]


def test_upload_retry_is_idempotent_and_key_is_account_scoped(client, auth_headers, second_user_headers):
    key = str(uuid.uuid4())
    headers = {**auth_headers, "Idempotency-Key": key}
    first = upload(client, headers)
    retried = upload(client, headers)
    assert retried["id"] == first["id"]
    assert client.get("/api/storage/usage", headers=auth_headers).json()["used_bytes"] == len(b"original")
    assert client.get("/api/files", headers=auth_headers).json()["total"] == 1
    conflicting = client.post("/api/files/upload", headers=headers, files={"file": ("different.txt", io.BytesIO(b"different"), "text/plain")})
    assert conflicting.status_code == 409
    other = upload(client, {**second_user_headers, "Idempotency-Key": key})
    assert other["id"] != first["id"]


def test_version_retry_is_idempotent_and_does_not_undo_restore(client, auth_headers):
    file = upload(client, auth_headers)
    key = str(uuid.uuid4())
    headers = {**auth_headers, "Idempotency-Key": key}
    path = f"/api/files/{file['id']}/versions"
    first = client.post(path, headers=headers, files={"file": ("regression.txt", io.BytesIO(b"updated"), "text/plain")})
    retried = client.post(path, headers=headers, files={"file": ("regression.txt", io.BytesIO(b"updated"), "text/plain")})
    assert first.status_code == retried.status_code == 201
    assert first.json()["id"] == retried.json()["id"]
    versions = client.get(path, headers=auth_headers).json()
    assert len(versions) == 2
    original = next(version for version in versions if version["version_number"] == 1)
    client.post(f"{path}/{original['id']}/restore", headers=auth_headers)
    assert client.post(path, headers=headers, files={"file": ("regression.txt", io.BytesIO(b"updated"), "text/plain")}).status_code == 201
    assert client.get(f"/api/files/{file['id']}", headers=auth_headers).json()["current_version"] == 1
    assert client.get("/api/storage/usage", headers=auth_headers).json()["used_bytes"] == len(b"originalupdated")
