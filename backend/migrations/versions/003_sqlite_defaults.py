"""Repair timestamp and boolean defaults in migrated SQLite databases.

Revision ID: 003_sqlite_defaults
Revises: 002_mobile_security

Keep the released initial migration immutable. PostgreSQL already supports
now(); SQLite needs CURRENT_TIMESTAMP and numeric boolean defaults instead of
the truthy strings 'true' and 'false'. Alembic's SQLite migration connection
has foreign-key enforcement off so parent-table rebuilds preserve child rows.
"""

import sqlalchemy as sa
from alembic import op

revision = "003_sqlite_defaults"
down_revision = "002_mobile_security"
branch_labels = None
depends_on = None

TABLES = (
    "users", "folders", "files", "file_versions", "file_shares",
    "share_links", "tags", "activity_logs", "notifications",
)
BOOLEAN_DEFAULTS = {
    "users": {"is_active": True},
    "folders": {"is_trashed": False},
    "files": {"is_trashed": False, "is_starred": False},
    "share_links": {"is_revoked": False},
    "notifications": {"is_read": False},
}


def upgrade():
    if op.get_bind().dialect.name != "sqlite":
        return
    if op.get_bind().exec_driver_sql("PRAGMA foreign_keys").scalar():
        raise RuntimeError("SQLite table rebuilds require foreign_keys=OFF on the migration connection.")
    for table in TABLES:
        # Rows inserted using the old server defaults contain text too. Convert
        # only those two invalid boolean representations to their intended flags.
        for column in BOOLEAN_DEFAULTS.get(table, {}):
            op.execute(sa.text(
                f"UPDATE {table} SET {column} = CASE {column} WHEN 'true' THEN 1 WHEN 'false' THEN 0 END "
                f"WHERE {column} IN ('true', 'false')"
            ))
        with op.batch_alter_table(table) as batch:
            batch.alter_column(
                "created_at", existing_type=sa.DateTime(timezone=True),
                existing_nullable=False, server_default=sa.func.current_timestamp(),
            )
            for column, default in BOOLEAN_DEFAULTS.get(table, {}).items():
                batch.alter_column(
                    column, existing_type=sa.Boolean(), existing_nullable=False,
                    server_default=sa.true() if default else sa.false(),
                )
    if op.get_bind().exec_driver_sql("PRAGMA foreign_key_check").first():
        raise RuntimeError("SQLite foreign-key integrity check failed after repairing defaults.")


def downgrade():
    # CURRENT_TIMESTAMP is valid at revision 002 too. Retain the corrected
    # defaults rather than reinstalling an unusable SQLite function.
    pass
