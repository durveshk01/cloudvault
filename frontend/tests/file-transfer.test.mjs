import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

// Test the real dependency-free transfer utility without a second build/bundler.
const source = readFileSync(new URL("../lib/file-transfer.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
const { readFileResponse, validateFileBlob, saveBrowserBlob } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
const pdf = Buffer.from("%PDF-1.4\nDocument bytes\n%%EOF\n");
const checksum = createHash("sha256").update(pdf).digest("hex");

test("valid PDF bytes survive verification unchanged", async () => {
  const response = new Response(pdf, { headers: { "Content-Type": "application/octet-stream", "X-File-Size": String(pdf.length), "X-Content-SHA256": checksum } });
  const blob = await readFileResponse(response, { filename: "résumé.pdf" });
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), pdf);
});

test("empty and truncated downloads are rejected", async () => {
  await assert.rejects(validateFileBlob(new Blob([])), /incomplete or corrupted/);
  await assert.rejects(validateFileBlob(new Blob([pdf]), { size: pdf.length + 1 }), /incomplete or corrupted/);
});

test("same-length corrupted downloads fail checksum verification", async () => {
  await assert.rejects(validateFileBlob(new Blob([Buffer.alloc(pdf.length)]), { checksum }), /integrity verification failed/);
});

test("placeholder text cannot be saved as a PDF", async () => {
  await assert.rejects(validateFileBlob(new Blob(["Sample file content"]), { filename: "report.pdf" }), /valid PDF/);
});

test("successful JSON or proxy HTML responses are not saved as documents", async () => {
  for (const mime of ["application/json", "text/html"]) {
    await assert.rejects(readFileResponse(new Response("not file bytes", { headers: { "Content-Type": mime } })), /instead of file content/);
  }
});

test("metadata size is used instead of compressed Content-Length", async () => {
  const blob = await readFileResponse(new Response(pdf, { headers: { "Content-Length": "10", "X-File-Size": String(pdf.length), "X-Content-SHA256": checksum } }));
  assert.equal(blob.size, pdf.length);
});

test("interrupted response is an actionable error, not a saved file", async () => {
  await assert.rejects(readFileResponse({ headers: new Headers(), blob: () => Promise.reject(new TypeError("terminated")) }), /interrupted.*No file was saved/);
});

test("aborted previews keep their AbortError", async () => {
  await assert.rejects(readFileResponse({ headers: new Headers(), blob: () => Promise.reject(new DOMException("cancelled", "AbortError")) }), { name: "AbortError" });
});

test("download preserves Unicode filename and delays URL cleanup", () => {
  const link = { click() { this.clicked = true; }, remove() { this.removed = true; } };
  const originals = { document: globalThis.document, window: globalThis.window, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  let timer;
  let revoked = false;
  globalThis.document = { createElement: () => link, body: { appendChild() {} } };
  globalThis.window = { setTimeout(callback, duration) { timer = { callback, duration }; } };
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => { revoked = true; };
  try {
    saveBrowserBlob(new Blob([pdf]), "résumé.pdf");
    assert.equal(link.download, "résumé.pdf");
    assert.equal(link.href, "blob:test");
    assert.equal(link.clicked, true);
    assert.equal(link.removed, true);
    assert.equal(revoked, false);
    assert.equal(timer.duration, 60000);
    timer.callback();
    assert.equal(revoked, true);
  } finally {
    globalThis.document = originals.document;
    globalThis.window = originals.window;
    URL.createObjectURL = originals.create;
    URL.revokeObjectURL = originals.revoke;
  }
});
