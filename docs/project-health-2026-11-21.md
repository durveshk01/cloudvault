# Project health audit — 2026-11-21

Reviewed the backend, frontend, migrations, Android project, deployment files,
build scripts, and automated checks. Existing uncommitted regression tests and
the earlier audit log were preserved. The follow-up verification used the
configured Python 3.12 and Node 22 runtimes, real Docker services, native Android
builds, and the live Render application.

## Confirmed issues repaired

- Added migration `003_sqlite_defaults` for fresh and existing SQLite databases.
  The released initial revision used unsupported `now()` timestamp defaults and
  text boolean defaults. The new migration uses `CURRENT_TIMESTAMP`, fixes
  boolean defaults, and converts legacy `true`/`false` strings to numeric flags.
  Tests preserve accounts, folders, files, versions, sharing, tags, activities,
  notifications, sessions, and staged uploads, including relationships and the
  unique version constraint. PostgreSQL skips the SQLite repair.
- Public downloads rejected after another request claims the final download
  slot now close the verified spool and return the intended HTTP 410. Previously
  cleanup called a nonexistent background task and raised a `TypeError`.
- Tag assignments now preserve unchanged associations, deduplicate selections,
  and reject unavailable tags before modifying existing tags. Repeated
  assignments previously hit a unique-constraint error; invalid IDs silently
  cleared previous tags. Whitespace-only names now receive HTTP 422.
- Removed the HTML sandbox from verified PDF blob iframes so Chromium's built-in
  isolated PDF viewer can run. A browser regression reproduced
  `chrome-error://chromewebdata/` before the repair. The final page rendered the
  fixture text visibly; preview and downloaded bytes matched the original.
- Bundled the existing Inter Latin variable font with its OFL license and used
  `next/font/local`. A clean Android frontend export previously failed while
  fetching Google Fonts; the export succeeded after this change.
- Added Docker ignore files so host dependencies, generated bundles, secrets,
  and local databases/storage are excluded from build contexts. This prevents
  the frontend builder's `COPY . .` from overwriting Linux dependencies with
  host `node_modules`.
- Added `/health/ready` forwarding to Next.js and NGINX, selected database
  readiness as Render's backend health check, and pinned Render Node to 22.
- Fixed backend Ruff's cleanup-logging finding and Alembic's path separator
  warning. Browser tests now use full Chromium with its PDF viewer and start the
  standalone server directly.
- Added FileReader fallbacks for Android WebViews without `Blob.text()` and
  `Blob.arrayBuffer()`. Text previews and integrity verification now work on the
  API 29 WebView. Browser regressions cover both current and legacy Blob APIs.
- Replaced the removed MinIO Community container image with a build from its
  immutable official source commit. Preserved the historical UID so existing
  MinIO data volumes remain writable.
- Made Android export checks wait for completed bytes and recognize the native
  share chooser by its actual filename. Camera permission checks recognize
  Android's foreground-only permission control. The UI checker handles both
  AOSP/Google document pickers and API 29/API 35 share chooser packages, and
  allows sufficient logcat output to retain diagnostics.
- Fixed live upload HTTP 500: Render logs showed missing S3 credentials. Created
  the approved free `cloudvault-storage` Supabase project and private
  `cloudvault-files` bucket, then saved the generated S3 credentials only in
  Render's backend environment. Set the application's upload limit to 50 MB.
  Existing Render authentication and database configuration were preserved.
- Release follow-up: the Android resource shrinker removed `xml/config`, which
  Cordova resolves dynamically by name. Retained that resource with a shrinker
  keep rule and added a release-package check. The check rejected the previous
  APK and passed after rebuilding with the retained configuration.

## Fresh verification

- Backend: **92 tests passed on Python 3.12.10**, including real
  Alembic-created schema/API tests; Ruff, clean dependency installation, and
  `pip check` passed. `pip-audit` reported no known vulnerabilities.
- Frontend: production build, ESLint, TypeScript, **10 unit tests**, and **3
  full-Chromium browser tests** passed in the initial audit. The final Node
  **22.23.5** run passed **4 browser tests**, including legacy Blob coverage.
  Clean `npm ci` and `npm audit` reported no known vulnerabilities.
- Android frontend: static export, route checks, ECMAScript compatibility
  checks, and Capacitor sync passed after bundling the local font. The web build
  was rebuilt after the Android export because the builds share Next internals.
- Configuration: four YAML files, seven Android XML files, and three package/
  deployment JSON files parsed successfully. Git whitespace checks passed.
- Local deployment checker: **6/6 probes passed** against the production-built
  frontend and real backend on ports 3125 and 8125. Verified login-page delivery,
  direct/backend readiness, frontend health/readiness proxies, and HTTP 401 for
  an unauthenticated API request.
- Real browser round trip on an isolated migrated SQLite database: registration,
  login, PDF upload, visible PDF page rendering, and download succeeded with no
  browser JavaScript errors. Original, preview blob, and saved download were
  byte-identical: 598 bytes, SHA-256
  `88008ee7e78181ff13ba6e8c203885d118ef905d1ebfa1ce176596771ff53030`.
- Docker: built and ran isolated PostgreSQL 16, source-built MinIO, Python
  **3.12.16** backend, Node **22.23.5** frontend, and NGINX containers. Deployment
  checker passed **6/6**. Private S3 upload/preview/download, password-protected
  public download, and single-download limit passed. After restarting MinIO and
  the backend, the same object downloaded with unchanged bytes.
- Android: **13 unit tests**, debug build/lint, **17 instrumentation tests**, and
  signed release build/verification passed. Bundled assets match the frontend
  export exactly. APK SHA-256:
  `f75f785fd7ba16c5ab392f8ee3508c7895c3155f46fcad76ad10f91b2747e92f`.
- Native UI: **13/13 checks passed on API 35**, with zero JavaScript exceptions:
  offline startup, registration/login, folders, document import, text preview,
  byte-exact export, immutable versions, rollback, native sharing, camera/photo
  import, trash recovery, process-death persistence, and offline account unlock.
- Live Render: authenticated private upload, preview/download, password-protected
  public download, and download-limit enforcement passed through the frontend
  proxy using Supabase S3. The 602-byte PDF matched SHA-256
  `5a9c131fadb710c03710f3ed0e08ee767698856a7c68e0f9e14ca033d978f183`.
  Supabase confirms the bucket is private; its security advisor found no issues.
- Live S3 multipart transfer: a **9,437,184-byte** binary uploaded and downloaded
  unchanged with SHA-256
  `3b42e2fe559e11b3765d607de108396c65065b6e59645ef388289ad7c1b3f766`.
  A one-minute client test timeout was insufficient for this transfer; the
  bounded five-minute retry passed without an application change. The test
  object was permanently removed afterward.
- Independent code review found no actionable regressions. No credentials,
  databases, signing keys, generated bundles, or APKs are included in the source
  changes.

## Publication checks and remaining limits

- Source fixes were pushed to `main` as
  [`5079ac5`](https://github.com/durveshk01/cloudvault/commit/5079ac5f63026fd54c806daccf2dda70c4b15a89).
  [Python 3.12 / Node 22 CI](https://github.com/durveshk01/cloudvault/actions/runs/44903114692)
  and the [Android APK workflow](https://github.com/durveshk01/cloudvault/actions/runs/44903114705)
  both passed at that commit.
- [Render backend deployment](https://dashboard.render.com/web/srv-dbh2k7d9el5s73ajir1g/deploys/dep-dc0onf15efls73ebk25g)
  and [frontend deployment](https://dashboard.render.com/web/srv-dbh2mgd9el5s73ajqn70/deploys/dep-dc0onf15efls73ebk2gg)
  succeeded at `5079ac5`. All **6/6 live deployment probes passed**, including
  `/health/ready` through the frontend. The existing live PDF remained
  byte-identical across redeployment, and public sharing/limits passed again.
- API 29 native UI checks passed registration/login, document import, text
  preview, byte-exact export, immutable versions, rollback, and Android sharing.
  The API 29 system camera crashes inside
  `Camera2OneCameraManagerImpl.findCameraId` before capture. The same CloudVault
  APK passed camera and all remaining lifecycle flows on a fresh API 35 emulator
  with a virtual-scene back camera. The API 29 system-image camera issue remains
  an emulator limitation, not an observed CloudVault exception.
- The Free Supabase plan has a 50 MB file limit and finite storage/transfer
  quotas; no paid plan was enabled. Free Render services may sleep, and inactive
  free Supabase projects may pause. These are hosting limits, not build errors.
- Upstream Starlette's test-client deprecation warning remains; all test
  assertions pass. Production deployment does not use the test client.
- Existing data and signing keys were preserved. Test accounts and objects were
  isolated from user content. Audit files, versions, and links were removed;
  Supabase confirmed zero remaining test objects. Empty audit accounts remain
  because the application has no account-deletion endpoint. The isolated
  `cloudvaultaudit` Docker stack was stopped without deleting data volumes.

For repeat verification, run `node scripts/check-deployment.mjs` from the
repository root. The checker is read-only and
returns a nonzero exit code for failed probes.

The v1.1.0 publication build uses the existing private release certificate.
The earlier published v1.0.2 used an Android debug certificate and cannot be
updated in place with this private key. Back up/export needed data before
uninstalling v1.0.2 and installing the new release; app-local data is removed
on uninstall. The local vault does not automatically import cloud files.
