from pathlib import Path
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    APP_NAME: str = "CloudVault"
    APP_SECRET: str = "change-me-in-production-use-a-long-random-string"
    ENVIRONMENT: Literal["development", "test", "production"] = "development"
    DEBUG: bool = False
    COOKIE_SECURE: bool = False
    COOKIE_SAMESITE: Literal["lax", "strict", "none"] = "lax"
    SEED_DEMO: bool = False
    DEMO_PASSWORD: str | None = None

    DATABASE_URL: str = "sqlite:///./cloudvault.db"

    FRONTEND_URL: str = "http://localhost:3000"
    BACKEND_URL: str = "http://localhost:8000"

    ACCESS_TOKEN_EXPIRE_MINUTES: int = Field(30, ge=1, le=1440)
    REFRESH_TOKEN_EXPIRE_DAYS: int = Field(7, ge=1, le=90)

    STORAGE_BACKEND: Literal["local", "s3"] = "local"
    LOCAL_STORAGE_PATH: str = "./storage_data"

    S3_ENDPOINT_URL: str | None = None
    S3_BUCKET: str = "cloudvault"
    S3_REGION: str = "us-east-1"
    S3_ACCESS_KEY_ID: str | None = None
    S3_SECRET_ACCESS_KEY: str | None = None
    S3_CREATE_BUCKET: bool = False

    MAX_FILE_SIZE_MB: int = Field(100, ge=1, le=1024)
    DEFAULT_STORAGE_QUOTA_BYTES: int = Field(1073741824, gt=0)  # 1 GB
    DB_POOL_SIZE: int = Field(5, ge=1, le=50)
    DB_MAX_OVERFLOW: int = Field(5, ge=0, le=50)

    TRASH_RETENTION_DAYS: int = 30

    RATE_LIMIT_AUTH: str = "10/minute"
    RATE_LIMIT_UPLOAD: str = "30/minute"
    RATE_LIMIT_DEFAULT: str = "120/minute"
    RATE_LIMIT_ENABLED: bool = True

    CORS_ORIGINS: str = "http://localhost:3000,http://127.0.0.1:3000,https://localhost"

    model_config = {
        "env_file": (str(Path(__file__).resolve().parents[3] / ".env"), ".env"),
        "case_sensitive": True,
        "extra": "ignore",
    }

    @model_validator(mode="after")
    def validate_production(self):
        if self.COOKIE_SAMESITE == "none" and not self.COOKIE_SECURE:
            raise ValueError("SameSite=None cookies require COOKIE_SECURE=true")
        if "*" in self.cors_origin_list:
            raise ValueError("CORS_ORIGINS must contain explicit origins")
        if self.ENVIRONMENT == "production":
            if len(self.APP_SECRET) < 32 or self.APP_SECRET.startswith(("change", "cloudvault_local")):
                raise ValueError("Production requires a randomly generated APP_SECRET of at least 32 characters")
            if self.DEBUG or not self.COOKIE_SECURE:
                raise ValueError("Production requires DEBUG=false and COOKIE_SECURE=true")
            if not self.FRONTEND_URL.startswith("https://") or not self.BACKEND_URL.startswith("https://"):
                raise ValueError("Production frontend and backend URLs must use HTTPS")
            if self.STORAGE_BACKEND == "local" and self.LOCAL_STORAGE_PATH.startswith("/tmp"):
                raise ValueError("Production local storage requires a persistent disk, not /tmp")
            if self.SEED_DEMO and not self.DEMO_PASSWORD:
                raise ValueError("Production demo seeding requires DEMO_PASSWORD")
        return self

    @property
    def max_file_size_bytes(self) -> int:
        return self.MAX_FILE_SIZE_MB * 1024 * 1024

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]


settings = Settings()
