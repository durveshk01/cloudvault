"use client";

import React, { useCallback, useEffect, useState, useRef } from "react";
import { History, X, RotateCcw, Upload, CheckCircle2 } from "lucide-react";
import { FileItem, FileVersion } from "@/types";
import { api } from "@/lib/api";
import { formatBytes, formatDate } from "@/lib/utils";
import { LoadError } from "@/components/ui/LoadError";
import { useDialog } from "@/lib/use-dialog";
import { UploadModal } from "@/components/modals/UploadModal";

interface VersionHistoryModalProps {
  file: FileItem | null;
  isOpen: boolean;
  onClose: () => void;
  onVersionRestored?: () => void;
}

export function VersionHistoryModal({
  file,
  isOpen,
  onClose,
  onVersionRestored,
}: VersionHistoryModalProps) {
  const [versions, setVersions] = useState<FileVersion[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [activeVersion, setActiveVersion] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const loadGeneration = useRef(0);
  const fileId = file?.id;
  const dialog = useDialog(isOpen && !!file, onClose);

  const loadVersions = useCallback(async () => {
    if (!fileId) return;
    const generation = ++loadGeneration.current;
    setIsLoading(true);
    setLoadError(false);
    try {
      const [history, metadata] = await Promise.all([api.getVersions(fileId), api.getFile(fileId)]);
      if (generation !== loadGeneration.current) return;
      setVersions(history); setActiveVersion(metadata.current_version);
    } catch { if (generation === loadGeneration.current) setLoadError(true); }
    finally { if (generation === loadGeneration.current) setIsLoading(false); }
  }, [fileId]);

  useEffect(() => {
    setUploadOpen(false);
    if (fileId && isOpen) {
      void loadVersions();
      setError(null);
    }
    const refresh = () => { if (isOpen && fileId) void loadVersions(); };
    window.addEventListener("refresh_files", refresh);
    return () => { loadGeneration.current += 1; window.removeEventListener("refresh_files", refresh); };
  }, [fileId, isOpen, loadVersions]);

  const handleRestore = async (versionId: string) => {
    if (!fileId || restoring) return;
    if (!confirm("Are you sure you want to restore this version? It will become the active file.")) {
      return;
    }

    setRestoring(versionId); setError(null);
    try {
      await api.restoreVersion(fileId, versionId);
      await loadVersions();
      if (onVersionRestored) onVersionRestored();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Failed to restore version."); }
    finally { setRestoring(null); }
  };

  return (
    <>
    {isOpen && file && <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/50 backdrop-blur-sm animate-in fade-in">
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="version-history-title" className="bg-card border border-border w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] max-h-[90dvh] sm:max-h-[85vh]">
        {/* Header */}
        <div className="p-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400">
              <History className="w-4 h-4" />
            </div>
            <div>
              <h3 id="version-history-title" className="font-semibold text-sm text-foreground">Version History</h3>
              <p className="text-xs text-muted-foreground truncate max-w-xs">
                {file.original_filename}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close version history"
            className="p-1 rounded-lg text-muted-foreground hover:bg-accent"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Upload New Version Action Banner */}
        <div className="p-4 bg-accent/20 border-b border-border flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-foreground">Upload Updated Version</p>
            <p className="text-[11px] text-muted-foreground">Preserves existing versions in history</p>
          </div>
          <div>
            <button
              onClick={() => setUploadOpen(true)}
              disabled={!!restoring}
              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors"
            >
              <Upload className="w-3.5 h-3.5" />
              Upload New Version
            </button>
          </div>
        </div>

        {error && (
          <div role="alert" className="px-4 py-2 bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 text-xs font-medium border-b border-red-200 dark:border-red-800">
            {error}
          </div>
        )}

        {/* Versions List */}
        <div className="p-4 flex-1 overflow-y-auto space-y-2.5">
          {isLoading ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              Loading version history...
            </div>
          ) : loadError ? (
            <LoadError onRetry={loadVersions} isRetrying={isLoading} />
          ) : versions.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              No previous versions recorded.
            </div>
          ) : (
            versions.map((v) => {
              const isCurrent = v.version_number === activeVersion;

              return (
                <div
                  key={v.id}
                  className={`p-3.5 rounded-xl border transition-all ${
                    isCurrent
                      ? "border-indigo-500/50 bg-indigo-50/30 dark:bg-indigo-950/20"
                      : "border-border bg-card hover:bg-accent/30"
                  } flex items-center justify-between gap-3 text-xs`}
                >
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-foreground">
                        Version {v.version_number}
                      </span>
                      {isCurrent && (
                        <span className="text-[10px] bg-indigo-100 text-indigo-700 dark:bg-indigo-900/60 dark:text-indigo-300 font-bold px-1.5 py-0.5 rounded-full flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" />
                          Current Active
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      {formatBytes(v.size_bytes)} • {formatDate(v.created_at)}
                    </p>
                    {v.checksum && (
                      <p className="text-[10px] font-mono text-muted-foreground truncate">
                        SHA: {v.checksum.substring(0, 16)}...
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {!isCurrent && (
                      <button
                         onClick={() => handleRestore(v.id)}
                         disabled={!!restoring}
                         aria-label={`Restore version ${v.version_number}`}
                        className="p-1.5 text-muted-foreground hover:text-indigo-600 rounded-lg hover:bg-accent flex items-center gap-1 text-xs font-medium"
                        title="Restore to this version"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>{restoring === v.id ? "Restoring…" : "Restore"}</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-border bg-accent/10 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-secondary hover:bg-secondary/80 text-foreground transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>}
    <UploadModal isOpen={isOpen && !!file && uploadOpen} onClose={() => setUploadOpen(false)} versionFileId={fileId} onUploadComplete={() => { void loadVersions(); onVersionRestored?.(); }} />
    </>
  );
}
