"""S3-compatible object storage provider (AWS S3, MinIO, Cloudflare R2)."""

import asyncio
from collections.abc import Generator
from typing import BinaryIO

try:
    import boto3
    from botocore.client import Config
    from botocore.exceptions import ClientError
except ImportError:
    boto3 = None
    Config = None
    ClientError = Exception

from app.core.config import settings
from app.storage.base import StorageProvider
from app.utils.file_utils import content_disposition


class S3StorageProvider(StorageProvider):
    """Storage provider for AWS S3 and S3-compatible APIs (MinIO, R2, Ceph)."""

    def __init__(self):
        if boto3 is None:
            raise RuntimeError("boto3 is required for S3 storage. Please install with: pip install boto3")
        self.bucket = settings.S3_BUCKET
        self.client = boto3.client(
            "s3",
            endpoint_url=settings.S3_ENDPOINT_URL,
            aws_access_key_id=settings.S3_ACCESS_KEY_ID,
            aws_secret_access_key=settings.S3_SECRET_ACCESS_KEY,
            region_name=settings.S3_REGION,
            config=Config(signature_version="s3v4", connect_timeout=10, read_timeout=60, retries={"max_attempts": 2}),
        )
        if settings.S3_CREATE_BUCKET:
            self._ensure_bucket()

    def _ensure_bucket(self):
        """Ensure bucket exists in local/test environments like MinIO."""
        try:
            self.client.head_bucket(Bucket=self.bucket)
        except ClientError as e:
            error_code = e.response.get("Error", {}).get("Code")
            if error_code in ("404", "NoSuchBucket"):
                args = {"Bucket": self.bucket}
                if settings.S3_REGION != "us-east-1":
                    args["CreateBucketConfiguration"] = {"LocationConstraint": settings.S3_REGION}
                self.client.create_bucket(**args)
            else:
                raise

    async def save_file(self, storage_key: str, content: bytes) -> str:
        def _upload():
            self.client.put_object(
                Bucket=self.bucket,
                Key=storage_key,
                Body=content,
            )

        await asyncio.to_thread(_upload)
        return storage_key

    async def get_file(self, storage_key: str) -> bytes:
        def _download():
            try:
                response = self.client.get_object(Bucket=self.bucket, Key=storage_key)
                with response["Body"] as body:
                    return body.read()
            except ClientError as e:
                if e.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
                    raise FileNotFoundError(f"File not found in S3: {storage_key}") from e
                raise

        return await asyncio.to_thread(_download)

    async def save_file_object(self, storage_key: str, content: BinaryIO) -> str:
        from boto3.s3.transfer import TransferConfig
        await asyncio.to_thread(
            self.client.upload_fileobj, content, self.bucket, storage_key,
            Config=TransferConfig(max_concurrency=2, multipart_chunksize=8 * 1024 * 1024),
        )
        return storage_key

    def get_file_stream(self, storage_key: str, chunk_size: int = 65536) -> Generator[bytes, None, None]:
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=storage_key)
            with response["Body"] as body:
                while chunk := body.read(chunk_size):
                    yield chunk
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
                raise FileNotFoundError(f"File not found in S3: {storage_key}") from e
            raise

    async def delete_file(self, storage_key: str) -> bool:
        def _delete():
            self.client.delete_object(Bucket=self.bucket, Key=storage_key)
            return True

        return await asyncio.to_thread(_delete)

    async def file_exists(self, storage_key: str) -> bool:
        def _check():
            try:
                self.client.head_object(Bucket=self.bucket, Key=storage_key)
                return True
            except ClientError as e:
                if e.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
                    return False
                raise

        return await asyncio.to_thread(_check)

    async def get_file_size(self, storage_key: str) -> int:
        def _size():
            try:
                response = self.client.head_object(Bucket=self.bucket, Key=storage_key)
                return response["ContentLength"]
            except ClientError as e:
                if e.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
                    raise FileNotFoundError(f"File not found in S3: {storage_key}") from e
                raise

        return await asyncio.to_thread(_size)

    def generate_presigned_upload_url(self, storage_key: str, expires_in: int = 3600) -> str | None:
        try:
            url = self.client.generate_presigned_url(
                ClientMethod="put_object",
                Params={"Bucket": self.bucket, "Key": storage_key},
                ExpiresIn=expires_in,
            )
            return url
        except ClientError:
            return None

    def generate_presigned_download_url(self, storage_key: str, filename: str, expires_in: int = 3600) -> str | None:
        try:
            url = self.client.generate_presigned_url(
                ClientMethod="get_object",
                Params={
                    "Bucket": self.bucket,
                    "Key": storage_key,
                     "ResponseContentDisposition": content_disposition(filename),
                },
                ExpiresIn=expires_in,
            )
            return url
        except ClientError:
            return None
