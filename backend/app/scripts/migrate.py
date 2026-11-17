"""Apply database migrations, safely baselining the original ORM-created schema."""

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import Index, MetaData, Table, inspect

import app.models  # noqa: F401 - register every model with Base.metadata
from app.core.database import engine

INITIAL_REVISION = "001_initial_schema"


def initial_metadata(config: Config) -> MetaData:
    """Capture the immutable initial revision's DDL, not today's evolving models."""
    metadata = MetaData()

    class Capture:
        def create_table(self, name, *columns_and_constraints):
            Table(name, metadata, *columns_and_constraints)

        def create_index(self, name, table_name, columns, unique=False):
            Index(name, *(metadata.tables[table_name].c[column] for column in columns), unique=unique)

        @staticmethod
        def f(name):
            return name

    initial = ScriptDirectory.from_config(config).get_revision(INITIAL_REVISION).module
    original_op = initial.op
    try:
        initial.op = Capture()
        initial.upgrade()
    finally:
        initial.op = original_op
    return metadata


def _baseline_existing_schema(config: Config) -> None:
    """Stamp an existing complete schema instead of rerunning CREATE TABLE.

    The deployed database was originally initialized with ``metadata.create_all``.
    Only stamp it when every managed table exists and Alembic reports no schema
    differences from the original migration metadata. Partial or divergent schemas
    fail closed and require an explicit migration.
    """
    baseline = initial_metadata(config)
    expected_tables = set(baseline.tables)
    with engine.connect() as connection:
        inspector = inspect(connection)
        existing_tables = set(inspector.get_table_names()) - {"alembic_version"}

        if not existing_tables:
            return
        if "alembic_version" in inspector.get_table_names():
            return
        if existing_tables != expected_tables:
            missing = sorted(expected_tables - existing_tables)
            unexpected = sorted(existing_tables - expected_tables)
            raise RuntimeError(
                "Refusing to baseline an incomplete database schema. "
                f"Missing tables: {missing}; unexpected tables: {unexpected}."
            )

        migration_context = MigrationContext.configure(
            connection,
            opts={"compare_type": True, "compare_server_default": False},
        )
        differences = compare_metadata(migration_context, baseline)
        if differences:
            raise RuntimeError(
                "Refusing to baseline a database that differs from the ORM "
                f"schema: {differences}"
            )

    print(f"Stamping verified existing schema at {INITIAL_REVISION}.")
    command.stamp(config, INITIAL_REVISION)


def main() -> None:
    config = Config("alembic.ini")
    _baseline_existing_schema(config)
    command.upgrade(config, "head")


if __name__ == "__main__":
    main()
