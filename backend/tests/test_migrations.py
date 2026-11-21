"""Exercise the actual Alembic schema, including upgrades of existing databases."""

import hashlib
import io
import uuid
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.core.database import get_db
from app.main import app

BACKEND = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("existing_database", [False, True])
def test_migrated_sqlite_defaults_support_real_account_and_file_records(tmp_path, monkeypatch, existing_database):
    url = f"sqlite:///{(tmp_path / 'migrated.db').as_posix()}"
    monkeypatch.setattr(settings, "DATABASE_URL", url)
    config = Config(str(BACKEND / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND / "migrations"))
    engine = create_engine(url)
    old_user = uuid.UUID("10000000-0000-4000-8000-000000000001").hex
    preserved = {}
    try:
        if existing_database:
            command.upgrade(config, "002_mobile_security")
            with engine.begin() as connection:
                connection.execute(text(
                    "INSERT INTO users (id, email, full_name, password_hash, created_at) "
                    "VALUES (:id, 'existing@example.com', 'Existing Account', 'test-only-hash', '2026-01-01 00:00:00')"
                ), {"id": old_user})
                legacy = {table: uuid.uuid4().hex for table in (
                    "folders", "files", "file_versions", "file_shares", "share_links",
                    "tags", "file_tags", "activity_logs", "notifications", "auth_sessions", "upload_sessions",
                )}
                statements = {
                    "folders": "INSERT INTO folders (id, owner_id, name, created_at) VALUES (:id, :user, 'Legacy folder', :created)",
                    "files": "INSERT INTO files (id, owner_id, folder_id, original_filename, storage_key, size_bytes, created_at) VALUES (:id, :user, :folder, 'legacy.txt', 'legacy/file', 4, :created)",
                    "file_versions": "INSERT INTO file_versions (id, file_id, version_number, storage_key, size_bytes, uploaded_by, created_at) VALUES (:id, :file, 1, 'legacy/file', 4, :user, :created)",
                    "file_shares": "INSERT INTO file_shares (id, file_id, shared_by, shared_with, created_at) VALUES (:id, :file, :user, :user, :created)",
                    "share_links": "INSERT INTO share_links (id, file_id, token_hash, created_by, created_at) VALUES (:id, :file, 'legacy-token', :user, :created)",
                    "tags": "INSERT INTO tags (id, name, user_id, created_at) VALUES (:id, 'legacy', :user, :created)",
                    "file_tags": "INSERT INTO file_tags (id, file_id, tag_id) VALUES (:id, :file, :tag)",
                    "activity_logs": "INSERT INTO activity_logs (id, user_id, action, created_at) VALUES (:id, :user, 'file_uploaded', :created)",
                    "notifications": "INSERT INTO notifications (id, user_id, type, title, created_at) VALUES (:id, :user, 'legacy', 'Legacy notification', :created)",
                    "auth_sessions": "INSERT INTO auth_sessions (id, user_id, refresh_token_hash, expires_at) VALUES (:id, :user, 'legacy-refresh', '2027-01-01 00:00:00')",
                    "upload_sessions": "INSERT INTO upload_sessions (id, owner_id, folder_id, filename, storage_key, size_bytes, mime_type, expires_at) VALUES (:id, :user, :folder, 'staged.txt', 'legacy/staged', 4, 'text/plain', '2027-01-01 00:00:00')",
                }
                for table, statement in statements.items():
                    connection.execute(text(statement), {
                        "id": legacy[table], "user": old_user, "folder": legacy["folders"],
                        "file": legacy["files"], "tag": legacy["tags"], "created": "2026-01-01 00:00:00",
                    })
                for table in ("users", *legacy):
                    preserved[table] = [dict(row) for row in connection.execute(text(f"SELECT * FROM {table}")).mappings()]
                    boolean_columns = {
                        "users": ("is_active",), "folders": ("is_trashed",),
                        "files": ("is_trashed", "is_starred"),
                        "share_links": ("is_revoked",), "notifications": ("is_read",),
                    }
                    for row in preserved[table]:
                        for column in boolean_columns.get(table, ()):
                            if row[column] in ("true", "false"):
                                row[column] = int(row[column] == "true")
        command.upgrade(config, "head")
        command.upgrade(config, "head")
        # Alembic uses another engine. Reconnect just as the documented server
        # restart does, rather than reusing SQLite's cached pre-upgrade schema.
        engine.dispose()
        ids = {table: uuid.uuid4().hex for table in (
            "users", "folders", "files", "file_versions", "file_shares", "share_links", "tags", "activity_logs", "notifications"
        )}
        with engine.begin() as connection:
            for table, records in preserved.items():
                actual = [dict(row) for row in connection.execute(text(f"SELECT * FROM {table}")).mappings()]
                assert actual == records, f"Upgrade must preserve every {table} record and its intended boolean flags"
            # Omit created_at everywhere: these are the server defaults used by
            # registration, uploads, sharing and audit events, not ORM-created DDL.
            connection.execute(text(
                "INSERT INTO users (id, email, full_name, password_hash) "
                "VALUES (:id, 'new@example.com', 'New Account', 'test-only-hash')"
            ), {"id": ids["users"]})
            statements = {
                "folders": "INSERT INTO folders (id, owner_id, name) VALUES (:id, :user, 'Documents')",
                "files": "INSERT INTO files (id, owner_id, folder_id, original_filename, storage_key, size_bytes) VALUES (:id, :user, :folder, 'note.txt', 'fixture/note.txt', 4)",
                "file_versions": "INSERT INTO file_versions (id, file_id, version_number, storage_key, size_bytes, uploaded_by) VALUES (:id, :file, 1, 'fixture/note.txt', 4, :user)",
                "file_shares": "INSERT INTO file_shares (id, file_id, shared_by, shared_with) VALUES (:id, :file, :user, :user)",
                "share_links": "INSERT INTO share_links (id, file_id, token_hash, created_by) VALUES (:id, :file, 'test-only-token-hash', :user)",
                "tags": "INSERT INTO tags (id, name, user_id) VALUES (:id, 'important', :user)",
                "activity_logs": "INSERT INTO activity_logs (id, user_id, action) VALUES (:id, :user, 'file_uploaded')",
                "notifications": "INSERT INTO notifications (id, user_id, type, title) VALUES (:id, :user, 'welcome', 'Welcome')",
            }
            for table, statement in statements.items():
                connection.execute(text(statement), {"id": ids[table], "user": ids["users"], "folder": ids["folders"], "file": ids["files"]})
            for table, identifier in ids.items():
                created = connection.scalar(text(f"SELECT created_at FROM {table} WHERE id = :id"), {"id": identifier})
                assert created is not None, f"{table} must create a timestamp without an explicit value"
            for table, column, expected in (
                ("users", "is_active", 1), ("folders", "is_trashed", 0),
                ("files", "is_trashed", 0), ("files", "is_starred", 0),
                ("share_links", "is_revoked", 0), ("notifications", "is_read", 0),
            ):
                value = connection.scalar(text(f"SELECT {column} FROM {table} WHERE id = :id"), {"id": ids[table]})
                assert value == expected, f"{table}.{column} must default to a SQLite boolean, not a truthy string"
            if existing_database:
                assert connection.scalar(text("SELECT full_name FROM users WHERE id = :id"), {"id": old_user}) == "Existing Account"
            assert connection.execute(text("PRAGMA foreign_key_check")).all() == []
        assert {"files", "folders", "auth_sessions", "upload_sessions"}.issubset(inspect(engine).get_table_names())
        constraints = inspect(engine).get_unique_constraints("file_versions")
        assert any(item["column_names"] == ["file_id", "version_number"] for item in constraints)
    finally:
        engine.dispose()


def test_migrated_schema_supports_authentication_and_verified_transfers(tmp_path, monkeypatch):
    url = f"sqlite:///{(tmp_path / 'api.db').as_posix()}"
    monkeypatch.setattr(settings, "DATABASE_URL", url)
    config = Config(str(BACKEND / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND / "migrations"))
    command.upgrade(config, "head")
    engine = create_engine(url, connect_args={"check_same_thread": False})

    @event.listens_for(engine, "connect")
    def enable_foreign_keys(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")

    sessions = sessionmaker(bind=engine)

    def migrated_db():
        with sessions() as session:
            yield session

    previous = app.dependency_overrides.copy()
    app.dependency_overrides[get_db] = migrated_db
    try:
        with TestClient(app, headers={"Origin": "http://localhost:3000"}) as client:
            account = {"email": "migration-api@example.com", "full_name": "Migration Account", "password": "Password123!", "confirm_password": "Password123!"}
            registered = client.post("/api/auth/register", json=account)
            assert registered.status_code == 201, registered.text
            logged_in = client.post("/api/auth/login", json={"email": account["email"], "password": account["password"]})
            assert logged_in.status_code == 200, logged_in.text
            headers = {"Authorization": f"Bearer {logged_in.json()['access_token']}"}
            assert client.get("/api/auth/me", headers=headers).status_code == 200
            content = b"Verified transfer on the real Alembic schema"
            uploaded = client.post("/api/files/upload", headers=headers, files={"file": ("migration.txt", io.BytesIO(content), "text/plain")})
            assert uploaded.status_code == 201, uploaded.text
            file_id = uploaded.json()["id"]
            for endpoint in ("preview", "download"):
                response = client.get(f"/api/files/{file_id}/{endpoint}", headers=headers)
                assert response.status_code == 200, response.text
                assert response.content == content
                assert response.headers["x-content-sha256"] == hashlib.sha256(content).hexdigest()
            assert client.get("/health/ready").json()["status"] == "ready"
    finally:
        app.dependency_overrides.clear()
        app.dependency_overrides.update(previous)
        engine.dispose()
