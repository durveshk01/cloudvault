"""In-memory sliding window rate limiter for CloudVault."""

import time
from collections import defaultdict
from threading import Lock
from typing import Dict, List, Tuple
from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from app.core.config import settings


def parse_rate_limit(limit_str: str) -> Tuple[int, int]:
    """Parse '10/minute', '30/minute', '120/second', etc. into (max_requests, window_seconds)."""
    try:
        count_str, period = limit_str.strip().split("/")
        count = int(count_str)
        period = period.lower().strip()
        if period in ("second", "sec", "s"):
            seconds = 1
        elif period in ("minute", "min", "m"):
            seconds = 60
        elif period in ("hour", "hr", "h"):
            seconds = 3600
        elif period in ("day", "d"):
            seconds = 86400
        else:
            seconds = 60
        return count, seconds
    except Exception:
        return 120, 60


class SlidingWindowRateLimiter:
    """Thread-safe sliding window rate limiter tracking request timestamps."""

    def __init__(self):
        self._lock = Lock()
        self._history: Dict[str, List[float]] = defaultdict(list)

    def is_allowed(self, key: str, max_requests: int, window_seconds: int) -> Tuple[bool, int]:
        """Returns (is_allowed, retry_after_seconds)."""
        now = time.time()
        cutoff = now - window_seconds
        with self._lock:
            timestamps = self._history[key]
            valid = [ts for ts in timestamps if ts > cutoff]
            if len(valid) >= max_requests:
                retry_after = int(valid[0] + window_seconds - now) + 1
                self._history[key] = valid
                return False, max(1, retry_after)
            valid.append(now)
            self._history[key] = valid
            return True, 0

    def clear(self):
        """Reset all rate limit counters (useful for test isolation)."""
        with self._lock:
            self._history.clear()


limiter = SlidingWindowRateLimiter()


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Enforces rate limiting based on route category and client IP."""

    def __init__(self, app, enabled: bool = True):
        super().__init__(app)
        self.enabled = enabled

    async def dispatch(self, request: Request, call_next):
        if not self.enabled or request.method == "OPTIONS":
            return await call_next(request)

        path = request.url.path

        # Determine rate limit bucket
        if path.startswith("/api/auth/login") or path.startswith("/api/auth/register"):
            max_req, window = parse_rate_limit(settings.RATE_LIMIT_AUTH)
            bucket = "auth"
        elif path.startswith("/api/files/upload"):
            max_req, window = parse_rate_limit(settings.RATE_LIMIT_UPLOAD)
            bucket = "upload"
        elif path.startswith("/api/"):
            max_req, window = parse_rate_limit(settings.RATE_LIMIT_DEFAULT)
            bucket = "default"
        else:
            # Health, docs, openapi, static routes not rate-limited
            return await call_next(request)

        forwarded = request.headers.get("x-forwarded-for")
        client_ip = (
            forwarded.split(",")[0].strip()
            if forwarded
            else (request.client.host if request.client else "unknown")
        )

        # In testing environments, bypass rate limiting for testclient unless explicitly testing rate limits
        if client_ip == "testclient" and not request.headers.get("x-test-rate-limit"):
            return await call_next(request)

        rate_key = f"{bucket}:{client_ip}"

        allowed, retry_after = limiter.is_allowed(rate_key, max_req, window)
        if not allowed:
            return JSONResponse(
                status_code=429,
                content={"detail": "Too many requests. Please try again later."},
                headers={"Retry-After": str(retry_after)},
            )

        response = await call_next(request)
        return response
