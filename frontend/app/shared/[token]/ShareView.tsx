"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import {
  Shield,
  Download,
  Eye,
  Lock,
  AlertCircle,
  FileText,
  Image as ImageIcon,
  Film,
  Music,
  Archive,
  File,
  CheckCircle,
  ExternalLink,
  ChevronRight,
} from "lucide-react";
import { api } from "@/lib/api";
import { PublicShareInfo } from "@/types";
import { formatBytes } from "@/lib/utils";
import { PreviewContent } from "@/components/files/PreviewContent";
import type { Preview } from "@/lib/use-preview";
import { useRuntime } from "@/lib/runtime-context";

export default function PublicSharePage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") || (typeof params?.token === "string" ? params.token : "");
  const { native } = useRuntime();
  const activeToken = useRef(token);
  activeToken.current = token;

  const [shareInfo, setShareInfo] = useState<PublicShareInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Password state
  const [password, setPassword] = useState("");
  const [isVerifying, setIsVerifying] = useState(false);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  // Preview state
  const [showPreview, setShowPreview] = useState(false);
  const [preview, setPreview] = useState<Preview>({ url: null, mime: "", text: null, loading: false, error: null });
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setShareInfo(null); setError(null); setIsUnlocked(false); setPassword(""); setPasswordError(null); setShowPreview(false); setDownloadError(null); setIsVerifying(false); setDownloading(false);
    if (!token) { setError("Open a valid CloudVault share link."); setIsLoading(false); return; }
    setIsLoading(true);
    api.getPublicShareInfo(token)
      .then((info) => {
        if (!current) return;
        setShareInfo(info);
        if (!info.requires_password) {
          setIsUnlocked(true);
        }
      })
      .catch((err) => {
        if (!current) return;
        setError(err.message || "This shared link is invalid, expired, or has reached its download limit.");
      })
      .finally(() => {
        if (current) setIsLoading(false);
      });
    return () => { current = false; };
  }, [token]);

  useEffect(() => {
    if (!showPreview || !isUnlocked) return;
    if ((shareInfo?.file_size || 0) > 12 * 1024 * 1024) {
      setPreview({ url: null, mime: "", text: null, loading: false, error: "Preview is limited to 12 MB. Download the file to open it locally." }); return;
    }
    let current = true;
    let url: string | null = null;
    const controller = new AbortController();
    setPreview({ url: null, mime: "", text: null, loading: true, error: null });
    void api.getPublicPreviewBlob(token, password, controller.signal).then(async (blob) => {
      const mime = blob.type.split(";")[0];
      const text = mime.startsWith("text/") || mime.includes("json") ? await blob.slice(0, 1024 * 1024).text() : null;
      if (!current) return;
      url = URL.createObjectURL(blob);
      setPreview({ url, mime, text, loading: false, error: null });
    }).catch((error) => { if (current) setPreview({ url: null, mime: "", text: null, loading: false, error: error.message || "Preview unavailable." }); });
    return () => { current = false; controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [showPreview, isUnlocked, token, password, shareInfo?.file_size]);

  const handleVerifyPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;

    setIsVerifying(true);
    setPasswordError(null);

    try {
      await api.verifyPublicLinkPassword(token, password);
      if (token === activeToken.current) setIsUnlocked(true);
    } catch (err: any) {
      if (token === activeToken.current) setPasswordError(err.message || "Incorrect password. Please try again.");
    } finally {
      if (token === activeToken.current) setIsVerifying(false);
    }
  };

  const getFileIcon = (mime?: string | null, filename?: string) => {
    const m = (mime || "").toLowerCase();
    const f = (filename || "").toLowerCase();

    if (m.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp|svg)$/.test(f)) {
      return <ImageIcon className="w-10 h-10 text-emerald-500" />;
    }
    if (m.startsWith("video/") || /\.(mp4|webm|mkv|mov)$/.test(f)) {
      return <Film className="w-10 h-10 text-amber-500" />;
    }
    if (m.startsWith("audio/") || /\.(mp3|wav|ogg)$/.test(f)) {
      return <Music className="w-10 h-10 text-purple-500" />;
    }
    if (m === "application/pdf" || f.endsWith(".pdf")) {
      return <FileText className="w-10 h-10 text-red-500" />;
    }
    if (/\.(zip|tar|gz|rar|7z)$/.test(f)) {
      return <Archive className="w-10 h-10 text-pink-500" />;
    }
    return <File className="w-10 h-10 text-indigo-500" />;
  };

  const download = async () => {
    if (!shareInfo) return;
    setDownloading(true); setDownloadError(null);
    try {
       const saved = await api.downloadPublicFile(token, shareInfo.filename, password || undefined);
       if (saved && token === activeToken.current) setShareInfo((info) => info && { ...info, downloads_remaining: info.downloads_remaining === null ? null : Math.max(0, info.downloads_remaining - 1) });
    } catch (error) { if (token === activeToken.current) setDownloadError(error instanceof Error ? error.message : "Download failed."); }
    finally { if (token === activeToken.current) setDownloading(false); }
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col justify-between">
      {/* Top Navigation */}
      <header className="border-b border-border bg-card/60 backdrop-blur-md sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center text-white shadow-md shadow-indigo-600/30">
              <Shield className="w-5 h-5" />
            </div>
            <span className="font-bold text-lg tracking-tight">CloudVault</span>
          </Link>

          <div className="flex items-center gap-3">
            <Link
              href="/login"
              className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors px-3 py-1.5"
            >
              Sign In
            </Link>
            <Link
              href="/register"
              className="text-sm font-medium px-4 py-2 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700 transition-colors shadow-md shadow-indigo-600/20"
            >
              Get Started Free
            </Link>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 flex items-center justify-center p-4 sm:p-6 my-8">
        <div className="w-full max-w-lg">
          {isLoading ? (
            <div className="bg-card border border-border rounded-2xl p-8 text-center shadow-lg">
              <div className="w-10 h-10 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
              <p className="text-sm text-muted-foreground">Loading shared file...</p>
            </div>
          ) : error ? (
            <div className="bg-card border border-border rounded-2xl p-8 text-center shadow-lg space-y-4">
              <div className="w-14 h-14 rounded-2xl bg-red-500/10 text-red-500 flex items-center justify-center mx-auto">
                <AlertCircle className="w-8 h-8" />
              </div>
              <h2 className="text-xl font-bold text-foreground">Link Unavailable</h2>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {error}
              </p>
              <div className="pt-2">
                <Link
                  href="/"
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-muted text-foreground font-medium text-sm hover:bg-muted/80 transition-colors"
                >
                  Return to CloudVault Home
                </Link>
              </div>
            </div>
          ) : shareInfo && !isUnlocked ? (
            /* Password Protection Screen */
            <div className="bg-card border border-border rounded-2xl p-8 shadow-xl space-y-6">
              <div className="text-center space-y-2">
                <div className="w-14 h-14 rounded-2xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 flex items-center justify-center mx-auto">
                  <Lock className="w-7 h-7" />
                </div>
                <h2 className="text-xl font-bold text-foreground">Password Protected File</h2>
                <p className="text-xs text-muted-foreground">
                  The owner has protected <span className="font-semibold text-foreground">{shareInfo.filename}</span> with a secure password.
                </p>
              </div>

              <form onSubmit={handleVerifyPassword} className="space-y-4">
                {passwordError && (
                  <div className="flex items-center gap-2 p-3 text-sm rounded-xl bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" />
                    <span>{passwordError}</span>
                  </div>
                )}

                <div>
                  <label htmlFor="share-password" className="block text-xs font-semibold text-foreground uppercase tracking-wider mb-2">
                    Enter Password
                  </label>
                  <input
                    id="share-password"
                     type="password"
                     disabled={isVerifying}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter link password..."
                    className="w-full px-4 py-2.5 text-sm rounded-xl border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-colors"
                    required
                    maxLength={100}
                  />
                </div>

                <button
                  type="submit"
                   disabled={isVerifying || !password}
                  className="w-full py-2.5 rounded-xl bg-indigo-600 text-white font-medium text-sm hover:bg-indigo-700 transition-colors shadow-md shadow-indigo-600/20 disabled:opacity-50"
                >
                  {isVerifying ? "Verifying..." : "Unlock File"}
                </button>
              </form>
            </div>
          ) : shareInfo ? (
            /* Unlocked Shared File Card */
            <div className="bg-card border border-border rounded-2xl p-6 sm:p-8 shadow-xl space-y-6">
              {/* File Icon and Name */}
              <div className="flex items-start gap-4 pb-6 border-b border-border">
                <div className="w-16 h-16 rounded-2xl bg-muted/60 border border-border flex items-center justify-center flex-shrink-0">
                  {getFileIcon(shareInfo.mime_type, shareInfo.filename)}
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
                    Shared with you
                  </span>
                  <h1 className="text-lg font-bold text-foreground truncate mt-0.5" title={shareInfo.filename}>
                    {shareInfo.filename}
                  </h1>
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    <span className="text-xs text-muted-foreground font-medium">
                      {formatBytes(shareInfo.file_size)}
                    </span>
                    <span className="text-muted-foreground">·</span>
                    <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-muted text-muted-foreground uppercase">
                      {shareInfo.permission === "view" ? "View Only" : "Download Allowed"}
                    </span>
                    {shareInfo.downloads_remaining !== null && (
                      <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
                        {shareInfo.downloads_remaining} download{shareInfo.downloads_remaining === 1 ? "" : "s"} left
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Inline Preview (if toggled) */}
              {showPreview && (
                  <div className="rounded-xl border border-border overflow-hidden bg-background min-h-48 max-h-96 flex items-center justify-center">
                    <PreviewContent preview={preview} filename={shareInfo.filename} />
                  </div>
              )}

              {/* Actions */}
              <div className="flex flex-col sm:flex-row gap-3">
                {shareInfo.permission !== "view" && (
                  <button
                    onClick={download}
                    disabled={downloading || shareInfo.downloads_remaining === 0}
                    className="flex-1 inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-indigo-600 text-white font-medium text-sm hover:bg-indigo-700 transition-colors shadow-md shadow-indigo-600/20"
                  >
                    <Download className="w-4 h-4" />
                    {downloading ? "Downloading…" : native ? "Save to device" : "Download File"}
                  </button>
                )}

                {shareInfo.preview_supported && (
                  <button
                    onClick={() => setShowPreview(!showPreview)}
                    className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl border border-border bg-muted/50 text-foreground font-medium text-sm hover:bg-muted transition-colors"
                  >
                    <Eye className="w-4 h-4" />
                    {showPreview ? "Hide Preview" : "Preview"}
                  </button>
                )}
              </div>
              {downloadError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{downloadError}</p>}
              {!native && token && <a href={`cloudvault://shared/${encodeURIComponent(token)}`} className="inline-flex items-center gap-2 text-xs font-semibold text-indigo-600 dark:text-indigo-400 py-2"><ExternalLink className="w-3.5 h-3.5" />Open in installed CloudVault Android app</a>}

              {/* Security Banner */}
              <div className="p-4 rounded-xl bg-muted/30 border border-border/60 flex items-start gap-3 text-xs text-muted-foreground">
                <Shield className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
                <span>
                  Access is checked before every preview and download. Links follow the owner&apos;s password, expiry, and download-limit settings.
                </span>
              </div>
            </div>
          ) : null}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border py-6 text-center text-xs text-muted-foreground">
        <p>© {new Date().getFullYear()} CloudVault — Cloud File Storage &amp; Secure Sharing Platform.</p>
      </footer>
    </div>
  );
}
