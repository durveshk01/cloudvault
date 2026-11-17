"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Folder, Home, X } from "lucide-react";
import { api } from "@/lib/api";
import { useDialog } from "@/lib/use-dialog";
import { useToast } from "@/lib/toast-context";
import { BreadcrumbItem, FileItem, FolderItem } from "@/types";
import { LoadError } from "@/components/ui/LoadError";

export type OrganizeAction = "rename" | "move" | "copy";

interface Props {
  file: FileItem | null;
  folder?: FolderItem | null;
  action: OrganizeAction | null;
  onClose: () => void;
  onComplete: () => void;
}

export function OrganizeFileModal({ file, folder, action, onClose, onComplete }: Props) {
  const open = !!action && !!(file || folder);
  const dialog = useDialog<HTMLFormElement>(open, onClose);
  const toast = useToast();
  const [name, setName] = useState("");
  const [destination, setDestination] = useState<string | null>(null);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const itemId = file?.id || folder?.id;
  const itemName = file?.original_filename || folder?.name || "";
  const originalParent = file ? file.folder_id : folder?.parent_id;

  useEffect(() => {
    setName(action === "rename" ? itemName : "");
    setDestination(originalParent || null);
    setError(null);
  }, [itemId, itemName, originalParent, action]);

  const loadFolders = useCallback(async () => {
    if (!open || action === "rename") return;
    const current = ++generation.current;
    setLoading(true); setUnavailable(false);
    try {
      const [children, trail] = await Promise.all([api.getFolders(destination), destination ? api.getBreadcrumbs(destination) : Promise.resolve([])]);
      if (current !== generation.current) return;
      setFolders(children.filter((child) => child.id !== folder?.id));
      setBreadcrumbs(trail);
    } catch { if (current === generation.current) setUnavailable(true); }
    finally { if (current === generation.current) setLoading(false); }
  }, [open, action, destination, folder?.id]);

  useEffect(() => {
    void loadFolders();
    return () => { generation.current += 1; };
  }, [loadFolders]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!action || !itemId || saving) return;
    setSaving(true); setError(null);
    try {
      if (folder) await api.moveFolder(folder.id, destination);
      else if (file && action === "rename") await api.updateFile(file.id, { original_filename: name.trim() });
      else if (file && action === "move") await api.moveFile(file.id, destination);
      else if (file) await api.copyFile(file.id, destination, name.trim() || undefined);
      toast.success(action === "rename" ? "File renamed" : action === "copy" ? "File copied" : folder ? "Folder moved" : "File moved");
      onComplete(); onClose();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The item could not be updated."); }
    finally { setSaving(false); }
  };

  if (!open || !action) return null;
  const title = `${action === "rename" ? "Rename" : action === "copy" ? "Copy" : "Move"} ${folder ? "folder" : "file"}`;

  return <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/50 backdrop-blur-sm">
    <form ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="organize-title" onSubmit={save} className="bg-card border border-border w-full max-w-lg rounded-2xl shadow-2xl flex flex-col max-h-[90vh] max-h-[90dvh] overflow-hidden">
      <header className="p-4 flex items-center justify-between gap-3 border-b border-border"><div className="min-w-0"><h2 id="organize-title" className="font-semibold text-sm">{title}</h2><p className="text-xs text-muted-foreground truncate">{itemName}</p></div><button type="button" aria-label="Close organize dialog" onClick={onClose} className="p-2 rounded-lg hover:bg-accent"><X className="w-4 h-4" /></button></header>
      <div className="p-4 space-y-4 overflow-auto">
        {action !== "move" && <div><label htmlFor="organize-name" className="block text-xs font-medium mb-2">{action === "copy" ? "New name (optional)" : "File name"}</label><input id="organize-name" data-autofocus required={action === "rename"} maxLength={255} value={name} onChange={(event) => setName(event.target.value)} placeholder={action === "copy" ? "Keep the automatically generated copy name" : "File name"} className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-accent/30" /></div>}
        {action !== "rename" && <section aria-label="Destination folder" className="space-y-3">
          <p className="text-xs text-muted-foreground">Browse to a destination, then choose {action === "copy" ? "Copy here" : "Move here"}. My Files is the root folder.</p>
          <nav aria-label="Destination breadcrumbs" className="flex items-center gap-1 flex-wrap text-xs"><button type="button" onClick={() => setDestination(null)} className="px-2 py-2 rounded-lg hover:bg-accent inline-flex items-center gap-1"><Home className="w-3.5 h-3.5" />My Files</button>{breadcrumbs.map((crumb) => <span key={crumb.id} className="inline-flex items-center gap-1"><ChevronRight className="w-3 h-3" /><button type="button" onClick={() => setDestination(crumb.id)} className="px-2 py-2 rounded-lg hover:bg-accent">{crumb.name}</button></span>)}</nav>
          {loading ? <p role="status" className="text-xs p-4 text-muted-foreground">Loading folders…</p> : unavailable ? <LoadError onRetry={loadFolders} /> : <div className="border border-border rounded-xl divide-y divide-border">{folders.length ? folders.map((child) => <button key={child.id} type="button" onClick={() => setDestination(child.id)} className="w-full flex items-center justify-between gap-3 text-left p-3 hover:bg-accent text-sm"><span className="min-w-0 truncate inline-flex items-center gap-2"><Folder className="w-4 h-4 text-amber-600 shrink-0" />{child.name}</span><ChevronRight className="w-4 h-4 shrink-0" /></button>) : <p className="p-4 text-xs text-muted-foreground">No subfolders. You can choose this location.</p>}</div>}
        </section>}
        {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>
      <footer className="border-t border-border p-4 flex justify-end gap-2"><button type="button" onClick={onClose} className="px-4 py-2 rounded-lg bg-secondary text-xs font-semibold">Cancel</button><button disabled={saving || (action === "rename" ? !name.trim() : loading || unavailable)} type="submit" className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-xs font-semibold disabled:opacity-50">{saving ? "Saving…" : action === "rename" ? "Rename" : action === "copy" ? "Copy here" : "Move here"}</button></footer>
    </form>
  </div>;
}
