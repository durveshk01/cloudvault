import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number, decimals: number = 2): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}

export function formatDate(dateString: string | null | undefined): string {
  if (!dateString) return "—";
  const date = new Date(dateString);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function getFileCategory(filename: string, mimeType?: string | null): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const categories: Record<string, string[]> = {
    image: ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico"],
    document: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv", "rtf"],
    video: ["mp4", "webm", "mkv", "avi", "mov"],
    audio: ["mp3", "wav", "ogg", "flac", "m4a"],
    archive: ["zip", "tar", "gz", "7z", "rar"],
    code: ["json", "xml", "yaml", "yml", "py", "js", "ts", "tsx", "jsx", "html", "css", "sql", "sh"],
  };

  for (const [cat, exts] of Object.entries(categories)) {
    if (exts.includes(ext)) return cat;
  }
  if (mimeType?.startsWith("image/")) return "image";
  if (mimeType?.startsWith("video/")) return "video";
  if (mimeType?.startsWith("audio/")) return "audio";
  if (mimeType?.startsWith("text/")) return "document";
  return "other";
}
