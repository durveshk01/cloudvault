"""Unit and integration tests for file sharing and public share links."""

import io

import pytest


def test_direct_file_sharing(client, auth_headers, second_user_headers):
    # User A uploads file
    up_res = client.post(
        "/api/files/upload",
        headers=auth_headers,
        files={"file": ("shared_doc.txt", io.BytesIO(b"Shared Content"), "text/plain")},
    )
    file_id = up_res.json()["id"]

    # Share with User B
    share_res = client.post(
        f"/api/files/{file_id}/shares",
        headers=auth_headers,
        json={"shared_with_email": "second@cloudvault.com", "permission": "viewer"},
    )
    assert share_res.status_code == 201

    # User B should now see file in shared-with-me
    swm_res = client.get("/api/shared-with-me", headers=second_user_headers)
    assert swm_res.status_code == 200
    shares = swm_res.json()
    assert any(s["file_id"] == file_id for s in shares)

    # User B can download file
    dl_res = client.get(f"/api/files/{file_id}/download", headers=second_user_headers)
    assert dl_res.status_code == 200
    assert dl_res.content == b"Shared Content"


def test_public_share_link_and_download(client, auth_headers):
    # Upload
    up_res = client.post(
        "/api/files/upload",
        headers=auth_headers,
        files={"file": ("public_file.txt", io.BytesIO(b"Public File Content"), "text/plain")},
    )
    file_id = up_res.json()["id"]

    # Create link
    link_res = client.post(
        f"/api/files/{file_id}/share-links",
        headers=auth_headers,
        json={"permission": "download", "max_downloads": 2},
    )
    assert link_res.status_code == 201
    token = link_res.json()["token"]

    # Fetch public info without auth
    pub_info = client.get(f"/api/public/shares/{token}")
    assert pub_info.status_code == 200
    assert pub_info.json()["filename"] == "public_file.txt"
    assert pub_info.json()["downloads_remaining"] == 2

    # Download 1
    dl1 = client.get(f"/api/public/shares/{token}/download")
    assert dl1.status_code == 200
    assert dl1.content == b"Public File Content"

    # Download 2
    dl2 = client.get(f"/api/public/shares/{token}/download")
    assert dl2.status_code == 200

    # Download 3 should fail due to max_downloads limit
    dl3 = client.get(f"/api/public/shares/{token}/download")
    assert dl3.status_code == 410


def test_password_protected_share_link(client, auth_headers):
    up_res = client.post(
        "/api/files/upload",
        headers=auth_headers,
        files={"file": ("vault_secret.txt", io.BytesIO(b"Secret Code 999"), "text/plain")},
    )
    file_id = up_res.json()["id"]

    link_res = client.post(
        f"/api/files/{file_id}/share-links",
        headers=auth_headers,
        json={"permission": "download", "password": "SecretPassword123"},
    )
    token = link_res.json()["token"]

    # Check metadata requires password
    info = client.get(f"/api/public/shares/{token}").json()
    assert info["requires_password"] is True

    # Try download without password -> should fail
    fail_dl = client.get(f"/api/public/shares/{token}/download")
    assert fail_dl.status_code == 401

    # Try download with correct password -> succeeds
    succ_dl = client.get(f"/api/public/shares/{token}/download", headers={"X-Share-Password": "SecretPassword123"})
    assert succ_dl.status_code == 200
    assert succ_dl.content == b"Secret Code 999"


@pytest.mark.parametrize("password", [" leading and trailing ", "pässword🔒", "only spaces  "])
def test_public_post_preview_and_download_preserve_password(client, auth_headers, password):
    content = b"Password protected content"
    uploaded = client.post("/api/files/upload", headers=auth_headers,
                           files={"file": ("protected.txt", io.BytesIO(content), "text/plain")}).json()
    created = client.post(f"/api/files/{uploaded['id']}/share-links", headers=auth_headers,
                          json={"permission": "download", "password": password, "max_downloads": 1})
    assert created.status_code == 201
    path = f"/api/public/shares/{created.json()['token']}"
    client.cookies.clear()
    assert client.post(f"{path}/preview", json={"password": "incorrect"}).status_code == 401
    preview = client.post(f"{path}/preview", json={"password": password})
    assert preview.status_code == 200 and preview.content == content
    assert client.get(path).json()["downloads_remaining"] == 1
    downloaded = client.post(f"{path}/download", json={"password": password})
    assert downloaded.status_code == 200 and downloaded.content == content
    assert client.post(f"{path}/download", json={"password": password}).status_code == 410
