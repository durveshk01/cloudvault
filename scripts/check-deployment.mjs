import assert from "node:assert/strict";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  frontend: { type: "string", default: "https://cloudvault-frontend-tnwe.onrender.com" },
  backend: { type: "string", default: "https://cloudvault-backend-wg5r.onrender.com" },
  timeout: { type: "string", default: "45000" },
} });
const timeout = Number(values.timeout);
assert(Number.isInteger(timeout) && timeout > 0, "--timeout must be a positive number of milliseconds");
const origins = Object.fromEntries(["frontend", "backend"].map((name) => {
  const url = new URL(values[name]);
  assert(["http:", "https:"].includes(url.protocol) && !url.username && !url.password, `${name} must be an HTTP(S) URL without credentials`);
  return [name, url.origin];
}));

// Read-only probes: no accounts, objects, or deployment settings are changed.
const probes = [
  { name: "Frontend page", origin: origins.frontend, path: "/login", html: true },
  { name: "Backend health", origin: origins.backend, path: "/health", status: "healthy" },
  { name: "Backend database readiness", origin: origins.backend, path: "/health/ready", status: "ready" },
  { name: "Frontend health proxy", origin: origins.frontend, path: "/health", status: "healthy" },
  { name: "Frontend readiness proxy", origin: origins.frontend, path: "/health/ready", status: "ready" },
  { name: "Frontend authentication proxy", origin: origins.frontend, path: "/api/auth/me", unauthorized: true },
];
const results = await Promise.allSettled(probes.map(async (probe) => {
  const response = await fetch(probe.origin + probe.path, { signal: AbortSignal.timeout(timeout), redirect: "follow" });
  assert.equal(response.status, probe.unauthorized ? 401 : 200, `unexpected HTTP ${response.status}`);
  const body = await response.text();
  if (probe.html) {
    assert.match(response.headers.get("content-type") || "", /text\/html/);
    assert.match(body, /CloudVault/);
  } else {
    assert.match(response.headers.get("content-type") || "", /application\/json/);
    const data = JSON.parse(body);
    if (probe.unauthorized) assert.equal(typeof data.detail, "string");
    else assert.equal(data.status, probe.status);
  }
  return `${probe.name}: HTTP ${response.status}`;
}));
let failed = 0;
results.forEach((result, index) => {
  if (result.status === "fulfilled") console.log(`PASS ${result.value}`);
  else {
    failed++;
    const error = result.reason;
    console.error(`FAIL ${probes[index].name}: ${error.message}${error.cause?.message ? ` (${error.cause.message})` : ""}`);
  }
});
console.log(`${probes.length - failed}/${probes.length} deployment checks passed.`);
process.exitCode = failed ? 1 : 0;
