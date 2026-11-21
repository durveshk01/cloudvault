# CloudVault Deployment & Production Guide

## 1. Quick Start with Docker Compose

The fastest way to spin up the entire production-grade stack (PostgreSQL, MinIO, FastAPI Backend, Next.js Frontend) is with Docker Compose.

### 1.1 Prerequisites
- Docker Engine 24+
- Docker Compose v2+

Compose builds MinIO Community from its pinned official source commit because
the upstream community container image is no longer distributed. The first
build downloads the Go toolchain and modules; later builds reuse Docker's cache.
Existing MinIO volumes remain compatible and retain their historical UID.

### 1.2 Start Services

```bash
# Clone and enter directory
cd cloudvault

# Copy environment variables
cp .env.example .env

# Build and start all containers in detached mode
docker compose up -d --build
```

### 1.3 Verify Deployment

- **Frontend**: Navigate to `http://localhost:3000`
- **Backend API**: Navigate to `http://localhost:8000/health`
- **Swagger Docs**: Navigate to `http://localhost:8000/docs`
- **MinIO Console**: Navigate to `http://localhost:9001` (user: `cloudvault_minio`, pass: `minio_secure_pass_123`)

From the repository root, run the read-only deployment checks with Node 22+:

```bash
node scripts/check-deployment.mjs --frontend http://localhost:3000 --backend http://localhost:8000
```

Without arguments, the checker uses the documented Render URLs. It checks the
frontend login page, direct backend health/database readiness, both frontend
health proxies, and the unauthenticated API response. It exits with an error if
any probe fails. These checks do not verify bucket permissions or a complete
authenticated upload/download; test those separately with an isolated account.

Render's blueprint now pins Node 22 and uses `/health/ready` for backend health.
Publish the source and redeploy to apply these configuration changes to an
existing service. The bundled Inter font removes the build's Google Fonts fetch.

### 1.4 Client identity and proxy timeouts

Port 3000 is now the NGINX gateway, not a directly exposed Next.js container.
It sends `/api/` and `/health` to the backend and other routes to Next.js. It
replaces incoming `X-Forwarded-For` with the connecting address. The backend
trusts only the gateway's fixed private address, `172.29.0.10`; its diagnostic
port 8000 binds to host loopback. This keeps unrelated clients out of one shared
authentication rate-limit bucket without trusting arbitrary public headers.

If `172.29.0.0/24` conflicts with a host network, change the Compose subnet,
gateway address, and backend `FORWARDED_ALLOW_IPS` together. Do not use `*` or
trust an entire shared Docker network. Keep the frontend off public ports.
When adding another external load balancer, explicitly configure its verified
addresses and header replacement at the ingress; never accept a client's
claimed address merely because it arrived in a forwarded header.

Downloads do not send successful headers until storage verification completes.
Next.js and the gateway allow 300 seconds of upstream inactivity instead of
Next's default 30 seconds. Any additional production edge must allow an
equivalent timeout. This is a bounded timeout, not unlimited transfer time.

---

## 2. Local Manual Development Setup

If running without Docker:

### 2.1 Backend Setup

```bash
cd backend

# Create and activate Python virtual environment
python -m venv venv
# On Windows:
.\venv\Scripts\Activate.ps1
# On macOS/Linux:
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run database migrations
alembic upgrade head

# Seed initial demo account (demo@cloudvault.com / DemoPassword123!)
python app/scripts/seed.py

# Run FastAPI server with auto-reload
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### 2.2 Frontend Setup

```bash
cd frontend

# Install Node dependencies
npm install

# Start Next.js development server
npm run dev
```

The frontend will run on `http://localhost:3000` and automatically proxy API calls to `http://localhost:8000`.

---

## 3. Production Hardening Checklist

When preparing CloudVault for a public internet deployment:

1. **Database**: Point `DATABASE_URL` to a managed PostgreSQL cluster (AWS RDS, Supabase, Neon, or Cloud SQL).
2. **Secrets**: Generate a cryptographically strong 64-character hex `APP_SECRET`:
   ```bash
   python -c "import secrets; print(secrets.token_hex(32))"
   ```
3. **Storage Engine**: Switch `STORAGE_BACKEND=s3` and configure a private AWS S3, Cloudflare R2, or Supabase Storage bucket.
4. **HTTPS / TLS**: Terminate TLS at a reverse proxy (e.g., Caddy, Nginx, or AWS ALB) and ensure `secure=True` on HttpOnly cookies.
5. **CORS Origins**: Set `CORS_ORIGINS` to the exact public domain (e.g. `https://vault.example.com`).

## 4. Render configuration and document recovery

The blueprint now requires durable S3-compatible storage. Configure the backend:

```dotenv
ENVIRONMENT=production
COOKIE_SECURE=true
FRONTEND_URL=https://cloudvault-frontend-tnwe.onrender.com
BACKEND_URL=https://cloudvault-backend-wg5r.onrender.com
CORS_ORIGINS=https://cloudvault-frontend-tnwe.onrender.com
STORAGE_BACKEND=s3
S3_BUCKET=<existing-private-bucket>
S3_ENDPOINT_URL=https://<s3-compatible-endpoint>
S3_REGION=<bucket-region-or-auto-for-R2>
S3_ACCESS_KEY_ID=<bucket-access-key>
S3_SECRET_ACCESS_KEY=<bucket-secret>
```

Use the normal regional S3 endpoint for AWS, or your account endpoint for R2.
Keep `S3_CREATE_BUCKET=false`: production credentials should access an existing
private bucket, not create public infrastructure. Never commit the actual keys.
Do not enable demo seeding in production unless explicitly desired; it also
requires `DEMO_PASSWORD`.

The frontend must build with `NEXT_PUBLIC_API_URL` empty and
`INTERNAL_BACKEND_URL` set to the backend HTTPS origin. Requests then use the
same-origin Next.js proxy, avoiding cross-site cookie restrictions. Rebuild the
frontend after changing these build-time settings.

Client-IP forwarding also needs a verified ingress configuration in production.
The Docker gateway implements this explicitly. For Render or another hosting
proxy, obtain the actual trusted proxy addresses and ensure the public edge
replaces untrusted forwarding headers before trusting them in Uvicorn. Next.js
rewrites alone are not a trusted client-IP boundary. Do not set
`FORWARDED_ALLOW_IPS=*` on a publicly accessible backend. This production
network configuration has not been provisioned or verified locally.

Existing Render services do not automatically change merely because the local
blueprint was edited. Apply these settings in Render and redeploy both services.
Durable storage requires a private bucket and server credentials.

### Current free Supabase storage

The approved `cloudvault-storage` project in `durveshk01's Org` uses the Free
plan. Its private `cloudvault-files` bucket is connected only to the Render
backend; CloudVault authentication and its existing database stay on Render.

```dotenv
S3_BUCKET=cloudvault-files
S3_ENDPOINT_URL=https://cbwnwlbnldbbambwomwu.storage.supabase.co/storage/v1/s3
S3_REGION=us-west-1
S3_CREATE_BUCKET=false
MAX_FILE_SIZE_MB=50
```

The generated S3 access key and secret live in Render environment variables.
Supabase S3 keys bypass bucket RLS, so keep them server-side and use this
dedicated project only for CloudVault storage. The bucket remains private;
downloads and public shares pass through CloudVault's authorization checks.
The Free plan limits individual files to 50 MB and has finite storage/transfer
quotas. No paid plan was enabled. Check the Supabase usage dashboard before
increasing application quotas; inactive free projects may pause.

**Before switching storage**, back up any surviving local objects and copy them
to the new bucket under their unchanged `storage_key` paths. Otherwise existing
metadata will refer to objects missing from the new bucket.

### Why an earlier PDF can still be broken

The old seed script recreated missing uploads using `Sample file content for ...`
text, even when the filename ended in `.pdf`. Free Render instances using
`/tmp/storage_data` lose originals on replacement/restart. The repaired seed
script never fabricates user content. Downloads/previews return an actionable
404 for missing objects or 409 for invalid/corrupted objects instead of saving a
fake PDF. Valid responses carry size and SHA-256 integrity headers; browser
downloads verify them before saving.

All private downloads now stream the exact verified content, including S3 and
legacy `direct=false` requests. The API no longer returns a mutable presigned
download URL that could point to unchecked bytes. PDF checks detect missing
headers/placeholders; they are not a full structural PDF parser or malware scan.

Original bytes cannot be recovered from a checksum. Restore a genuine object
backup, or use **Version History → Upload New Version** to re-upload the original
document. Do not "repair" the database checksum to match placeholder text.
