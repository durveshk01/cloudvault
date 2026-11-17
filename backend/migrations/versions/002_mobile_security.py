"""Revocable sessions, single-use uploads, recoverable folder batches and indexes.

Revision ID: 002_mobile_security
Revises: 001_initial_schema
"""

import sqlalchemy as sa
from alembic import op

revision = "002_mobile_security"
down_revision = "001_initial_schema"
branch_labels = None
depends_on = None

INDEXES = {
    "files": [("ix_files_folder_id", ["folder_id"]), ("ix_files_trash_batch_id", ["trash_batch_id"]), ("ix_files_owner_trash_folder", ["owner_id", "is_trashed", "folder_id"]), ("ix_files_owner_created", ["owner_id", "created_at"])],
    "folders": [("ix_folders_parent_id", ["parent_id"]), ("ix_folders_trash_batch_id", ["trash_batch_id"]), ("ix_folders_owner_parent_trash", ["owner_id", "parent_id", "is_trashed"])],
    "file_versions": [("ix_file_versions_uploaded_by", ["uploaded_by"])],
    "file_shares": [("ix_file_shares_shared_by", ["shared_by"]), ("ix_file_shares_shared_with", ["shared_with"])],
    "share_links": [("ix_share_links_file_id", ["file_id"]), ("ix_share_links_created_by", ["created_by"])],
    "tags": [("ix_tags_user_id", ["user_id"])],
    "file_tags": [("ix_file_tags_tag_id", ["tag_id"])],
}


def upgrade():
    duplicate_versions = op.get_bind().execute(sa.text(
        "SELECT file_id FROM file_versions GROUP BY file_id, version_number HAVING COUNT(*) > 1 LIMIT 1"
    )).first()
    if duplicate_versions:
        raise RuntimeError("Duplicate legacy version numbers found. Resolve them before applying 002; no versions are deleted automatically.")
    op.create_table(
        "auth_sessions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("refresh_token_hash", sa.String(64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.current_timestamp(), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_auth_sessions_user_id", "auth_sessions", ["user_id"])
    op.create_index("ix_auth_sessions_expires_at", "auth_sessions", ["expires_at"])
    op.create_table(
        "upload_sessions",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("owner_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("folder_id", sa.Uuid(), sa.ForeignKey("folders.id", ondelete="SET NULL")),
        sa.Column("filename", sa.String(255), nullable=False),
        sa.Column("storage_key", sa.String(512), nullable=False, unique=True),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("mime_type", sa.String(255), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.current_timestamp(), nullable=False),
    )
    for column in ("owner_id", "folder_id", "expires_at"):
        op.create_index(f"ix_upload_sessions_{column}", "upload_sessions", [column])
    op.add_column("files", sa.Column("trash_batch_id", sa.Uuid(), nullable=True))
    op.add_column("folders", sa.Column("trash_batch_id", sa.Uuid(), nullable=True))
    for table, indexes in INDEXES.items():
        for name, columns in indexes:
            op.create_index(name, table, columns)
    with op.batch_alter_table("file_versions") as batch:
        batch.create_unique_constraint("uq_file_versions_number", ["file_id", "version_number"])


def downgrade():
    with op.batch_alter_table("file_versions") as batch:
        batch.drop_constraint("uq_file_versions_number", type_="unique")
    for table, indexes in INDEXES.items():
        for name, _ in indexes:
            op.drop_index(name, table_name=table)
    op.drop_column("folders", "trash_batch_id")
    op.drop_column("files", "trash_batch_id")
    op.drop_table("upload_sessions")
    op.drop_table("auth_sessions")
