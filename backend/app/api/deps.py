"""API dependencies for database sessions and authentication."""

import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import decode_token
from app.models.session import AuthSession
from app.models.user import User
from app.services.auth_service import session_id

bearer_scheme = HTTPBearer(auto_error=False)


def get_current_user(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    token_cred: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)] = None,
) -> User:
    """Extract and validate JWT token from Bearer header or Authorization cookie."""
    token = None
    if token_cred:
        token = token_cred.credentials
    elif "access_token" in request.cookies:
        token = request.cookies.get("access_token")

    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required. Please log in.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    payload = decode_token(token)
    sid = session_id(payload)
    if not payload or payload.get("type") != "access" or not sid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired authentication token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user_id_str = payload.get("sub")
    try:
        user_id = uuid.UUID(user_id_str)
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication token payload.",
        ) from None

    user = db.scalar(select(User).join(AuthSession, AuthSession.user_id == User.id).where(
        User.id == user_id,
        AuthSession.id == sid,
        AuthSession.revoked_at.is_(None),
        AuthSession.expires_at > datetime.now(UTC),
    ))
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found.",
        )
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User account is inactive.",
        )

    return user


def get_current_user_optional(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    token_cred: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)] = None,
) -> User | None:
    try:
        return get_current_user(request, db, token_cred)
    except HTTPException:
        return None
