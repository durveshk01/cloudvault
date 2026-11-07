"""Integration tests for dashboard, storage usage, activity logs, tags, notifications, and previews."""

import io
import pytest


def test_health_check(client):
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"
    assert "service" in data


def test_dashboard_stats(client, auth_headers):
    # Upload a test file first
    client.post(
        "/api/files/upload",
        headers=auth_headers,
        files={"file": ("dash_doc.txt", io.BytesIO(b"Dashboard test document"), "text/plain")},
    )

    response = client.get("/api/dashboard/stats", headers=auth_headers)
    assert response.status_code == 200
    data = response.json()
    assert "total_files" in data
    assert "total_folders" in data
    assert "storage_used_bytes" in data
    assert "storage_quota_bytes" in data
    assert data["total_files"] >= 1


def test_storage_usage(client, auth_headers):
    response = client.get("/api/storage/usage", headers=auth_headers)
    assert response.status_code == 200
    data = response.json()
    assert "used_bytes" in data
    assert "quota_bytes" in data
    assert "available_bytes" in data
    assert "used_percentage" in data


def test_activity_logs(client, auth_headers):
    # Perform an action that logs activity
    client.post(
        "/api/files/upload",
        headers=auth_headers,
        files={"file": ("activity_doc.txt", io.BytesIO(b"Logged action data"), "text/plain")},
    )

    response = client.get("/api/activity?limit=10", headers=auth_headers)
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    assert len(data) >= 1
    assert "action" in data[0]


def test_notifications_lifecycle(client, auth_headers):
    # List notifications
    res = client.get("/api/notifications", headers=auth_headers)
    assert res.status_code == 200
    notifs = res.json()
    assert isinstance(notifs, list)

    # Mark all read
    read_all_res = client.post("/api/notifications/read-all", headers=auth_headers)
    assert read_all_res.status_code == 200


def test_tags_lifecycle(client, auth_headers):
    # Create tag
    create_res = client.post("/api/tags", headers=auth_headers, json={"name": "finance"})
    assert create_res.status_code in (200, 201)
    tag_data = create_res.json()
    assert tag_data["name"] == "finance"
    tag_id = tag_data["id"]

    # List tags
    list_res = client.get("/api/tags", headers=auth_headers)
    assert list_res.status_code == 200
    names = [t["name"] for t in list_res.json()]
    assert "finance" in names

    # Assign tag to a file
    up_res = client.post(
        "/api/files/upload",
        headers=auth_headers,
        files={"file": ("tagged_file.txt", io.BytesIO(b"Tagged file content"), "text/plain")},
    )
    file_id = up_res.json()["id"]

    assign_res = client.post(
        f"/api/files/{file_id}/tags",
        headers=auth_headers,
        json={"tag_ids": [tag_id]},
    )
    assert assign_res.status_code == 200


def test_file_preview_with_token_and_csp(client, auth_headers):
    content = b"Previewable text content"
    up_res = client.post(
        "/api/files/upload",
        headers=auth_headers,
        files={"file": ("preview_test.txt", io.BytesIO(content), "text/plain")},
    )
    file_id = up_res.json()["id"]

    # Preview with Authorization header
    preview_res = client.get(f"/api/files/{file_id}/preview", headers=auth_headers)
    assert preview_res.status_code == 200
    assert preview_res.content == content
    # CSP should be set and X-Frame-Options must not be DENY
    assert "frame-ancestors" in preview_res.headers.get("content-security-policy", "")
    assert preview_res.headers.get("x-frame-options") is None


def test_rate_limiting(client):
    from app.core.rate_limit import limiter
    limiter.clear()

    # The rate limit on /api/auth/login is 10/minute
    statuses = []
    for _ in range(12):
        res = client.post(
            "/api/auth/login",
            json={"email": "fake@cloudvault.com", "password": "wrong_password_123"},
            headers={"x-test-rate-limit": "true"},
        )
        statuses.append(res.status_code)

    # First request should fail auth with 401, not 429
    assert statuses[0] == 401
    # Requests exceeding limit should be throttled (429)
    assert 429 in statuses
    assert statuses[-1] == 429

    limiter.clear()

