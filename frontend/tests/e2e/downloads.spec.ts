import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

// A real single-page PDF with a catalog, page, content stream, and xref table.
function makePdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = "BT /F1 16 Tf 30 100 Td (CloudVault verified PDF) Tj ET\n";
  objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

const bytes = makePdf();
const file = {
  id: "90000000-0000-4000-8000-000000000001", owner_id: "90000000-0000-4000-8000-000000000002",
  folder_id: null, original_filename: "résumé.pdf", storage_key: "test/report.pdf", mime_type: "application/pdf",
  size_bytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), is_trashed: false,
  trashed_at: null, is_starred: false, current_version: 1, created_at: "2026-11-17T00:00:00Z", updated_at: null, tags: [],
};
const user = { id: file.owner_id, email: "test@example.com", full_name: "Download Test", storage_quota_bytes: 1073741824, storage_used_bytes: bytes.length, is_active: true, created_at: file.created_at };

async function mockApi(page: Page, { corrupt = false, proxyJson = false, empty = false } = {}) {
  let uploaded = !empty;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (path === "/api/auth/refresh") return json({ access_token: "test-only-token", expires_in: 1800 });
    if (path === "/api/auth/me") return json(user);
    if (path === "/api/files/upload") { uploaded = true; return json(file, 201); }
    if (path === "/api/files") return json({ items: uploaded ? [file] : [], total: uploaded ? 1 : 0, page: 1, page_size: 50, total_pages: 1 });
    if (path === `/api/files/${file.id}`) return json(file);
    if (path.endsWith("/preview") || path.endsWith("/download")) {
      if (proxyJson && path.endsWith("/download")) return json({ download_url: "https://example.invalid/error.pdf" });
      const body = corrupt ? Buffer.alloc(bytes.length, 120) : bytes;
      return route.fulfill({ status: 200, contentType: path.endsWith("/preview") ? "application/pdf" : "application/octet-stream", body,
        headers: { "X-File-Size": String(bytes.length), "X-Content-SHA256": file.checksum } });
    }
    if (path === "/api/storage/usage") return json({ used_bytes: bytes.length, quota_bytes: user.storage_quota_bytes, usage_percentage: 0, file_count: 1, categories: [] });
    if (["/api/folders", "/api/notifications", "/api/tags"].includes(path)) return json([]);
    return json({ detail: `Unhandled test endpoint: ${path}` }, 404);
  });
}

for (const legacyBlob of [false, true]) {
test(`upload, preview, and Unicode-named PDF download preserve original bytes (${legacyBlob ? "legacy Blob" : "current Blob"})`, async ({ page }) => {
  if (legacyBlob) await page.addInitScript(() => {
    Object.defineProperty(Blob.prototype, "text", { value: undefined, configurable: true });
    Object.defineProperty(Blob.prototype, "arrayBuffer", { value: undefined, configurable: true });
  });
  await mockApi(page, { empty: true });
  await page.goto("/files");
  await page.getByRole("button", { name: "Upload File", exact: true }).click();
  await page.getByLabel("Choose files to upload").setInputFiles({ name: file.original_filename, mimeType: "application/pdf", buffer: bytes });
  await expect(page.getByText("Uploaded", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: file.original_filename, exact: true }).click();
  const frame = page.locator(`iframe[title="${file.original_filename}"]`);
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute("src", /^blob:/);
  const previewUrl = await frame.getAttribute("src");
  // A sandboxed PDF frame fails with chrome-error://chromewebdata/ even
  // though fetching its blob returns the correct bytes.
  await expect.poll(() => page.frames().map((child) => child.url())).toContain(previewUrl);
  const preview = await page.evaluate(async (title) => {
    const iframe = document.querySelector<HTMLIFrameElement>(`iframe[title="${title}"]`)!;
    return Array.from(new Uint8Array(await (await fetch(iframe.src)).arrayBuffer()));
  }, file.original_filename);
  expect(Buffer.from(preview)).toEqual(bytes);
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download file", exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe(file.original_filename);
  await expect(download.failure()).resolves.toBeNull();
  expect(await readFile((await download.path())!)).toEqual(bytes);
});
}

test("corrupt PDF shows an actionable error without starting a download", async ({ page }) => {
  await mockApi(page, { corrupt: true });
  const downloads: unknown[] = [];
  page.on("download", (download) => downloads.push(download));
  await page.goto("/files");
  await page.getByRole("button", { name: file.original_filename, exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "integrity verification failed" })).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.getByRole("button", { name: "Download file", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "integrity verification failed" })).toHaveCount(2);
  expect(downloads).toHaveLength(0);
});

test("presigned URL JSON cannot be accidentally saved as PDF bytes", async ({ page }) => {
  await mockApi(page, { proxyJson: true });
  const downloads: unknown[] = [];
  page.on("download", (download) => downloads.push(download));
  await page.goto("/files");
  await page.getByRole("button", { name: `Actions for ${file.original_filename}` }).click();
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.getByText("The server returned a page or API response instead of file content. Please try again.")).toBeVisible();
  expect(downloads).toHaveLength(0);
});
