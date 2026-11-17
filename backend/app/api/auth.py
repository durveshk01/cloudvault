"""Authentication API endpoints."""

from typing import Annotated

from fastapi import APIRouter, Body, Depends, Request, Response, status
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db
from app.core.config import settings
from app.models.user import User
from app.schemas.auth import (
    ChangePasswordRequest,
    LoginRequest,
    RefreshTokenRequest,
    RegisterRequest,
    TokenResponse,
)
from app.schemas.common import MessageResponse
from app.schemas.user import UserResponse, UserUpdate
from app.services.auth_service import AuthService

router = APIRouter(prefix="/api", tags=["Authentication"])


def set_session_cookies(response: Response, tokens: TokenResponse) -> None:
    response.headers["Cache-Control"] = "no-store"
    for key, value, age in (
        ("access_token", tokens.access_token, settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60),
        ("refresh_token", tokens.refresh_token, settings.REFRESH_TOKEN_EXPIRE_DAYS * 86400),
    ):
        response.set_cookie(key, value, httponly=True, samesite=settings.COOKIE_SAMESITE, secure=settings.COOKIE_SECURE, max_age=age)


def clear_session_cookies(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"
    for key in ("access_token", "refresh_token"):
        response.delete_cookie(key, httponly=True, samesite=settings.COOKIE_SAMESITE, secure=settings.COOKIE_SECURE)


@router.post("/auth/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def register(
    req: RegisterRequest,
    db: Annotated[Session, Depends(get_db)],
):
    """Register a new user account."""
    user = AuthService.register(db, req)
    return UserResponse.model_validate(user)


@router.post("/auth/login", response_model=TokenResponse)
def login(
    req: LoginRequest,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
):
    """Authenticate with email and password."""
    tokens = AuthService.login(db, req)
    set_session_cookies(response, tokens)
    return tokens


@router.post("/auth/refresh", response_model=TokenResponse)
def refresh_token(
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
    req: RefreshTokenRequest | None = Body(None),
):
    """Exchange refresh token for a new access token."""
    refresh = req.refresh_token if req and req.refresh_token else request.cookies.get("refresh_token")
    tokens = AuthService.refresh_access_token(db, refresh)
    set_session_cookies(response, tokens)
    return tokens


@router.post("/auth/logout", response_model=MessageResponse)
def logout(request: Request, response: Response, db: Annotated[Session, Depends(get_db)], req: RefreshTokenRequest | None = Body(None)):
    """Revoke the server-side session and clear HttpOnly cookies."""
    authorization = request.headers.get("Authorization", "")
    bearer = authorization[7:] if authorization.lower().startswith("bearer ") else None
    AuthService.logout(db, req.refresh_token if req and req.refresh_token else request.cookies.get("refresh_token") or bearer or request.cookies.get("access_token"))
    clear_session_cookies(response)
    return MessageResponse(message="Successfully logged out.")


@router.get("/auth/me", response_model=UserResponse)
def get_current_user_profile(
    current_user: Annotated[User, Depends(get_current_user)],
):
    """Get profile of authenticated user."""
    return UserResponse.model_validate(current_user)


@router.patch("/users/me", response_model=UserResponse)
def update_profile(
    req: UserUpdate,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
):
    """Update user full name or profile settings."""
    user = AuthService.update_profile(db, current_user, req.full_name)
    return UserResponse.model_validate(user)


@router.post("/auth/change-password", response_model=MessageResponse)
def change_password(
    req: ChangePasswordRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    response: Response,
):
    """Change account password."""
    AuthService.change_password(db, current_user, req)
    clear_session_cookies(response)
    return MessageResponse(message="Password changed. Please sign in again on your devices.")
