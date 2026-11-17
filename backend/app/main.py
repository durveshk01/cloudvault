"""CloudVault FastAPI Main Application Entrypoint."""

import logging
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from starlette.middleware.base import BaseHTTPMiddleware

from app.api import (
    activity,
    auth,
    dashboard,
    favorites,
    files,
    folders,
    notifications,
    shares,
    tags,
    trash,
)
from app.core.config import settings
from app.core.database import get_db
from app.core.rate_limit import RateLimitMiddleware

logger = logging.getLogger(__name__)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.url.path.startswith("/api/") and request.method not in ("GET", "HEAD", "OPTIONS"):
            origin = request.headers.get("origin")
            allowed = {*settings.cors_origin_list, settings.FRONTEND_URL.rstrip("/")}
            cookie_auth = "access_token" in request.cookies or "refresh_token" in request.cookies
            if (origin and origin not in allowed) or (not origin and cookie_auth and not request.headers.get("Authorization")):
                return JSONResponse(status_code=403, content={"detail": "Request origin is not authorized."})
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        if "/preview" in request.url.path:
            response.headers["Content-Security-Policy"] = (
                "sandbox; default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; "
                "style-src 'unsafe-inline'; frame-ancestors 'self' " + " ".join(settings.cors_origin_list)
            )
        else:
            response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        if settings.ENVIRONMENT == "production":
            response.headers["Strict-Transport-Security"] = "max-age=31536000"
        return response


@asynccontextmanager
async def lifespan(app: FastAPI):
    if settings.SEED_DEMO:
        from app.scripts.seed import seed_database
        await seed_database()
    yield


app = FastAPI(
    title="CloudVault API",
    description="Secure, High-Performance Cloud File Storage & Sharing Platform REST API",
    version="1.1.0",
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)

# GZip Compression for payloads over 1000 bytes
app.add_middleware(GZipMiddleware, minimum_size=1000)

# Security Headers
app.add_middleware(SecurityHeadersMiddleware)

# Rate Limiting
app.add_middleware(RateLimitMiddleware)

# CORS configuration
cors_origins = list(settings.cors_origin_list)
for extra_origin in [settings.FRONTEND_URL.rstrip("/")]:
    if extra_origin not in cors_origins:
        cors_origins.append(extra_origin)

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition", "X-File-Size", "X-Content-SHA256"],
)

# Include API routers
app.include_router(auth.router)
app.include_router(files.router)
app.include_router(folders.router)
app.include_router(shares.router)
app.include_router(dashboard.router)
app.include_router(trash.router)
app.include_router(favorites.router)
app.include_router(activity.router)
app.include_router(notifications.router)
app.include_router(tags.router)


@app.get("/health", tags=["Health"])
def health_check():
    """Service health and readiness check."""
    return {
        "status": "healthy",
        "service": settings.APP_NAME,
        "storage_backend": settings.STORAGE_BACKEND,
    }


@app.get("/health/ready", tags=["Health"])
def readiness_check(db: Annotated[Session, Depends(get_db)]):
    """Readiness verifies that the database can actually serve queries."""
    try:
        db.execute(text("SELECT 1"))
    except SQLAlchemyError:
        return JSONResponse(status_code=503, content={"status": "unavailable", "service": settings.APP_NAME})
    return {"status": "ready", "service": settings.APP_NAME, "version": "1.1.0"}


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error("Unhandled request failure on %s", request.url.path, exc_info=exc)
    # Log exception safely without exposing internal tracebacks in production
    if settings.DEBUG:
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"detail": str(exc)},
        )
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "An unexpected server error occurred."},
    )
