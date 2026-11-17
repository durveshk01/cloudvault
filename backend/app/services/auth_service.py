"""Authentication and User management service."""

import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException, status
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    verify_password,
)
from app.models.session import AuthSession
from app.models.user import User
from app.schemas.auth import (
    ChangePasswordRequest,
    LoginRequest,
    RegisterRequest,
    TokenResponse,
)
from app.services.activity_service import ActivityService

_DUMMY_HASH = hash_password(secrets.token_urlsafe(32))


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def session_id(payload: dict | None) -> uuid.UUID | None:
    try:
        return uuid.UUID(payload.get("sid", "")) if payload else None
    except (ValueError, TypeError, AttributeError):
        return None


def issue_tokens(user: User, sid: uuid.UUID) -> TokenResponse:
    data = {"sub": str(user.id), "sid": str(sid)}
    return TokenResponse(
        access_token=create_access_token(data),
        refresh_token=create_refresh_token(data),
        expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    )


class AuthService:
    @staticmethod
    def register(db: Session, req: RegisterRequest) -> User:
        # Check if email exists
        existing = db.scalar(select(User).where(User.email == req.email.lower()))
        if existing:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="An account with this email already exists.",
            )

        user = User(
            email=req.email.lower(),
            full_name=req.full_name,
            password_hash=hash_password(req.password),
            storage_quota_bytes=settings.DEFAULT_STORAGE_QUOTA_BYTES,
        )
        db.add(user)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=400, detail="An account with this email already exists.") from None
        db.refresh(user)

        ActivityService.log_activity(
            db,
            user_id=user.id,
            action="account_created",
            resource_type="user",
            resource_id=user.id,
            resource_name=user.email,
        )
        return user

    @staticmethod
    def login(db: Session, req: LoginRequest) -> TokenResponse:
        user = db.scalar(select(User).where(User.email == req.email.lower()))
        valid_password = verify_password(req.password, user.password_hash if user else _DUMMY_HASH)
        if not user or not valid_password:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid email or password.",
            )
        if not user.is_active:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Account is inactive.",
            )

        now = datetime.now(UTC)
        sid = uuid.uuid4()
        tokens = issue_tokens(user, sid)
        db.execute(delete(AuthSession).where(AuthSession.user_id == user.id, AuthSession.expires_at < now))
        db.add(AuthSession(
            id=sid,
            user_id=user.id,
            refresh_token_hash=token_hash(tokens.refresh_token),
            expires_at=now + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS),
        ))
        db.commit()

        ActivityService.log_activity(
            db,
            user_id=user.id,
            action="login",
            resource_type="user",
            resource_id=user.id,
            resource_name=user.email,
        )

        return tokens

    @staticmethod
    def refresh_access_token(db: Session, refresh_token: str | None) -> TokenResponse:
        payload = decode_token(refresh_token)
        sid = session_id(payload)
        if not payload or payload.get("type") != "refresh" or not sid:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or expired refresh token.",
            )

        user_id_str = payload.get("sub")
        try:
            user_id = uuid.UUID(user_id_str)
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Malformed token subject.",
            ) from None

        user = db.scalar(select(User).where(User.id == user_id))
        if not user or not user.is_active:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="User not found or inactive.",
            )

        now = datetime.now(UTC)
        tokens = issue_tokens(user, sid)
        # Compare-and-swap makes refresh tokens single-use, including concurrent requests.
        result = db.execute(
            update(AuthSession).where(
                AuthSession.id == sid,
                AuthSession.user_id == user.id,
                AuthSession.refresh_token_hash == token_hash(refresh_token),
                AuthSession.revoked_at.is_(None),
                AuthSession.expires_at > now,
            ).values(
                refresh_token_hash=token_hash(tokens.refresh_token),
                expires_at=now + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS),
            )
        )
        if result.rowcount != 1:
            db.rollback()
            raise HTTPException(status_code=401, detail="Session expired or refresh token already used. Please sign in again.")
        db.commit()
        return tokens

    @staticmethod
    def logout(db: Session, token: str | None) -> None:
        payload = decode_token(token) if token else None
        sid = session_id(payload)
        if sid:
            db.execute(update(AuthSession).where(AuthSession.id == sid).values(revoked_at=datetime.now(UTC)))
            db.commit()

    @staticmethod
    def change_password(db: Session, user: User, req: ChangePasswordRequest) -> None:
        if not verify_password(req.current_password, user.password_hash):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Current password is incorrect.",
            )

        user.password_hash = hash_password(req.new_password)
        db.execute(update(AuthSession).where(AuthSession.user_id == user.id).values(revoked_at=datetime.now(UTC)))
        db.commit()

        ActivityService.log_activity(
            db,
            user_id=user.id,
            action="password_changed",
            resource_type="user",
            resource_id=user.id,
        )

    @staticmethod
    def update_profile(db: Session, user: User, full_name: str | None) -> User:
        if full_name:
            user.full_name = full_name
            db.commit()
            db.refresh(user)
            ActivityService.log_activity(
                db,
                user_id=user.id,
                action="profile_updated",
                resource_type="user",
                resource_id=user.id,
            )
        return user
