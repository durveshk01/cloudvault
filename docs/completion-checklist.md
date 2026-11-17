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
- [ ] Run full backend/frontend checks and refresh Android assets/build if toolchain is available.
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
