"use client";

import React, { useState, useRef, useEffect } from "react";
import { Folder, MoreVertical, Edit2, Trash2, FolderInput } from "lucide-react";
import { FolderItem } from "@/types";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast-context";

interface FolderCardProps {
  folder: FolderItem;
  onClick: () => void;
  onRefresh: () => void;
  onMove?: () => void;
}

export function FolderCard({ folder, onClick, onMove, onRefresh }: FolderCardProps) {
  const toast = useToast();
  const [showMenu, setShowMenu] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [name, setName] = useState(folder.name);
  const menuRef = useRef<HTMLDivElement>(null);
  const saving = useRef(false);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleRenameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || name === folder.name) {
      setIsRenaming(false);
      return;
    }
    if (saving.current) return;
    saving.current = true;
    try { await api.renameFolder(folder.id, name.trim()); setIsRenaming(false); onRefresh(); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Folder could not be renamed."); }
    finally { saving.current = false; }
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm(`Move folder "${folder.name}" and all its contents to trash?`)) {
      try { await api.deleteFolder(folder.id); onRefresh(); }
      catch (error) { toast.error(error instanceof Error ? error.message : "Folder could not be moved to trash."); }
    }
  };

  return (
    <div
      onClick={isRenaming ? undefined : onClick}
      className="group relative rounded-xl border border-border p-3.5 bg-card hover:bg-accent/30 transition-all cursor-pointer flex items-center justify-between hover:shadow-sm"
    >
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <div className="w-10 h-10 rounded-lg bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
          <Folder className="w-5 h-5 fill-amber-500/20" />
        </div>

        <div className="min-w-0 flex-1">
          {isRenaming ? (
            <form onSubmit={handleRenameSubmit} onClick={(e) => e.stopPropagation()}>
              <input
                type="text"
                aria-label={`Rename ${folder.name}`}
                maxLength={255}
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={handleRenameSubmit}
                className="w-full bg-accent/60 border border-indigo-500 rounded px-1.5 py-0.5 text-xs text-foreground focus:outline-none"
              />
            </form>
          ) : (
            <button onClick={(event) => { event.stopPropagation(); onClick(); }} className="w-full text-left text-xs font-semibold text-foreground truncate" title={folder.name}>
              {folder.name}
            </button>
          )}

          <p className="text-[11px] text-muted-foreground mt-0.5">
            {folder.file_count ?? 0} files
            {folder.subfolder_count ? ` • ${folder.subfolder_count} folders` : ""}
          </p>
        </div>
      </div>

      <div className="relative" ref={menuRef} onClick={(e) => e.stopPropagation()}>
        <button
          aria-label={`Actions for folder ${folder.name}`}
          aria-expanded={showMenu}
          onClick={() => setShowMenu(!showMenu)}
          className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent"
        >
          <MoreVertical className="w-4 h-4" />
        </button>

        {showMenu && (
          <div className="absolute right-0 mt-1 w-36 bg-card border border-border rounded-xl shadow-xl z-20 py-1 text-xs text-left">
            <button
              onClick={() => {
                setShowMenu(false);
                setIsRenaming(true);
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-accent text-foreground flex items-center gap-2"
            >
              <Edit2 className="w-3.5 h-3.5" />
              Rename
            </button>
            <div className="border-t border-border my-1" />
            {onMove && <button onClick={() => { setShowMenu(false); onMove(); }} className="w-full text-left px-3 py-1.5 hover:bg-accent flex items-center gap-2"><FolderInput className="w-3.5 h-3.5" />Move</button>}
            <button
              onClick={handleDelete}
              className="w-full text-left px-3 py-1.5 hover:bg-red-50 dark:hover:bg-red-950/30 text-red-600 dark:text-red-400 flex items-center gap-2 font-medium"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
