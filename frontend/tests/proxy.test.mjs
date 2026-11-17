import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { proxyRequest } from "next/dist/server/lib/router-utils/proxy-request.js";
import nextConfig from "../next.config.mjs";

async function listen(server, t) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("API rewrite permits verified downloads that take longer than 30 seconds", { timeout: 45_000 }, async (t) => {
  const bytes = Buffer.from("%PDF-1.4\nCloudVault verified upstream\n%%EOF\n");
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const timers = new Set();
  t.after(() => timers.forEach(clearTimeout));
  const upstream = await listen(createServer((_req, res) => {
    // A backend must finish reading and verifying its object before headers.
    const timer = setTimeout(() => {
      timers.delete(timer);
      res.writeHead(200, { "Content-Type": "application/pdf", "X-File-Size": String(bytes.length), "X-Content-SHA256": checksum });
      res.end(bytes);
    }, 31_000);
    timers.add(timer);
  }), t);
  const previous = process.env.INTERNAL_BACKEND_URL;
  process.env.INTERNAL_BACKEND_URL = upstream;
  t.after(() => {
    if (previous === undefined) delete process.env.INTERNAL_BACKEND_URL;
    else process.env.INTERNAL_BACKEND_URL = previous;
  });
  const route = (await nextConfig.rewrites()).find(({ source }) => source === "/api/:path*");
  const proxy = await listen(createServer((req, res) => {
    const destination = new URL(route.destination.replace(":path*", req.url.replace(/^\/api\//, "")));
    const parsed = { protocol: destination.protocol, hostname: destination.hostname, port: destination.port,
      pathname: destination.pathname, query: Object.fromEntries(destination.searchParams) };
    proxyRequest(req, res, parsed, undefined, undefined, nextConfig.experimental?.proxyTimeout).catch(() => {});
  }), t);
  const response = await fetch(`${proxy}/api/files/test/download`, { signal: AbortSignal.timeout(40_000) });
  assert.equal(response.status, 200, "A valid upstream download must not hit Next's 30-second default proxy timeout");
  assert.equal(response.headers.get("x-content-sha256"), checksum);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});
