"use client";

import { useState } from "react";
import { X, Download, FileText, ShieldCheck } from "lucide-react";
import { FileItem } from "@/types";
import { api } from "@/lib/api";
import { formatBytes, formatDate } from "@/lib/utils";
import { useDialog } from "@/lib/use-dialog";
import { usePreview } from "@/lib/use-preview";
import { PreviewContent } from "@/components/files/PreviewContent";
import { isDeviceVault, isNative } from "@/lib/native";

interface FilePreviewModalProps { file: FileItem | null; isOpen: boolean; onClose: () => void; }

export function FilePreviewModal({ file, isOpen, onClose }: FilePreviewModalProps) {
  const preview = usePreview(file, isOpen);
  const dialog = useDialog(isOpen, onClose);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [queued, setQueued] = useState(false);
  if (!isOpen || !file) return null;

  const download = async () => {
    setDownloadError(null);
    setDownloading(true);
    try { await api.downloadFile(file.id, file.original_filename); setQueued(isNative() && !isDeviceVault()); }
    catch (error) { setDownloadError(error instanceof Error ? error.message : "Download failed. Try again."); }
    finally { setDownloading(false); }
  };

  return <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/60 backdrop-blur-md">
    <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="file-preview-title" className="bg-card border border-border w-full max-w-4xl h-[90vh] h-[90dvh] sm:h-[85vh] rounded-2xl shadow-2xl overflow-hidden flex flex-col">
      <div className="p-4 border-b border-border flex items-center justify-between gap-3 shrink-0">
        <div className="min-w-0"><h2 id="file-preview-title" className="font-semibold text-sm truncate flex items-center gap-2"><FileText className="w-4 h-4 shrink-0" />{file.original_filename}</h2>
          <p className="text-xs text-muted-foreground">{formatBytes(file.size_bytes)} · Version {file.current_version} · {formatDate(file.updated_at || file.created_at)}</p></div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={download} disabled={downloading} aria-label="Download file" className="p-2 rounded-lg bg-indigo-600 text-white disabled:opacity-50"><Download className="w-4 h-4" /></button>
          <button onClick={onClose} aria-label="Close file preview" className="p-2 rounded-lg hover:bg-accent"><X className="w-5 h-5" /></button>
        </div>
      </div>
      {downloadError && <p role="alert" className="p-3 text-xs bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300">{downloadError}</p>}
      {queued && <p role="status" className="p-3 text-xs bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">Download queued. Open Offline &amp; transfers to view progress and open the saved file.</p>}
      <div className="flex-1 min-h-0 bg-accent/20 overflow-auto flex items-center justify-center p-4"><PreviewContent preview={preview} filename={file.original_filename} /></div>
      <div className="px-4 py-2.5 border-t border-border text-[11px] text-muted-foreground flex items-center justify-between gap-2">
        <span className="flex items-center gap-1"><ShieldCheck className="w-3.5 h-3.5" />Authenticated, isolated preview</span>
        <span className="font-mono truncate">{file.checksum ? `SHA-256: ${file.checksum.slice(0, 12)}…` : ""}</span>
      </div>
    </div>
  </div>;
}
