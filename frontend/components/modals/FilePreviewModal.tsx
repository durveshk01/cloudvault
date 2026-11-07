"use client";

import React, { useEffect, useState } from "react";
import { X, Download, FileText, Image as ImageIcon, Eye, ExternalLink, ShieldCheck } from "lucide-react";
import { FileItem } from "@/types";
import { api } from "@/lib/api";
import { formatBytes, formatDate, getFileCategory } from "@/lib/utils";

interface FilePreviewModalProps {
  file: FileItem | null;
  isOpen: boolean;
  onClose: () => void;
}

export function FilePreviewModal({ file, isOpen, onClose }: FilePreviewModalProps) {
  const [textContent, setTextContent] = useState<string | null>(null);
  const [isLoadingText, setIsLoadingText] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    if (!file || !isOpen) {
      setTextContent(null);
      setDownloadError(null);
      return;
    }

    let isCurrent = true;
    const cat = getFileCategory(file.original_filename, file.mime_type);
    if (cat === "document" || cat === "code") {
      const ext = file.original_filename.split(".").pop()?.toLowerCase();
      if (ext !== "pdf" && ext !== "doc" && ext !== "docx" && ext !== "xls" && ext !== "xlsx" && ext !== "ppt" && ext !== "pptx") {
        setIsLoadingText(true);
        const headers: HeadersInit = {};
        const token = api.getToken();
        if (token) headers["Authorization"] = `Bearer ${token}`;
        fetch(api.getFilePreviewUrl(file.id), { credentials: "include", headers })
          .then((response) => {
            if (!response.ok) throw new Error("Preview request failed");
            return response.text();
          })
          .then((txt) => {
            if (isCurrent) setTextContent(txt);
          })
          .catch(() => {
            if (isCurrent) setTextContent("Unable to load preview. Please try downloading the file.");
          })
          .finally(() => {
            if (isCurrent) setIsLoadingText(false);
          });
      }
    }
    return () => {
      isCurrent = false;
    };
  }, [file, isOpen]);

  if (!isOpen || !file) return null;

  const category = getFileCategory(file.original_filename, file.mime_type);
  const isImage = category === "image";
  const isPdf = file.mime_type === "application/pdf" || file.original_filename.endsWith(".pdf");
  const isText = textContent !== null || isLoadingText;

  const previewUrl = api.getFilePreviewUrl(file.id);
  const handleDownload = async () => {
    setDownloadError(null);
    try {
      await api.downloadFile(file.id, file.original_filename);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : "The file could not be downloaded.");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/60 backdrop-blur-md animate-in fade-in">
      <div role="dialog" aria-modal="true" aria-labelledby="file-preview-title" className="bg-card border border-border w-full max-w-4xl h-[90dvh] sm:h-[85vh] rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-border flex items-center justify-between bg-card shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2 rounded-lg bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 shrink-0">
              {isImage ? <ImageIcon className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
            </div>
            <div className="min-w-0">
              <h3 id="file-preview-title" className="font-semibold text-sm text-foreground truncate">
                {file.original_filename}
              </h3>
              <p className="text-xs text-muted-foreground">
                {formatBytes(file.size_bytes)} • Version {file.current_version} • Modified {formatDate(file.updated_at || file.created_at)}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleDownload}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-sm transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Download</span>
            </button>
            <button
              onClick={onClose}
              aria-label="Close file preview"
              className="p-1.5 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content Viewer Body */}
        <div className="flex-1 bg-accent/20 overflow-auto flex items-center justify-center p-4 relative">
          {downloadError && (
            <div role="alert" className="absolute top-3 left-3 right-3 z-10 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/80 dark:text-red-300">
              {downloadError}
            </div>
          )}
          {isImage ? (
            <div className="max-w-full max-h-full flex items-center justify-center">
              <img
                src={previewUrl}
                alt={file.original_filename}
                className="max-h-[70vh] max-w-full rounded-lg object-contain shadow-md"
              />
            </div>
          ) : isPdf ? (
            <iframe
              src={previewUrl}
              className="w-full h-full rounded-lg border border-border bg-white"
              title={file.original_filename}
            />
          ) : isText ? (
            <div className="w-full h-full bg-card rounded-lg border border-border p-4 overflow-auto font-mono text-xs text-foreground">
              {isLoadingText ? (
                <div className="flex items-center justify-center h-full">
                  <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : (
                <pre className="whitespace-pre-wrap font-mono leading-relaxed">{textContent}</pre>
              )}
            </div>
          ) : (
            /* Fallback for unsupported formats */
            <div className="flex flex-col items-center justify-center text-center max-w-md p-6 bg-card rounded-2xl border border-border shadow-sm">
              <div className="w-16 h-16 rounded-2xl bg-indigo-50 dark:bg-indigo-950 flex items-center justify-center text-indigo-600 dark:text-indigo-400 mb-4">
                <FileText className="w-8 h-8" />
              </div>
              <h4 className="font-semibold text-base text-foreground mb-1">
                No inline preview available
              </h4>
              <p className="text-xs text-muted-foreground mb-4">
                This file type ({file.mime_type || "binary"}) cannot be safely displayed in the browser. You can download the file to inspect it locally.
              </p>
              <button
                type="button"
                onClick={handleDownload}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-sm transition-colors"
              >
                <Download className="w-4 h-4" />
                Download {file.original_filename} ({formatBytes(file.size_bytes)})
              </button>
            </div>
          )}
        </div>

        {/* Footer info bar */}
        <div className="px-4 py-2.5 border-t border-border bg-card flex items-center justify-between text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
            Isolated Sandbox Preview
          </span>
          <span className="font-mono">{file.checksum ? `SHA256: ${file.checksum.substring(0, 16)}...` : ""}</span>
        </div>
      </div>
    </div>
  );
}
