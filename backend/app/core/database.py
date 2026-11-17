"""Database engine and session configuration with PostgreSQL and SQLite support."""

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.core.config import settings


def normalize_database_url(url: str) -> str:
    """Use the installed psycopg 3 driver consistently in the app and Alembic."""
    if url.startswith("postgres://"):
        url = "postgresql://" + url.removeprefix("postgres://")
    if url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url.removeprefix("postgresql://")
    return url


url = normalize_database_url(settings.DATABASE_URL)

connect_args = {}
engine_kwargs = {}
if url.startswith("sqlite"):
    connect_args = {"check_same_thread": False}
else:
    engine_kwargs = {
        "pool_pre_ping": True,
        "pool_size": settings.DB_POOL_SIZE,
        "max_overflow": settings.DB_MAX_OVERFLOW,
        "pool_timeout": 15,
        "pool_recycle": 1800,
    }

engine = create_engine(url, connect_args=connect_args, **engine_kwargs)

if url.startswith("sqlite"):
    @event.listens_for(engine, "connect")
    def enable_sqlite_foreign_keys(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
