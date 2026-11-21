/** Validate bytes before handing a document to the browser's download/PDF UI. */
export interface FileIntegrity {
  size?: number;
  checksum?: string | null;
  filename?: string;
  mime?: string | null;
}

function readLegacyBlob(blob: Blob, method: "readAsText" | "readAsArrayBuffer"): Promise<string | ArrayBuffer | null> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("The file could not be read."));
    reader.onabort = () => reject(new DOMException("The file read was cancelled.", "AbortError"));
    reader[method](blob);
  });
}

export async function readBlobText(blob: Blob): Promise<string> {
  if (typeof blob.text === "function") return blob.text();
  // Android WebView 74 supports FileReader but predates Blob.text().
  const result = await readLegacyBlob(blob, "readAsText");
  if (typeof result !== "string") throw new Error("The file could not be read as text.");
  return result;
}

export async function readBlobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  const result = await readLegacyBlob(blob, "readAsArrayBuffer");
  if (!(result instanceof ArrayBuffer)) throw new Error("The file could not be read for verification.");
  return result;
}

export async function validateFileBlob(blob: Blob, expected: FileIntegrity = {}): Promise<Blob> {
  if (!blob.size || (expected.size !== undefined && blob.size !== expected.size)) {
    throw new Error("The file is incomplete or corrupted. Please upload the original again, or ask its owner to do so.");
  }
  if (expected.checksum) {
    if (!/^[a-f0-9]{64}$/i.test(expected.checksum)) throw new Error("The file integrity information is invalid. Please try again.");
    if (!globalThis.crypto?.subtle) throw new Error("A secure HTTPS connection is required to verify this download.");
    const digest = await crypto.subtle.digest("SHA-256", await readBlobArrayBuffer(blob));
    const checksum = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (checksum !== expected.checksum.toLowerCase()) {
      throw new Error("File integrity verification failed. No file was saved. Please upload the original again, or ask its owner to do so.");
    }
  }
  if (expected.mime === "application/pdf" || blob.type.split(";")[0] === "application/pdf" || expected.filename?.toLowerCase().endsWith(".pdf")) {
    if (!(await readBlobText(blob.slice(0, 1024))).includes("%PDF-")) {
      throw new Error("This document does not contain valid PDF data. Please upload the original PDF again.");
    }
  }
  return blob;
}

export async function readFileResponse(response: Response, expected: FileIntegrity = {}): Promise<Blob> {
  // Binary endpoints use octet-stream even for JSON uploads. A JSON/HTML
  // response here is an API/proxy error, not a document to save as .pdf.
  const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (mime === "application/json" || mime === "text/html") {
    throw new Error("The server returned a page or API response instead of file content. Please try again.");
  }
  const size = response.headers.get("X-File-Size");
  let blob: Blob;
  try { blob = await response.blob(); }
  catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new Error("The download was interrupted. No file was saved. Check your connection and try again.");
  }
  return validateFileBlob(blob, {
    ...expected,
    size: expected.size ?? (size !== null && /^\d+$/.test(size) ? Number(size) : undefined),
    checksum: expected.checksum ?? response.headers.get("X-Content-SHA256"),
  });
}

export function saveBrowserBlob(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename.replace(/[\\/\x00-\x1f\x7f]/g, "_").trim() || "download";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give browsers time to accept the transfer before releasing its source.
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}
