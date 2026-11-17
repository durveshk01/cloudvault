"use client";

import { useEffect, useRef, useState } from "react";
import { Camera as CameraIcon, Upload, X, CheckCircle, AlertCircle, File as FileIcon, RefreshCw } from "lucide-react";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { api } from "@/lib/api";
import { formatBytes } from "@/lib/utils";
import { useToast } from "@/lib/toast-context";
import { useDialog } from "@/lib/use-dialog";
import { useRuntime } from "@/lib/runtime-context";
import { nativeVault, StagedFile } from "@/lib/native";
import { TransferList } from "@/components/files/TransferList";

interface UploadModalProps { isOpen: boolean; onClose: () => void; folderId?: string | null; versionFileId?: string; onUploadComplete?: () => void; }
interface UploadTask {
  id: string; file: File; folderId: string | null; versionFileId?: string; progress: number;
  status: "pending" | "uploading" | "success" | "error" | "cancelled";
  errorMessage?: string;
}

export function UploadModal({ isOpen, onClose, folderId, versionFileId, onUploadComplete }: UploadModalProps) {
  const toast = useToast();
  const toastRef = useRef(toast); toastRef.current = toast;
  const complete = useRef(onUploadComplete); complete.current = onUploadComplete;
  const { native, device, refreshTransfers } = useRuntime();
  const dialog = useDialog(isOpen, onClose);
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [picking, setPicking] = useState(false);
  const [cameraAvailable, setCameraAvailable] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  const queue = useRef<UploadTask[]>([]);
  const running = useRef(new Map<string, AbortController>());
  const alive = useRef(true);
  const pumpRef = useRef<() => void>(() => undefined);

  const update = (id: string, changes: Partial<UploadTask>) => {
    if (alive.current) setTasks((current) => current.map((task) => task.id === id ? { ...task, ...changes } : task));
  };
  pumpRef.current = () => {
    while (alive.current && running.current.size < 2 && queue.current.length) {
      const task = queue.current.shift()!;
      const controller = new AbortController();
      running.current.set(task.id, controller);
      update(task.id, { status: "uploading", progress: 0, errorMessage: undefined });
      const options = { requestId: task.id, signal: controller.signal, onProgress: (progress: number) => update(task.id, { progress }) };
      const upload = task.versionFileId ? api.uploadNewVersion(task.versionFileId, task.file, options) : api.uploadFile(task.file, task.folderId, options);
      void upload
        .then(() => {
          update(task.id, { status: "success", progress: 100 });
          if (alive.current) { toastRef.current.success(`Uploaded ${task.file.name}`); complete.current?.(); window.dispatchEvent(new Event("refresh_files")); }
        }).catch((error) => {
          if (error.name === "AbortError") update(task.id, { status: "cancelled", errorMessage: "Cancelled. You can retry this file." });
          else { update(task.id, { status: "error", errorMessage: error.message || "Upload failed." }); if (alive.current) toastRef.current.error(error.message || "Upload failed."); }
        }).finally(() => { running.current.delete(task.id); pumpRef.current(); });
    }
  };

  useEffect(() => {
    alive.current = true;
    const active = running.current;
    return () => { alive.current = false; queue.current = []; active.forEach((controller) => controller.abort()); };
  }, []);
  useEffect(() => {
    if (!native || !isOpen) return;
    void nativeVault.stagedFiles().then((result) => setStaged(result.files)).catch(() => undefined);
    void nativeVault.capabilities().then((result) => setCameraAvailable(result.camera)).catch(() => setCameraAvailable(false));
    void refreshTransfers();
  }, [native, isOpen, refreshTransfers]);

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const selected = Array.from(files);
    if (versionFileId && selected.length !== 1) { toast.error("Choose one file for a new version."); return; }
    if (selected.length > 20) { toast.error("Choose up to 20 files at a time."); return; }
    const valid = selected.filter((file) => {
      if (!file.size || file.size > 100 * 1024 * 1024) { toast.error(`${file.name}: choose a nonempty file up to 100 MB.`); return false; }
      return true;
    });
    const newTasks: UploadTask[] = valid.map((file) => ({ id: crypto.randomUUID(), file, folderId: folderId || null, versionFileId, progress: 0, status: "pending" }));
    setTasks((current) => [...current, ...newTasks]);
    queue.current.push(...newTasks);
    pumpRef.current();
  };
  const enqueue = async (files: StagedFile[]) => {
    for (const file of files) {
      await nativeVault.enqueueUpload({ stagingId: file.id, folder_id: file.folder_id, version_file_id: file.version_file_id || undefined });
      setStaged((current) => current.filter((saved) => saved.id !== file.id));
    }
    await refreshTransfers();
  };
  const choose = async () => {
    if (!native) { input.current?.click(); return; }
    setPicking(true);
    try { await enqueue((await nativeVault.pickFiles({ folder_id: folderId, version_file_id: versionFileId, multiple: !versionFileId })).files); }
    catch (error) { toast.error(error instanceof Error ? error.message : "The file picker could not complete. Try again."); }
    finally { setPicking(false); }
  };
  const capture = async () => {
    setPicking(true);
    try {
      await nativeVault.prepareCamera({ folder_id: folderId, version_file_id: versionFileId });
      const photo = await Camera.getPhoto({ source: CameraSource.Camera, resultType: CameraResultType.Uri, quality: 85, width: 2048, correctOrientation: true });
      if (!photo.path) throw new Error("Photo could not be read. Use Choose files instead.");
      await enqueue((await nativeVault.stageCamera({ path: photo.path })).files);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Camera unavailable or permission denied. Use Choose files instead.";
      if (!/cancel/i.test(message)) toast.error(message);
    } finally { setPicking(false); }
  };
  const cancel = (id: string) => {
    queue.current = queue.current.filter((task) => task.id !== id);
    running.current.get(id)?.abort();
    update(id, { status: "cancelled", errorMessage: "Cancelled. You can retry this file." });
  };
  const retry = (task: UploadTask) => {
    if (running.current.has(task.id) || queue.current.some((queued) => queued.id === task.id)) return;
    update(task.id, { status: "pending", progress: 0, errorMessage: undefined });
    queue.current.push(task); pumpRef.current();
  };
  if (!isOpen) return null;

  return <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/50 backdrop-blur-sm">
    <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="upload-title" className="bg-card border border-border w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] max-h-[90dvh]">
      <header className="p-4 border-b border-border flex items-center justify-between"><h2 id="upload-title" className="font-semibold text-sm inline-flex items-center gap-2"><Upload className="w-4 h-4" />{device ? versionFileId ? "Import new version" : "Import files" : versionFileId ? "Upload new version" : "Upload files"}</h2><button onClick={onClose} aria-label="Close upload dialog" className="p-2 rounded-lg hover:bg-accent"><X className="w-4 h-4" /></button></header>
      <div className="p-4 sm:p-6 overflow-auto space-y-4">
        <input type="file" multiple={!versionFileId} ref={input} aria-label="Choose files to upload" onChange={(event) => { addFiles(event.target.files); event.target.value = ""; }} className="hidden" />
        <button type="button" disabled={picking} onClick={choose} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); if (!native) addFiles(event.dataTransfer.files); }}
          className={`w-full border-2 border-dashed rounded-xl p-6 flex flex-col items-center gap-2 text-center disabled:opacity-50 ${dragging ? "border-indigo-600 bg-indigo-50 dark:bg-indigo-950" : "border-border hover:bg-accent/40"}`}>
          <Upload className="w-8 h-8 text-indigo-600" /><span className="text-sm font-semibold">{picking ? "Preparing encrypted files…" : native ? "Choose files" : "Choose files or drag them here"}</span><span className="text-xs text-muted-foreground">{versionFileId ? "One file per version" : "Up to 20 files at a time"} · 100 MB per file</span>
        </button>
        {native && <div className="space-y-2"><button type="button" disabled={picking || !cameraAvailable} onClick={capture} className="w-full flex items-center justify-center gap-2 py-3 text-sm rounded-xl border border-border hover:bg-accent disabled:opacity-50"><CameraIcon className="w-4 h-4" />Take photo</button><p className="text-xs text-muted-foreground">{device ? "Photos and selected files are imported into encrypted private storage on your phone. No server or internet connection is needed." : cameraAvailable ? "Photos and selected files are encrypted on this device before upload. Android continues queued jobs after app restarts." : "A camera is unavailable. Choose files to upload an existing photo or document."}</p></div>}
        {!native && <p className="text-xs text-muted-foreground">Two uploads run at a time. This dialog can close while uploads continue; keep this page open. Retry uses the same upload key.</p>}
        {staged.length > 0 && <section className="border border-border p-3 rounded-xl space-y-2"><h3 className="text-xs font-semibold">Recovered files ready to upload</h3>{staged.map((file) => <p key={file.id} className="text-xs truncate">{file.name} · {formatBytes(file.size)}</p>)}<button disabled={picking} onClick={async () => { setPicking(true); try { await enqueue(staged); } catch (error) { toast.error(error instanceof Error ? error.message : "Could not queue saved files."); } finally { setPicking(false); } }} className="text-xs font-semibold text-indigo-600 py-2">Queue recovered files</button></section>}
        {native ? <TransferList kind="upload" /> : <div className="space-y-2">{tasks.map((task) => <div key={task.id} className="p-3 rounded-xl border border-border space-y-2">
          <div className="flex items-center justify-between gap-2 text-xs"><span className="font-medium truncate flex items-center gap-1.5"><FileIcon className="w-3.5 h-3.5 shrink-0" />{task.file.name}</span><span className="text-muted-foreground shrink-0">{formatBytes(task.file.size)}</span></div>
          <div role="progressbar" aria-label={`${task.file.name} upload progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={task.progress} className="h-1.5 bg-muted rounded-full overflow-hidden"><div className={`h-full transition-[width] ${task.status === "success" ? "bg-emerald-600" : "bg-indigo-600"}`} style={{ width: `${task.progress}%` }} /></div>
          <div className="flex items-center justify-between gap-2 text-xs">
            {task.status === "success" ? <span className="text-emerald-700 dark:text-emerald-400 flex items-center gap-1"><CheckCircle className="w-3 h-3" />Uploaded</span> : task.status === "error" || task.status === "cancelled" ? <span className="text-red-600 dark:text-red-400 flex items-start gap-1"><AlertCircle className="w-3 h-3 shrink-0" />{task.errorMessage}</span> : <span className="text-muted-foreground">{task.status === "pending" ? "Queued" : task.progress === 100 ? "Saving metadata…" : `Uploading ${task.progress}%`}</span>}
            {task.status === "pending" || task.status === "uploading" ? <button onClick={() => cancel(task.id)} aria-label={`Cancel ${task.file.name}`} className="p-2 rounded-lg hover:bg-accent"><X className="w-3.5 h-3.5" /></button> : task.status !== "success" ? <button onClick={() => retry(task)} className="flex items-center gap-1 py-2 text-indigo-600"><RefreshCw className="w-3 h-3" />Retry</button> : null}
          </div>
        </div>)}</div>}
      </div>
      <footer className="p-4 border-t border-border flex justify-between gap-2">
        {!native && <button onClick={() => setTasks((current) => current.filter((task) => task.status !== "success" && task.status !== "cancelled"))} className="text-xs text-muted-foreground px-2 py-2">Clear finished</button>}
        <button onClick={onClose} className="ml-auto px-4 py-2 text-xs font-semibold rounded-lg bg-secondary hover:bg-accent">Done</button>
      </footer>
    </div>
  </div>;
}
