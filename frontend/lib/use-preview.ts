"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { FileItem } from "@/types";

export interface Preview {
  url: string | null;
  mime: string;
  text: string | null;
  loading: boolean;
  error: string | null;
}

export function usePreview(file: FileItem | null, enabled: boolean): Preview {
  const [preview, setPreview] = useState<Preview>({ url: null, mime: "", text: null, loading: false, error: null });
  const id = file?.id;
  const version = file?.current_version;
  const size = file?.size_bytes || 0;
  useEffect(() => {
    if (!enabled || !id) { setPreview({ url: null, mime: "", text: null, loading: false, error: null }); return; }
    if (size > 12 * 1024 * 1024) {
      setPreview({ url: null, mime: "", text: null, loading: false, error: "For files over 12 MB, download and open a local copy." });
      return;
    }
    let current = true;
    let url: string | null = null;
    const controller = new AbortController();
    setPreview({ url: null, mime: "", text: null, loading: true, error: null });
    void api.getPreviewBlob(id, controller.signal).then(async (blob) => {
      const mime = blob.type.split(";")[0];
      const text = mime.startsWith("text/") || mime.includes("json") || mime.includes("javascript")
        ? await blob.slice(0, 1024 * 1024).text() + (blob.size > 1024 * 1024 ? "\n\n[Preview truncated — download the full file.]" : "") : null;
      if (!current) return;
      url = URL.createObjectURL(blob);
      setPreview({ url, mime, text, loading: false, error: null });
    }).catch((error) => {
      if (current && error.name !== "AbortError") setPreview({ url: null, mime: "", text: null, loading: false, error: error.message || "Preview unavailable. Download the file instead." });
    });
    return () => { current = false; controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [enabled, id, version, size]);
  return preview;
}
