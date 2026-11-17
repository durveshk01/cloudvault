"use client";

import { Download, Upload, X, RotateCcw } from "lucide-react";
import { nativeVault } from "@/lib/native";
import { useRuntime } from "@/lib/runtime-context";
import { useToast } from "@/lib/toast-context";
import { formatBytes } from "@/lib/utils";
import { useRef, useState } from "react";

export function TransferList({ kind }: { kind?: "upload" | "download" }) {
  const { transfers, refreshTransfers, connected, device } = useRuntime();
  const toast = useToast();
  const busyIds = useRef(new Set<string>());
  const [busy, setBusy] = useState<string[]>([]);
  const items = transfers.filter((transfer) => !kind || transfer.kind === kind);
  const action = async (id: string, retry: boolean) => {
    if (busyIds.current.has(id)) return;
    busyIds.current.add(id); setBusy(Array.from(busyIds.current));
    try {
      if (retry) await nativeVault.retryTransfer({ id }); else await nativeVault.cancelTransfer({ id });
      await refreshTransfers();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Transfer could not be updated."); }
    finally { busyIds.current.delete(id); setBusy(Array.from(busyIds.current)); }
  };
  if (!items.length) return <p className="p-4 text-xs text-muted-foreground">No transfers yet.</p>;
  return <div className="space-y-2">{items.map((transfer) => {
    const running = ["RUNNING", "ENQUEUED", "BLOCKED"].includes(transfer.state);
    const percent = transfer.total_bytes ? Math.min(100, Math.round(transfer.completed_bytes * 100 / transfer.total_bytes)) : 0;
    const status = transfer.state === "SUCCEEDED" ? (device ? "Saved to device vault" : transfer.kind === "upload" ? "Uploaded" : "Saved offline") : transfer.state === "FAILED" ? transfer.error || "Failed — retry available"
      : transfer.state === "CANCELLED" ? "Cancelled" : transfer.state === "RUNNING" ? (percent === 100 ? "Verifying and finalizing…" : `Transferring ${percent}%`)
      : device || connected ? "Queued — resumes automatically" : "Waiting for connection";
    return <div key={transfer.id} className="p-3 rounded-xl border border-border bg-card text-xs space-y-2">
      <div className="flex items-center justify-between gap-2"><span className="font-semibold min-w-0 truncate flex items-center gap-2">{transfer.kind === "upload" ? <Upload className="w-4 h-4 shrink-0" /> : <Download className="w-4 h-4 shrink-0" />}{transfer.name}</span><span className="shrink-0 text-muted-foreground">{formatBytes(transfer.total_bytes)}</span></div>
      <div role="progressbar" aria-label={`${transfer.name} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1.5 bg-muted rounded-full overflow-hidden"><div className="h-full bg-indigo-600 transition-[width]" style={{ width: `${percent}%` }} /></div>
      <div className="flex items-center justify-between gap-2"><span className={transfer.state === "FAILED" ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}>{status}</span>
        {running ? <button disabled={busy.includes(transfer.id)} aria-label={`Cancel ${transfer.name}`} onClick={() => action(transfer.id, false)} className="p-2 hover:bg-accent rounded-lg disabled:opacity-50"><X className="w-4 h-4" /></button>
          : transfer.state === "FAILED" || transfer.state === "CANCELLED" ? <button disabled={busy.includes(transfer.id)} onClick={() => action(transfer.id, true)} className="p-2 text-indigo-600 rounded-lg hover:bg-accent inline-flex items-center gap-1 disabled:opacity-50"><RotateCcw className="w-3.5 h-3.5" />Retry</button> : null}
      </div>
    </div>;
  })}</div>;
}
