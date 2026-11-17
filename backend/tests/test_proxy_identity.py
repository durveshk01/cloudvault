"""Deployment regression: trusted ingress clients have separate rate buckets."""

from pathlib import Path

import httpx
import pytest
import uvicorn
import yaml
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route

from app.core.config import settings
from app.core.rate_limit import RateLimitMiddleware, limiter


@pytest.fixture
def proxy_app(monkeypatch):
    compose = yaml.safe_load((Path(__file__).resolve().parents[2] / "docker-compose.yml").read_text(encoding="utf-8"))
    environment = dict(item.split("=", 1) for item in compose["services"]["backend"]["environment"])
    monkeypatch.setenv("FORWARDED_ALLOW_IPS", environment.get("FORWARDED_ALLOW_IPS", "127.0.0.1"))
    monkeypatch.setattr(settings, "RATE_LIMIT_ENABLED", True)
    monkeypatch.setattr(settings, "RATE_LIMIT_AUTH", "1/minute")
    limiter.clear()

    async def login(_request):
        return JSONResponse({"ok": True})

    app = Starlette(routes=[Route("/api/auth/login", login)])
    app.add_middleware(RateLimitMiddleware)
    # Use Uvicorn's actual environment-driven proxy normalization, exactly as
    # the container entrypoint does, rather than trusting headers in the app.
    config = uvicorn.Config(app, log_config=None, lifespan="off")
    config.load()
    yield config.loaded_app
    limiter.clear()


@pytest.mark.asyncio
async def test_docker_ingress_users_do_not_share_authentication_limit(proxy_app):
    transport = httpx.ASGITransport(app=proxy_app, client=("172.29.0.10", 45000))
    async with httpx.AsyncClient(transport=transport, base_url="http://backend") as client:
        assert (await client.get("/api/auth/login", headers={"X-Forwarded-For": "198.51.100.1"})).status_code == 200
        assert (await client.get("/api/auth/login", headers={"X-Forwarded-For": "198.51.100.2"})).status_code == 200
        assert (await client.get("/api/auth/login", headers={"X-Forwarded-For": "198.51.100.1"})).status_code == 429


@pytest.mark.asyncio
async def test_direct_backend_clients_cannot_spoof_forwarded_ip_to_evade_limits(proxy_app):
    transport = httpx.ASGITransport(app=proxy_app, client=("198.51.100.5", 45000))
    async with httpx.AsyncClient(transport=transport, base_url="http://backend") as client:
        assert (await client.get("/api/auth/login", headers={"X-Forwarded-For": "203.0.113.1"})).status_code == 200
        assert (await client.get("/api/auth/login", headers={"X-Forwarded-For": "203.0.113.2"})).status_code == 429
