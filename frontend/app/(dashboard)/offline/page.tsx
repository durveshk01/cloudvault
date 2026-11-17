"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, FileText, Share2, Trash2, ExternalLink, ShieldCheck } from "lucide-react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { TransferList } from "@/components/files/TransferList";
import { LoadError } from "@/components/ui/LoadError";
import { nativeVault, OfflineFile } from "@/lib/native";
import { useRuntime } from "@/lib/runtime-context";
import { useToast } from "@/lib/toast-context";
import { formatBytes } from "@/lib/utils";

export default function OfflinePage() {
  const { native, device, transfers } = useRuntime();
  const toast = useToast();
  const [files, setFiles] = useState<OfflineFile[]>([]);
  const [used, setUsed] = useState(0);
  const [quota, setQuota] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!native) { setLoading(false); return; }
    setError(false);
    try {
      const result = await nativeVault.offlineFiles();
      setFiles(result.files.sort((left, right) => right.saved_at - left.saved_at));
      setUsed(result.used_bytes); setQuota(result.quota_bytes);
    } catch { setError(true); }
    finally { setLoading(false); }
  }, [native]);
  useEffect(() => { void load(); }, [load, transfers]);

  const act = async (id: string, action: "open" | "share" | "export" | "remove") => {
    setBusy(id);
    try {
      if (action === "remove") { await nativeVault.removeOffline({ id }); await load(); }
      else if (action === "export") { if ((await nativeVault.exportOffline({ id })).saved) toast.success("Saved to the selected location."); }
      else await nativeVault.openOffline({ id, share: action === "share" });
    } catch (error) { toast.error(error instanceof Error ? error.message : "The file could not be opened."); }
    finally { setBusy(null); }
  };

  return <DashboardLayout><div className="max-w-4xl mx-auto space-y-6">
    <header><h1 className="text-xl font-bold">{device ? "Device files & transfers" : "Offline & transfers"}</h1><p className="text-xs text-muted-foreground mt-1">{device ? "Your encrypted library, Android export/sharing, and restart-safe import queue." : "Your encrypted device copies and restart-safe transfer queue."}</p></header>
    {!native ? <section className="p-6 border border-border bg-card rounded-xl space-y-3"><p className="text-sm">Encrypted offline files and background transfers are available in the Android app. Browser uploads continue while their page stays open.</p><a href="https://github.com/durveshk01/cloudvault/releases" target="_blank" rel="noopener noreferrer" className="text-sm text-indigo-600 hover:underline">Get CloudVault for Android</a></section> : <>
      <div className="rounded-xl border border-border p-4 bg-card"><p className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="w-4 h-4 text-indigo-600" />Android Keystore protected</p><p className="text-xs text-muted-foreground mt-2">{formatBytes(used)} of {formatBytes(quota)} saved on this device. {device ? "Your quota includes retained versions and Trash. Signing out locks your account and preserves its encrypted library. Use Files to organize or delete originals." : "Removing a local copy keeps the cloud file. Signing out clears device copies and staged uploads."}</p></div>
      <section className="space-y-3"><h2 className="font-semibold text-sm">Saved files</h2>
        {loading ? <p role="status" className="text-xs text-muted-foreground">Loading device files…</p> : error ? <LoadError onRetry={load} /> : !files.length ? <p className="p-6 border border-dashed border-border rounded-xl text-sm text-muted-foreground">{device ? "Choose Upload to import a file or take a photo. Imported files are available here without internet." : "Use Download on a cloud file to save an encrypted offline copy."}</p> : files.map(({ file, saved_at }) => <div key={file.id} className="p-4 rounded-xl border border-border bg-card space-y-3">
          <div className="flex gap-3 min-w-0"><FileText className="w-6 h-6 text-indigo-600 shrink-0" /><div className="min-w-0"><p className="font-semibold text-sm truncate">{file.original_filename}</p><p className="text-xs text-muted-foreground">{formatBytes(file.size_bytes)} · v{file.current_version} · Saved {new Date(saved_at).toLocaleDateString()}</p></div></div>
          <div className="flex flex-wrap gap-2">
            <button disabled={busy === file.id} onClick={() => act(file.id, "open")} className="inline-flex gap-1.5 items-center text-xs px-3 py-2 bg-indigo-600 text-white rounded-lg"><ExternalLink className="w-3.5 h-3.5" />Open</button>
            <button disabled={busy === file.id} onClick={() => act(file.id, "export")} className="inline-flex gap-1.5 items-center text-xs px-3 py-2 bg-secondary rounded-lg"><Download className="w-3.5 h-3.5" />Save to device</button>
            <button disabled={busy === file.id} onClick={() => act(file.id, "share")} className="inline-flex gap-1.5 items-center text-xs px-3 py-2 bg-secondary rounded-lg"><Share2 className="w-3.5 h-3.5" />Share</button>
            {!device && <button disabled={busy === file.id} onClick={() => act(file.id, "remove")} className="inline-flex gap-1.5 items-center text-xs px-3 py-2 text-red-600 hover:bg-accent rounded-lg"><Trash2 className="w-3.5 h-3.5" />Remove copy</button>}
          </div>
        </div>)}
      </section>
      <section className="space-y-3"><h2 className="font-semibold text-sm">Recent transfers</h2><p className="text-xs text-muted-foreground">{device ? "Imports run on your phone and resume after app restarts. Retrying an interrupted import does not duplicate files or versions." : "Queued jobs resume after reconnecting or restarting the app. Interrupted transfers restart safely without creating duplicate cloud uploads."}</p><TransferList /></section>
    </>}
  </div></DashboardLayout>;
}
