"use client";

import Image from "next/image";
import { FileText } from "lucide-react";
import { isDeviceVault, isNative } from "@/lib/native";
import type { Preview } from "@/lib/use-preview";

export function PreviewContent({ preview, filename }: { preview: Preview; filename: string }) {
  if (preview.loading) return <p role="status" className="p-6 text-sm text-muted-foreground">Loading secure preview…</p>;
  if (preview.error) return <p role="alert" className="p-6 text-sm text-muted-foreground">{preview.error}</p>;
  if (preview.text !== null) return <pre className="w-full h-full overflow-auto whitespace-pre-wrap break-words p-4 text-xs font-mono text-foreground">{preview.text}</pre>;
  if (preview.url && /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(preview.mime)) {
    return <Image src={preview.url} unoptimized width={1000} height={800} alt={filename} className="max-h-full max-w-full w-auto h-auto object-contain rounded-lg" />;
  }
  if (preview.url && preview.mime === "application/pdf" && !isNative()) {
    return <iframe src={preview.url} sandbox="allow-same-origin" title={filename} className="w-full h-full min-h-80 rounded-lg border border-border bg-white" />;
  }
  if (preview.url && preview.mime.startsWith("audio/")) return <audio controls src={preview.url} className="max-w-full" />;
  if (preview.url && preview.mime.startsWith("video/")) return <video controls src={preview.url} className="max-h-full max-w-full" />;
  return <div className="p-8 text-center text-sm text-muted-foreground"><FileText className="w-12 h-12 mx-auto mb-3" />
    {isDeviceVault() ? "Use Open in Device files & transfers to view this file with an installed app, or Download to save a copy." : isNative() && preview.mime === "application/pdf" ? "Save an offline copy, then open it with your PDF app from Offline & transfers." : "No safe inline preview for this format. Download the file to open it locally."}
  </div>;
}
