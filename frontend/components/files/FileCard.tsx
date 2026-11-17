"use client";

import React from "react";
import Image from "next/image";
import {
  FileText,
  Image as ImageIcon,
  Video,
  Music,
  Archive,
  Code,
  File,
  MoreVertical,
  Star,
  Download,
  Share2,
  Trash2,
  History,
  Eye,
  Copy,
  FolderInput,
  Edit2,
} from "lucide-react";
import { FileItem } from "@/types";
import { formatBytes, formatDate, getFileCategory } from "@/lib/utils";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast-context";
import { usePreview } from "@/lib/use-preview";
import { isDeviceVault, isNative } from "@/lib/native";

interface FileCardProps {
  file: FileItem;
  isSelected: boolean;
  onSelect: (e: React.MouseEvent) => void;
  onPreview: () => void;
  onShare: () => void;
  onVersions: () => void;
  onDetails: () => void;
  onRefresh: () => void;
  onRename?: () => void;
  onMove?: () => void;
  onCopy?: () => void;
}

export function FileCard({
  file,
  isSelected,
  onSelect,
  onPreview,
  onShare,
  onVersions,
  onDetails,
  onRefresh,
  onRename,
  onMove,
  onCopy,
}: FileCardProps) {
  const toast = useToast();
  const [showMenu, setShowMenu] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const thumbnailRef = React.useRef<HTMLDivElement>(null);
  const [visible, setVisible] = React.useState(false);
  const category = getFileCategory(file.original_filename, file.mime_type);
  const thumbnail = usePreview(file, visible && category === "image" && file.size_bytes <= 2 * 1024 * 1024);

  React.useEffect(() => {
    const element = thumbnailRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) { setVisible(true); observer.disconnect(); } }, { rootMargin: "100px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const getIcon = () => {
    switch (category) {
      case "image":
        return <ImageIcon className="w-8 h-8 text-blue-500" />;
      case "video":
        return <Video className="w-8 h-8 text-purple-500" />;
      case "audio":
        return <Music className="w-8 h-8 text-pink-500" />;
      case "archive":
        return <Archive className="w-8 h-8 text-amber-500" />;
      case "code":
        return <Code className="w-8 h-8 text-emerald-500" />;
      case "document":
        return <FileText className="w-8 h-8 text-indigo-500" />;
      default:
        return <File className="w-8 h-8 text-slate-500" />;
    }
  };

  const handleToggleStar = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try { await api.toggleStar(file.id); onRefresh(); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Favorite could not be updated."); }
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try { await api.deleteFile(file.id); onRefresh(); }
    catch (error) { toast.error(error instanceof Error ? error.message : "File could not be moved to trash."); }
  };

  return (
    <div
      onClick={onSelect}
      onDoubleClick={onPreview}
      className={`group relative rounded-xl border p-3 sm:p-4 bg-card transition-all cursor-pointer flex flex-col justify-between hover:shadow-md ${
        isSelected
          ? "border-indigo-600 bg-indigo-50/20 dark:bg-indigo-950/20 ring-2 ring-indigo-600/30"
          : "border-border hover:border-border/80"
      }`}
    >
      {/* Top Header: Star & Menu */}
      <div className="flex items-center justify-between mb-3">
        <input type="checkbox" aria-label={`Select ${file.original_filename}`} checked={isSelected} readOnly onClick={(event) => { event.stopPropagation(); onSelect(event); }} className="w-4 h-4 rounded accent-indigo-600" />
        <button
          onClick={handleToggleStar}
          className={`p-1 rounded-lg transition-colors ${
            file.is_starred
              ? "text-amber-500"
              : "text-muted-foreground/40 group-hover:text-muted-foreground hover:text-amber-500"
          }`}
          title={file.is_starred ? "Unstar" : "Star"}
        >
          <Star className={`w-4 h-4 ${file.is_starred ? "fill-amber-500" : ""}`} />
        </button>

        <div className="relative" ref={menuRef}>
          <button
            aria-label={`Actions for ${file.original_filename}`}
            aria-expanded={showMenu}
            onClick={(e) => {
              e.stopPropagation();
              setShowMenu(!showMenu);
            }}
            className="p-1 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <MoreVertical className="w-4 h-4" />
          </button>

          {showMenu && (
            <div className="absolute right-0 mt-1 w-44 bg-card border border-border rounded-xl shadow-xl z-20 py-1 text-xs">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowMenu(false);
                  onPreview();
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-accent text-foreground flex items-center gap-2"
              >
                <Eye className="w-3.5 h-3.5" />
                Preview
              </button>
              <button
                type="button"
                onClick={async (e) => {
                  e.stopPropagation();
                  setShowMenu(false);
                  try {
                    await api.downloadFile(file.id, file.original_filename);
                    if (isNative() && !isDeviceVault()) toast.info("Download queued. See Offline & transfers for progress.");
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : "The file could not be downloaded.");
                  }
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-accent text-foreground flex items-center gap-2"
              >
                <Download className="w-3.5 h-3.5" />
                Download
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowMenu(false);
                  onShare();
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-accent text-foreground flex items-center gap-2"
              >
                <Share2 className="w-3.5 h-3.5" />
                Share
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowMenu(false);
                  onVersions();
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-accent text-foreground flex items-center gap-2"
              >
                <History className="w-3.5 h-3.5" />
                Version History
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowMenu(false);
                  onDetails();
                }}
                className="w-full text-left px-3 py-1.5 hover:bg-accent text-foreground flex items-center gap-2"
              >
                <FileText className="w-3.5 h-3.5" />
                File Details
              </button>
              <div className="border-t border-border my-1" />
              {onRename && <button onClick={(event) => { event.stopPropagation(); setShowMenu(false); onRename(); }} className="w-full text-left px-3 py-1.5 hover:bg-accent flex items-center gap-2"><Edit2 className="w-3.5 h-3.5" />Rename</button>}
              {onMove && <button onClick={(event) => { event.stopPropagation(); setShowMenu(false); onMove(); }} className="w-full text-left px-3 py-1.5 hover:bg-accent flex items-center gap-2"><FolderInput className="w-3.5 h-3.5" />Move</button>}
              {onCopy && <button onClick={(event) => { event.stopPropagation(); setShowMenu(false); onCopy(); }} className="w-full text-left px-3 py-1.5 hover:bg-accent flex items-center gap-2"><Copy className="w-3.5 h-3.5" />Copy</button>}
              <button
                onClick={handleDelete}
                className="w-full text-left px-3 py-1.5 hover:bg-red-50 dark:hover:bg-red-950/30 text-red-600 dark:text-red-400 flex items-center gap-2 font-medium"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Move to Trash
              </button>
            </div>
          )}
        </div>
      </div>

      {/* File Icon & Preview Area */}
      <div ref={thumbnailRef} className="flex flex-col items-center justify-center py-4">
        {thumbnail.url && /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(thumbnail.mime) ? (
          <div className="w-16 h-16 rounded-lg bg-accent/40 flex items-center justify-center overflow-hidden mb-2">
            <Image
              src={thumbnail.url}
              width={64}
              height={64}
              unoptimized
              alt={file.original_filename}
              className="w-full h-full object-cover"
              onError={(e) => {
                // Fallback to icon if preview fails
                e.currentTarget.style.display = "none";
              }}
            />
          </div>
        ) : (
          <div className="w-16 h-16 rounded-xl bg-accent/50 flex items-center justify-center mb-2">
            {getIcon()}
          </div>
        )}
      </div>

      {/* File Info */}
      <div className="mt-2">
        <button onClick={(event) => { event.stopPropagation(); onPreview(); }} className="w-full text-left text-xs font-semibold text-foreground truncate" title={file.original_filename}>
          {file.original_filename}
        </button>
        <div className="flex items-center justify-between text-[11px] text-muted-foreground mt-1">
          <span>{formatBytes(file.size_bytes)}</span>
          <span>v{file.current_version}</span>
        </div>
      </div>
    </div>
  );
}
