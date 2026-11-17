"use client";

import React, { useRef, useState } from "react";
import { X, Trash2, Star, RotateCcw, CheckSquare } from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast-context";

interface BulkActionsToolbarProps {
  selectedIds: string[];
  onClearSelection: () => void;
  onSelectionChange?: (ids: string[]) => void;
  onRefresh: () => void;
  isTrashPage?: boolean;
}

export function BulkActionsToolbar({
  selectedIds,
  onClearSelection,
  onSelectionChange,
  onRefresh,
  isTrashPage = false,
}: BulkActionsToolbarProps) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);

  if (selectedIds.length === 0) return null;

  const run = async (action: "delete" | "permanent_delete" | "restore" | "star") => {
    if (pending.current) return;
    if (action === "delete" && !confirm(`Move ${selectedIds.length} selected files to trash?`)) return;
    if (action === "permanent_delete" && !confirm(`Permanently delete ${selectedIds.length} files? This cannot be undone.`)) return;
    pending.current = true;
    setBusy(true);
    try {
      const result = await api.bulkAction([...selectedIds], action);
      const messages = { delete: "Moved to trash", permanent_delete: "Permanently deleted", restore: "Restored", star: "Updated favorites for" };
      if (result.processed_count) toast.success(`${messages[action]} ${result.processed_count} file(s)`);
      if (result.failed.length) toast.error(`${result.failed.length} file(s) could not be processed: ${result.failed[0].message}`);
      if (onSelectionChange) onSelectionChange(result.failed.map((failure) => failure.id));
      else if (!result.failed.length) onClearSelection();
      await onRefresh();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Selected files could not be updated."); }
    finally { pending.current = false; setBusy(false); }
  };

  return (
    <div role="toolbar" aria-label="Selected file actions" aria-busy={busy} className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] md:bottom-6 left-1/2 -translate-x-1/2 z-40 w-[calc(100%-1rem)] max-w-xl bg-card border border-border shadow-2xl rounded-2xl px-3 sm:px-5 py-3 flex flex-wrap items-center justify-between gap-2 text-xs">
      <div className="flex items-center gap-2 pr-2 border-r border-border font-semibold text-foreground">
        <CheckSquare className="w-4 h-4 text-indigo-600" />
        <span role="status">{busy ? "Processing…" : `${selectedIds.length} selected`}</span>
      </div>

      <div className="flex items-center gap-2">
        {!isTrashPage ? (
          <>
            <button
              disabled={busy}
              onClick={() => run("star")}
              className="px-3 py-1.5 rounded-lg bg-secondary hover:bg-secondary/80 text-foreground font-medium flex items-center gap-1.5 transition-colors"
            >
              <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-500" />
              Star
            </button>
            <button
              disabled={busy}
              onClick={() => run("delete")}
              className="px-3 py-1.5 rounded-lg bg-red-50 dark:bg-red-950/40 hover:bg-red-100 dark:hover:bg-red-900/40 text-red-600 dark:text-red-400 font-medium flex items-center gap-1.5 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </button>
          </>
        ) : (
          <>
            <button
              disabled={busy}
              onClick={() => run("restore")}
              className="px-3 py-1.5 rounded-lg bg-secondary hover:bg-secondary/80 text-foreground font-medium flex items-center gap-1.5 transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5 text-indigo-500" />
              Restore
            </button>
            <button
              disabled={busy}
              onClick={() => run("permanent_delete")}
              className="px-3 py-1.5 rounded-lg bg-red-50 dark:bg-red-950/40 hover:bg-red-100 text-red-600 font-medium flex items-center gap-1.5 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete Permanently
            </button>
          </>
        )}
      </div>

      <button
        onClick={onClearSelection}
        disabled={busy}
        aria-label="Deselect all files"
        className="p-1 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
        title="Deselect all"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
