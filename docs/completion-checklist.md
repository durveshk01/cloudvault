# Completion checklist

Scope: finish and verify the existing application, prioritizing failed document
downloads. Preserve all pre-existing local changes. Do not deploy/provision or
modify real user data during verification. The user subsequently authorized
committing and pushing all updated source to the existing GitHub repository.

- [x] Trace download/preview bytes from browser through API and storage.
- [x] Identify unsafe seed recovery and temporary production storage.
- [x] Stop fabrication of missing user uploads; restore only checksum-matching demo bytes.
- [x] Verify file size and SHA-256 before direct/private/public downloads and previews.
- [x] Reject placeholder PDF data and API/HTML responses before browser saving.
- [x] Add automated download-integrity and demo-restart regression coverage.
- [x] Repair CI dependency/runtime configuration and Docker packaging/API proxy.
- [x] Replace temporary Render storage configuration with durable object storage requirements.
- [ ] Verify browser upload, PDF preview, and byte-exact download end to end.
- [x] Run full backend/frontend checks and refresh Android assets/build if toolchain is available.
- [x] Document deployment and lost-file recovery requirements, plus remaining external blockers.

## Verification record

- Backend: `python -m pytest -q` — 85 passed after all review fixes. One upstream Starlette/AnyIO deprecation warning.
- Backend lint: `python -m ruff check app tests migrations` — passed.
- Frontend tests: `npm run test:unit` — 10 passed, including a real 31-second upstream response through Next's installed rewrite proxy.
- Frontend lint: `npm run lint` — passed.
- Fresh source-only frontend typecheck: `npm run typecheck` — passed without
  reusing generated `.next` output.
- Compose configuration: `docker compose config --quiet` — passed. A container
  build/run remains unverified because Docker Desktop's daemon is not running.
- Android export, signed APK rebuild, fresh web build, and browser checks are
  pending. Android export and web build/tests must run sequentially because
  Next.js uses `.next` internally for both.
- Dependency audits: `npm audit --omit=dev` and
  `python -m pip_audit -r requirements.txt --progress-spinner off` — no known
  vulnerabilities found. Windows blocked the `pip-audit` executable wrapper;
  its supported Python module invocation succeeded without policy changes.

## Final review follow-up

- S3 integrity bypass: the regression failed for default/`direct=false`
  downloads, then all 9 real-provider/stubbed-remote cases passed after removing
  the presigned response branch. Exact verified bytes are always served.
- Delivery cleanup: header-send failure, body-send failure, and cancellation
  all failed spool-closure assertions, then passed after response-level cleanup.
- Proxy timeout: a 31-second upstream response returned 500 before the change,
  then returned byte-exact PDF content with a bounded 300-second proxy timeout.
- Docker identity: the second distinct forwarded client hit 429 before explicit
  trusted ingress configuration. Both identity regressions now pass, including
  rejection of spoofed headers from a direct backend client. The new NGINX
  gateway replaces forwarding headers; full Docker runtime remains externally
  blocked, not claimed as verified.
- Final fix-pass suite: backend 85/85, frontend 10/10, Ruff/ESLint and resolved
  Compose configuration passed. No second reviewer was dispatched.

### Deferred minor findings

- Browser APIs remain mocked and preview assertions prove blob bytes, not actual
  PDF rendering or a live backend/browser round trip.
- Render's Node major is not pinned; local and CI checks use the tested Node 22+
  toolchain, but Render's chosen major requires deployment verification.

### Review rulings

- Ruling: retain basic PDF-header checks rather than add a full PDF parser —
  this repair prevents placeholder/corrupt transfers — a structurally malformed
  original with a PDF header can still be delivered.
- Ruling: do not expand the final review to unrelated pre-existing auth/upload/
  versioning implementation — preserve user work and this repair's scope —
  unrelated defects may remain outside the exercised tests.
- Ruling: treat live Render/S3, Docker runtime, and signed Android execution as
  separate verification requirements — unavailable infrastructure is not test
  evidence — deployment/device behavior stays unproven until those checks run.
- Ruling: recover originals only from genuine bytes — metadata is insufficient
  and fabrication caused this failure — files without originals/backups remain
  unrecoverable.

## External requirements

- Re-upload the original lost document or restore a genuine backup. No checksum
  or placeholder text can reconstruct the missing original bytes.
- Supply an existing private S3-compatible bucket and credentials, preserve any
  surviving objects under their original storage keys, and redeploy both Render
  services. Local configuration edits do not update the live services.
- GitHub source publication is authorized. It excludes ignored secrets,
  databases, APKs, and generated bundles. A source push does not configure
  durable storage or prove that existing Render services have been updated;
  repository-connected CI/deployment automation may run after the push.

The screenshot alone does not prove which server file was downloaded. The code
does prove that previous seed recovery could replace a PDF with plain text. Lost
original uploads cannot be reconstructed from metadata/checksums; re-uploading
the original or restoring an actual backup is required.

## Resumed verification — 2026-11-17

Resume baseline: `b663c2c`; working tree was clean. This pass continues the
unchecked local verification tasks, not deployment or source publication.

- [x] Recover the prior checklist and identify installed toolchains.
- [x] Run backend tests and lint with the project's Python environment.
- [x] Run frontend lint.
- [x] Refresh the Android static export and verify a signed local APK.
- [x] Rebuild the web frontend, then run unit tests, typecheck, and browser tests.
- [x] Verify real local backend/browser upload, preview blob bytes, and exact download on the model-derived schema.
- [ ] Verify the PDF actually renders its page in the browser; confirm the migrated-schema setup after a separate repair.
- [x] Record evidence and remaining blockers.

Initial findings: default `python` resolves to Anaconda without FastAPI;
`py -3.12` has FastAPI installed. Default Ruff 0.15.1 reports BLE001 in
`backend/app/services/upload_service.py:105`. Frontend ESLint passed.

Ruling: continue verification in the existing checkout without a new worktree —
no implementation changes are planned and installed frontend/Android dependencies
are already available here — verification modifies generated build output and
this checklist, but does not isolate those artifacts from other local activity.

Ruling: use a separate temporary SQLite database and storage directory for live
browser checks — preserve existing accounts/uploads and avoid remote services —
this proves local behavior, not Render/S3 deployment behavior.

Fresh results:

- Prior audit virtualenv: backend `python -m pytest -q` — 85 passed, one upstream
  Starlette/httpx deprecation warning; `python -m ruff check app tests migrations`
  — passed with Ruff 0.17.5. Python 3.12's global environment instead failed eight
  async cases because it lacks pytest-asyncio; no source changes were needed.
- Frontend `npm run build:android` — static export and Capacitor sync passed;
  a nonfatal webpack cache rename warning occurred.
- Frontend `npm run build`, `npm run typecheck`, `npm run test:unit`, and
  `npm run test:e2e` — passed (10 unit tests, 3 mocked-API Chromium tests).
- `scripts/android-release.py --skip-frontend` with existing Java 21, Gradle
  9.3.1, SDK, and release key — release lint/build, signing verification, and
  byte-for-byte bundled asset checks passed. APK:
  `artifacts/CloudVault-v1.1.0.apk`; SHA-256:
  `67d5855588dfb64de2f1bb18b633421e1cce4f3865a39f7f08e48ddb6a47e3bf`.
  Gradle initially reused the unit-test task; the subsequent
  `:app:testDebugUnitTest --rerun-tasks` executed successfully. XML reports show
  13 tests, zero failures/errors/skips.
- Fresh migrated SQLite browser setup: migrations reached head, but registration
  returned HTTP 500 with `sqlite3.OperationalError: unknown function: now()`.
  `001_initial_schema.py` contains nine literal `server_default=sa.text('now()')`
  declarations. Models use `func.now()` and tests create tables from model
  metadata, explaining why the automated suite missed the migrated-schema bug.

Ruling: leave the newly discovered migration defect unchanged in this verification
pass — the prior scope excludes unrelated auth/schema implementation — a fresh
migrated SQLite installation remains unusable until a separate repair.

Ruling: continue the download browser check using a second temporary database
created from the same model metadata as the backend test suite — isolate the
download behavior from the demonstrated migration blocker without hiding it —
successful downloads on that schema do not verify the documented Alembic setup.

Final local browser evidence:

- On the model-derived database, registration/login and drag-and-drop upload
  succeeded through the production-built Next.js server and real FastAPI API.
- The original fixture, preview blob, preview-dialog download, and file-action
  direct download were all 598 bytes with matching SHA-256:
  `88008ee7e78181ff13ba6e8c203885d118ef905d1ebfa1ce176596771ff53030`.
  Both saved downloads were compared byte-for-byte with the original fixture.
- Direct download returned HTTP 200 and matching `X-File-Size` and
  `X-Content-SHA256` headers, including correct decoding of a gzip response.
- Actual inline PDF page rendering remains unresolved: the iframe used the
  verified PDF blob but its child frame was `chrome-error://chromewebdata/`.
  A screenshot could not be captured because the desktop window was not visible.
  This is not evidence that the document page rendered. The cause of the iframe
  rendering failure has not been diagnosed; no sandbox/security settings changed.
- Final APK checksum matches `artifacts/android-release.json` and the checksum
  sidecar. Only this checklist remains changed in Git; Capacitor's incidental
  XML whitespace change was removed. `git diff --check` passed.

Local test instance remains at `http://127.0.0.1:3101` with API on port 8100.
It uses only the temporary model-derived verification database/storage under
`C:\Users\Durvesh Kale\AppData\Local\Temp\opencode\cloudvault-resume-rjx55muz`.
Fixture and final verification JSON are retained there. No production source,
real user data, signing secrets, remote configuration, commits, or pushes changed.

Remaining: repair/test migration-based SQLite installation; diagnose inline PDF
rendering; verify deployment/object storage, Docker runtime, and Android execution
separately. Existing upstream deprecation warnings remain deferred.
