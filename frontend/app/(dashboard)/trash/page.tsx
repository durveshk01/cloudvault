"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Trash2,
  RotateCcw,
  AlertTriangle,
  FileText,
  Folder,
} from "lucide-react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { BulkActionsToolbar } from "@/components/files/BulkActionsToolbar";
import { LoadError } from "@/components/ui/LoadError";
import { api } from "@/lib/api";
import { FileItem, FolderItem } from "@/types";
import { formatBytes, formatDate } from "@/lib/utils";
import { useToast } from "@/lib/toast-context";

export default function TrashPage() {
  const [items, setItems] = useState<FileItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasLoadError, setHasLoadError] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [page, setPage] = useState(1);
  const [folderPage, setFolderPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [folderTotalPages, setFolderTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [folderTotal, setFolderTotal] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const mutation = useRef(false);
  const loadGeneration = useRef(0);
  const toast = useToast();

  const loadTrash = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setIsLoading(true);
    setHasLoadError(false);
    try {
      const [files, deletedFolders] = await Promise.all([api.getTrashItems(page), api.getTrashedFolders(folderPage)]);
      if (generation !== loadGeneration.current) return;
      setItems(files.items); setFolders(deletedFolders.items);
      setTotal(files.total); setFolderTotal(deletedFolders.total);
      setTotalPages(files.total_pages); setFolderTotalPages(deletedFolders.total_pages);
      setSelectedIds((previous) => previous.filter((id) => files.items.some((item) => item.id === id)));
      if (page > files.total_pages) setPage(files.total_pages);
      if (folderPage > deletedFolders.total_pages) setFolderPage(deletedFolders.total_pages);
    } catch { if (generation === loadGeneration.current) setHasLoadError(true); }
    finally { if (generation === loadGeneration.current) setIsLoading(false); }
  }, [page, folderPage]);

  useEffect(() => {
    void loadTrash();
    const refresh = () => { void loadTrash(); };
    window.addEventListener("refresh_files", refresh);
    return () => { loadGeneration.current += 1; window.removeEventListener("refresh_files", refresh); };
  }, [loadTrash]);

  const run = async (id: string, operation: () => Promise<unknown>, message: string) => {
    if (mutation.current) return;
    mutation.current = true; setBusy(id);
    try {
      const result = await operation();
      toast.success(result && typeof result === "object" && "message" in result ? String(result.message) : message);
      await loadTrash();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Trash could not be updated."); }
    finally { mutation.current = false; setBusy(null); }
  };

  const handleRestore = async (id: string) => {
    await run(id, () => api.restoreTrashItem(id), "File restored");
  };

  const handlePermanentDelete = async (id: string, name: string) => {
    if (confirm(`Permanently delete "${name}"? This file and all historical versions will be permanently purged.`)) {
      await run(id, () => api.permanentlyDeleteItem(id), "File permanently deleted");
    }
  };

  const handleEmptyTrash = async () => {
    if (confirm("Are you sure you want to permanently empty the trash? All deleted items will be purged immediately.")) {
      setSelectedIds([]);
      await run("empty", () => api.emptyTrash(), "Trash emptied");
    }
  };

  const handleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
    );
  };

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-foreground">Trash & Recovery</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Items in trash can be restored back to your vault or permanently purged.
            </p>
          </div>

          {total + folderTotal > 0 && (
            <button
              onClick={handleEmptyTrash}
              disabled={!!busy || isLoading}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl text-xs font-semibold flex items-center gap-1.5 shadow-sm transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Empty Trash
            </button>
          )}
        </div>

        {/* Warning Banner */}
        <div className="p-3.5 rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50/50 dark:bg-amber-950/20 flex items-center gap-3 text-xs text-amber-800 dark:text-amber-300">
          <AlertTriangle className="w-4 h-4 shrink-0 text-amber-600" />
          <span>
            Items in the trash still count towards your storage quota until permanently deleted.
          </span>
        </div>

        {/* Table of Trashed Items */}
        {isLoading ? (
          <div role="status" className="py-16 text-center text-xs text-muted-foreground flex flex-col items-center gap-2">
            <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
            Loading trash items...
          </div>
        ) : hasLoadError ? (
          <LoadError onRetry={loadTrash} isRetrying={isLoading} />
        ) : items.length === 0 ? (
          <div className="py-10 text-center border-2 border-dashed border-border rounded-2xl bg-card">
            <Trash2 className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
            <p className="font-semibold text-sm text-foreground">{folders.length ? "No individual files in trash" : "Trash is empty"}</p>
            <p className="text-xs text-muted-foreground mt-1">
              {folders.length ? "Restore a folder below to recover its contents." : "Deleted files and folders will appear here before being permanently removed."}
            </p>
          </div>
        ) : (
          <div className="border border-border rounded-xl bg-card shadow-sm overflow-x-auto">
            <table className="w-full min-w-[620px] border-collapse text-xs">
              <thead>
                <tr className="border-b border-border bg-accent/20 text-muted-foreground text-[11px] uppercase font-semibold text-left">
                  <th className="py-3 px-3 w-8">
                    <input
                      type="checkbox"
                      aria-label="Select all files in trash"
                      checked={selectedIds.length === items.length && items.length > 0}
                      onChange={() => {
                        if (selectedIds.length === items.length) setSelectedIds([]);
                        else setSelectedIds(items.map((i) => i.id));
                      }}
                      className="rounded border-border"
                    />
                  </th>
                  <th className="py-3 px-3">Name</th>
                  <th className="py-3 px-3">Original Size</th>
                  <th className="py-3 px-3">Deleted Date</th>
                  <th className="py-3 px-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.map((item) => (
                  <tr
                    key={item.id}
                    className={`hover:bg-accent/40 transition-colors ${
                      selectedIds.includes(item.id) ? "bg-indigo-50/30 dark:bg-indigo-950/20" : ""
                    }`}
                  >
                    <td className="py-3 px-3">
                      <input
                          type="checkbox"
                          aria-label={`Select ${item.original_filename}`}
                        checked={selectedIds.includes(item.id)}
                        onChange={() => handleSelect(item.id)}
                        className="rounded border-border"
                      />
                    </td>

                    <td className="py-3 px-3 font-medium text-foreground">
                      <div className="flex items-center gap-2">
                        <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                        <span className="truncate max-w-xs">{item.original_filename}</span>
                      </div>
                    </td>

                    <td className="py-3 px-3 text-muted-foreground font-mono">
                      {formatBytes(item.size_bytes)}
                    </td>

                    <td className="py-3 px-3 text-muted-foreground">
                      {formatDate(item.trashed_at)}
                    </td>

                    <td className="py-3 px-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => handleRestore(item.id)}
                          disabled={!!busy}
                          className="px-2.5 py-1 rounded-lg bg-secondary hover:bg-secondary/80 text-foreground font-medium flex items-center gap-1 text-[11px]"
                          title="Restore"
                        >
                          <RotateCcw className="w-3 h-3 text-indigo-500" />
                          Restore
                        </button>
                        <button
                          onClick={() => handlePermanentDelete(item.id, item.original_filename)}
                          disabled={!!busy}
                          className="px-2.5 py-1 rounded-lg bg-red-50 dark:bg-red-950/40 hover:bg-red-100 text-red-600 font-medium flex items-center gap-1 text-[11px]"
                          title="Delete Permanently"
                        >
                          <Trash2 className="w-3 h-3" />
                          Purge
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {totalPages > 1 && <div className="flex items-center justify-between text-xs"><span>Files page {page} of {totalPages}</span><div className="flex gap-2"><button disabled={page <= 1 || isLoading} onClick={() => { setSelectedIds([]); setPage((value) => value - 1); }} className="px-3 py-2 border border-border rounded-lg">Previous files</button><button disabled={page >= totalPages || isLoading} onClick={() => { setSelectedIds([]); setPage((value) => value + 1); }} className="px-3 py-2 border border-border rounded-lg">Next files</button></div></div>}
        {!isLoading && !hasLoadError && folders.length > 0 && <section aria-labelledby="trashed-folders-title" className="space-y-3"><h2 id="trashed-folders-title" className="font-semibold text-sm">Deleted folders ({folderTotal})</h2><p className="text-xs text-muted-foreground">Restoring a folder recovers items deleted with it. Separately deleted items remain in trash.</p><div className="grid grid-cols-1 lg:grid-cols-2 gap-3">{folders.map((folder) => <div key={folder.id} className="border border-border bg-card rounded-xl p-4 text-xs flex flex-col sm:flex-row gap-3 sm:items-center justify-between"><div className="min-w-0"><p className="font-semibold flex items-center gap-2"><Folder className="w-4 h-4 text-amber-600 shrink-0" /><span className="truncate">{folder.name}</span></p><p className="mt-1 text-muted-foreground">Deleted {formatDate(folder.trashed_at)}</p></div><div className="flex gap-2 shrink-0"><button disabled={!!busy} onClick={() => run(folder.id, () => api.restoreFolder(folder.id), "Folder restored")} aria-label={`Restore folder ${folder.name}`} className="px-3 py-2 rounded-lg bg-secondary inline-flex items-center gap-1"><RotateCcw className="w-3.5 h-3.5" />Restore</button><button disabled={!!busy} onClick={() => { if (confirm(`Permanently delete folder \"${folder.name}\" and all its contents? This cannot be undone.`)) void run(folder.id, () => api.permanentlyDeleteFolder(folder.id), "Folder permanently deleted"); }} aria-label={`Permanently delete folder ${folder.name}`} className="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 inline-flex items-center gap-1"><Trash2 className="w-3.5 h-3.5" />Purge</button></div></div>)}</div></section>}
        {folderTotalPages > 1 && <div className="flex items-center justify-between text-xs"><span>Folders page {folderPage} of {folderTotalPages}</span><div className="flex gap-2"><button disabled={folderPage <= 1 || isLoading} onClick={() => setFolderPage((value) => value - 1)} className="px-3 py-2 border border-border rounded-lg">Previous folders</button><button disabled={folderPage >= folderTotalPages || isLoading} onClick={() => setFolderPage((value) => value + 1)} className="px-3 py-2 border border-border rounded-lg">Next folders</button></div></div>}
      </div>

      <BulkActionsToolbar
        selectedIds={selectedIds}
        onClearSelection={() => setSelectedIds([])}
        onSelectionChange={setSelectedIds}
        onRefresh={loadTrash}
        isTrashPage
      />
    </DashboardLayout>
  );
}
