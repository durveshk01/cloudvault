"""Security utilities for password hashing (Argon2id) and JWT tokens."""

import uuid
from datetime import UTC, datetime, timedelta

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

from app.core.config import settings

ALGORITHM = "HS256"
ph = PasswordHasher()


def hash_password(password: str) -> str:
    """Hash password using Argon2id."""
    return ph.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    """Verify password against Argon2id hash."""
    try:
        return ph.verify(hashed, plain)
    except (VerificationError, InvalidHashError):
        return False


def create_access_token(data: dict, expires_delta: timedelta | None = None) -> str:
    to_encode = data.copy()
    expire = datetime.now(UTC) + (expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire, "iat": datetime.now(UTC), "jti": uuid.uuid4().hex, "type": "access"})
    return jwt.encode(to_encode, settings.APP_SECRET, algorithm=ALGORITHM)


def create_refresh_token(data: dict) -> str:
    to_encode = data.copy()
    expire = datetime.now(UTC) + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
    to_encode.update({"exp": expire, "iat": datetime.now(UTC), "jti": uuid.uuid4().hex, "type": "refresh"})
    return jwt.encode(to_encode, settings.APP_SECRET, algorithm=ALGORITHM)


def decode_token(token: str) -> dict | None:
    try:
        payload = jwt.decode(token, settings.APP_SECRET, algorithms=[ALGORITHM], options={"require": ["exp", "sub"]})
        if not isinstance(payload.get("sub"), str):
            return None
        return payload
    except (jwt.PyJWTError, TypeError, ValueError):
        return None
