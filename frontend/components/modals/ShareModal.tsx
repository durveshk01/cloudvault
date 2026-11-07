"use client";

import React, { useEffect, useState } from "react";
import {
  Share2,
  X,
  Users,
  Link as LinkIcon,
  Copy,
  Check,
  Trash2,
  Lock,
  Calendar,
  DownloadCloud,
  Shield,
} from "lucide-react";
import { FileItem, FileShare, ShareLink } from "@/types";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/utils";
import { LoadError } from "@/components/ui/LoadError";

interface ShareModalProps {
  file: FileItem | null;
  isOpen: boolean;
  onClose: () => void;
}

export function ShareModal({ file, isOpen, onClose }: ShareModalProps) {
  const [activeTab, setActiveTab] = useState<"users" | "links">("users");

  // User share state
  const [email, setEmail] = useState("");
  const [permission, setPermission] = useState<"viewer" | "editor">("viewer");
  const [directShares, setDirectShares] = useState<FileShare[]>([]);
  const [isLoadingShares, setIsLoadingShares] = useState(false);
  const [sharesUnavailable, setSharesUnavailable] = useState(false);
  const [isSharingUser, setIsSharingUser] = useState(false);
  const [userShareError, setUserShareError] = useState<string | null>(null);

  // Link state
  const [shareLinks, setShareLinks] = useState<ShareLink[]>([]);
  const [isLoadingLinks, setIsLoadingLinks] = useState(false);
  const [linksUnavailable, setLinksUnavailable] = useState(false);
  const [linkPermission, setLinkPermission] = useState<"view" | "download">("download");
  const [password, setPassword] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [maxDownloads, setMaxDownloads] = useState<string>("");
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isCreatingLink, setIsCreatingLink] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  const loadData = () => {
    if (!file) return;
    setIsLoadingShares(true);
    setSharesUnavailable(false);
    api.getFileShares(file.id)
      .then(setDirectShares)
      .catch(() => setSharesUnavailable(true))
      .finally(() => setIsLoadingShares(false));
    setIsLoadingLinks(true);
    setLinksUnavailable(false);
    api.getFileShareLinks(file.id)
      .then(setShareLinks)
      .catch(() => setLinksUnavailable(true))
      .finally(() => setIsLoadingLinks(false));
  };

  useEffect(() => {
    if (file && isOpen) {
      loadData();
      setCreatedUrl(null);
      setUserShareError(null);
      setLinkError(null);
    }
  }, [file, isOpen]);

  if (!isOpen || !file) return null;

  const handleShareWithUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;

    setIsSharingUser(true);
    setUserShareError(null);
    try {
      await api.shareWithUser(file.id, email.trim(), permission);
      setEmail("");
      loadData();
    } catch (err: any) {
      setUserShareError(err.message || "Failed to share file.");
    } finally {
      setIsSharingUser(false);
    }
  };

  const handleRevokeShare = async (shareId: string) => {
    try {
      await api.revokeShare(shareId);
      loadData();
    } catch (err: any) {
      setUserShareError(err.message);
    }
  };

  const handleCreateShareLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsCreatingLink(true);
    setLinkError(null);
    try {
      const link = await api.createShareLink(file.id, {
        permission: linkPermission,
        password: password.trim() ? password.trim() : null,
        expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
        max_downloads: maxDownloads ? parseInt(maxDownloads, 10) : null,
      });

      const fullUrl = link.share_url || `${window.location.origin}/shared/${link.token}`;
      setCreatedUrl(fullUrl);
      setPassword("");
      setExpiresAt("");
      setMaxDownloads("");
      loadData();
    } catch (err: any) {
      setLinkError(err.message || "Failed to create share link.");
    } finally {
      setIsCreatingLink(false);
    }
  };

  const handleRevokeLink = async (linkId: string) => {
    try {
      await api.revokeShareLink(linkId);
      loadData();
    } catch (err: any) {
      setLinkError(err.message);
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setLinkError("The link could not be copied. Select and copy it manually.");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/50 backdrop-blur-sm animate-in fade-in">
      <div role="dialog" aria-modal="true" aria-labelledby="share-modal-title" className="bg-card border border-border w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90dvh] sm:max-h-[85vh]">
        {/* Header */}
        <div className="p-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400">
              <Share2 className="w-4 h-4" />
            </div>
            <div>
              <h3 id="share-modal-title" className="font-semibold text-sm text-foreground">
                Share &ldquo;{file.original_filename}&rdquo;
              </h3>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close sharing dialog"
            className="p-1 rounded-lg text-muted-foreground hover:bg-accent"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-border bg-accent/20 px-4">
          <button
            onClick={() => setActiveTab("users")}
            className={`py-3 px-4 text-xs font-semibold border-b-2 flex items-center gap-2 transition-all ${
              activeTab === "users"
                ? "border-indigo-600 text-indigo-600 dark:text-indigo-400"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Users className="w-4 h-4" />
            Registered Users
          </button>
          <button
            onClick={() => setActiveTab("links")}
            className={`py-3 px-4 text-xs font-semibold border-b-2 flex items-center gap-2 transition-all ${
              activeTab === "links"
                ? "border-indigo-600 text-indigo-600 dark:text-indigo-400"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <LinkIcon className="w-4 h-4" />
            Public Link
          </button>
        </div>

        {/* Body */}
        <div className="p-5 flex-1 overflow-y-auto space-y-5">
          {activeTab === "users" ? (
            /* TAB 1: Registered Users */
            <div className="space-y-4">
              <form onSubmit={handleShareWithUser} className="space-y-3">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    id="collaborator-email"
                    type="email"
                    required
                    aria-label="Collaborator email address"
                    placeholder="Enter collaborator email..."
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="min-w-0 flex-1 bg-accent/40 border border-border rounded-lg px-3 py-2 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                  <select
                    aria-label="Collaborator permission"
                    value={permission}
                    onChange={(e) => setPermission(e.target.value as any)}
                    className="w-full sm:w-auto bg-accent/40 border border-border rounded-lg px-3 py-2 text-xs text-foreground focus:outline-none"
                  >
                    <option value="viewer">Viewer</option>
                    <option value="editor">Editor</option>
                  </select>
                  <button
                    type="submit"
                    disabled={isSharingUser || !email.trim()}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-semibold rounded-lg transition-colors"
                  >
                    {isSharingUser ? "Adding..." : "Share"}
                  </button>
                </div>
                {userShareError && (
                  <p className="text-xs text-red-600 dark:text-red-400 font-medium">
                    {userShareError}
                  </p>
                )}
              </form>

              {/* Existing direct shares */}
              <div>
                <h4 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wider">
                  People with access
                </h4>
                {isLoadingShares ? (
                  <p role="status" className="py-3 text-center text-xs text-muted-foreground">Loading access list...</p>
                ) : sharesUnavailable ? (
                  <LoadError onRetry={loadData} isRetrying={isLoadingShares} />
                ) : directShares.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-3 text-center">
                    This file is currently only accessible by you.
                  </p>
                ) : (
                  <div className="divide-y divide-border border border-border rounded-xl overflow-hidden">
                    {directShares.map((s) => (
                      <div
                        key={s.id}
                        className="p-3 flex items-center justify-between bg-card text-xs"
                      >
                        <div>
                          <p className="font-semibold text-foreground">
                            {s.recipient?.full_name || s.recipient?.email || "User"}
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            {s.recipient?.email} • {s.permission}
                          </p>
                        </div>
                        <button
                          onClick={() => handleRevokeShare(s.id)}
                          className="p-1.5 text-muted-foreground hover:text-red-600 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/20 transition-colors"
                          title="Revoke access"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            /* TAB 2: Share Links */
            <div className="space-y-4">
              {/* Newly created link banner */}
              {createdUrl && (
                <div className="p-3.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 space-y-2">
                  <div className="flex items-center gap-2 text-emerald-800 dark:text-emerald-300 font-semibold text-xs">
                    <Check className="w-4 h-4 text-emerald-600" />
                    Share link generated!
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      value={createdUrl}
                      className="flex-1 bg-white dark:bg-card border border-emerald-300 dark:border-emerald-700 rounded-lg px-2.5 py-1.5 text-xs text-foreground font-mono select-all"
                    />
                    <button
                      onClick={() => copyToClipboard(createdUrl)}
                      className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold flex items-center gap-1"
                    >
                      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                </div>
              )}

              {/* Create new link form */}
              <form onSubmit={handleCreateShareLink} className="space-y-3 p-3.5 bg-accent/20 rounded-xl border border-border">
                <h4 className="text-xs font-semibold text-foreground">Create Restricted Sharing Link</h4>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-medium text-muted-foreground mb-1">
                      Permission
                    </label>
                    <select
                      value={linkPermission}
                      onChange={(e) => setLinkPermission(e.target.value as any)}
                      className="w-full bg-card border border-border rounded-lg px-2.5 py-1.5 text-xs text-foreground focus:outline-none"
                    >
                      <option value="download">View & Download</option>
                      <option value="view">View Only</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-muted-foreground mb-1 flex items-center gap-1">
                      <Lock className="w-3 h-3 text-muted-foreground" />
                      Optional Password
                    </label>
                    <input
                      type="password"
                      placeholder="Require password..."
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full bg-card border border-border rounded-lg px-2.5 py-1.5 text-xs text-foreground focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-muted-foreground mb-1 flex items-center gap-1">
                      <Calendar className="w-3 h-3 text-muted-foreground" />
                      Expires At
                    </label>
                    <input
                      type="datetime-local"
                      value={expiresAt}
                      onChange={(e) => setExpiresAt(e.target.value)}
                      className="w-full bg-card border border-border rounded-lg px-2.5 py-1.5 text-xs text-foreground focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-muted-foreground mb-1 flex items-center gap-1">
                      <DownloadCloud className="w-3 h-3 text-muted-foreground" />
                      Download Limit
                    </label>
                    <input
                      type="number"
                      min="1"
                      placeholder="e.g. 5 downloads"
                      value={maxDownloads}
                      onChange={(e) => setMaxDownloads(e.target.value)}
                      className="w-full bg-card border border-border rounded-lg px-2.5 py-1.5 text-xs text-foreground focus:outline-none"
                    />
                  </div>
                </div>

                {linkError && <p className="text-xs text-red-600 dark:text-red-400 font-medium">{linkError}</p>}

                <div className="pt-2 flex justify-end">
                  <button
                    type="submit"
                    disabled={isCreatingLink}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-xs font-semibold rounded-lg transition-colors"
                  >
                    {isCreatingLink ? "Creating Link..." : "Create Link"}
                  </button>
                </div>
              </form>

              {/* Existing active links */}
              <div>
                <h4 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wider">
                  Active Links
                </h4>
                {isLoadingLinks ? (
                  <p role="status" className="py-3 text-center text-xs text-muted-foreground">Loading links...</p>
                ) : linksUnavailable ? (
                  <LoadError onRetry={loadData} isRetrying={isLoadingLinks} />
                ) : shareLinks.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-2 text-center">
                    No active public links for this file.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {shareLinks.map((l) => (
                      <div
                        key={l.id}
                        className="p-3 bg-card border border-border rounded-xl flex items-center justify-between text-xs"
                      >
                        <div className="space-y-0.5">
                          <p className="font-semibold text-foreground flex items-center gap-1.5">
                            <LinkIcon className="w-3.5 h-3.5 text-indigo-500" />
                            {l.permission === "view" ? "View Only" : "View & Download"}
                            {l.max_downloads && (
                              <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded">
                                {l.download_count}/{l.max_downloads} dl
                              </span>
                            )}
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            Created {formatDate(l.created_at)}
                            {l.expires_at ? ` • Expires ${formatDate(l.expires_at)}` : ""}
                          </p>
                        </div>

                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => handleRevokeLink(l.id)}
                            className="p-1.5 text-muted-foreground hover:text-red-600 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/20"
                            title="Revoke Link"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-border bg-accent/10 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-secondary hover:bg-secondary/80 text-foreground transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
