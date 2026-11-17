"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { FolderOpen, Download, LayoutDashboard, WifiOff } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { TopNavbar } from "./TopNavbar";
import { UploadModal } from "../modals/UploadModal";
import { NewFolderModal } from "../modals/NewFolderModal";
import { useAuth } from "@/lib/auth-context";
import { useRuntime } from "@/lib/runtime-context";
import { useDialog } from "@/lib/use-dialog";

interface DashboardLayoutProps {
  children: React.ReactNode;
}

export function DashboardLayout({ children }: DashboardLayoutProps) {
  const { user, isLoading, connectionError, refreshUser } = useAuth();
  const { native, device, connected, serverUnavailable, cachedAt, transfers } = useRuntime();
  const router = useRouter();

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [newFolderModalOpen, setNewFolderModalOpen] = useState(false);
  const drawer = useDialog(mobileMenuOpen, () => setMobileMenuOpen(false));

  useEffect(() => {
    if (!isLoading && !user) {
      router.replace("/login");
    }
  }, [user, isLoading, router]);

  useEffect(() => {
    const upload = () => setUploadModalOpen(true);
    window.addEventListener("cv_open_upload", upload);
    return () => window.removeEventListener("cv_open_upload", upload);
  }, []);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          <p className="text-xs text-muted-foreground font-medium">Loading CloudVault...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <div className="flex h-screen h-[100dvh] overflow-hidden bg-background">
      {/* Desktop Sidebar */}
      <div className="hidden md:block">
        <Sidebar />
      </div>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 md:hidden flex">
          <button
            type="button"
            aria-label="Close navigation menu"
            className="fixed inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div ref={drawer} tabIndex={-1} id="mobile-navigation-drawer" role="dialog" aria-modal="true" aria-label="Main navigation" className="relative z-10 w-64 h-full bg-card shadow-xl">
            <Sidebar onCloseMobile={() => setMobileMenuOpen(false)} />
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <TopNavbar
          onOpenMobileMenu={() => setMobileMenuOpen(true)}
          isMobileMenuOpen={mobileMenuOpen}
          onOpenUploadModal={() => setUploadModalOpen(true)}
          onOpenNewFolderModal={() => setNewFolderModalOpen(true)}
        />

        {(connectionError || !device && (!connected || serverUnavailable)) && <div role="status" className="px-4 py-2 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200 text-xs flex items-center justify-between gap-2">
          <span className="flex items-center gap-2"><WifiOff className="w-4 h-4 shrink-0" />{device ? connectionError : !connected ? "Offline. Saved copies are available; transfers wait for a connection." : "Server unavailable. Showing saved data where available."}{cachedAt ? ` Saved ${new Date(cachedAt).toLocaleString()}.` : ""}</span>
          <button onClick={() => { void refreshUser(); window.dispatchEvent(new Event("refresh_files")); }} className="underline shrink-0">Retry</button>
        </div>}
        {device && !connectionError && <div className="px-4 py-2 border-b border-border text-xs text-muted-foreground">On-device vault · Encrypted files and accounts work without internet.</div>}

        <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8">
          {children}
        </main>
        {native && <nav aria-label="Quick navigation" className="md:hidden grid grid-cols-3 shrink-0 border-t border-border bg-card pb-[env(safe-area-inset-bottom)] text-[11px]">
          <Link href="/dashboard" className="py-2 flex flex-col items-center gap-1"><LayoutDashboard className="w-5 h-5" />Home</Link>
          <Link href="/files" className="py-2 flex flex-col items-center gap-1"><FolderOpen className="w-5 h-5" />Files</Link>
          <Link href="/offline" className="py-2 flex flex-col items-center gap-1"><Download className="w-5 h-5" />{device ? "Device" : "Offline"}{transfers.some((transfer) => ["RUNNING", "ENQUEUED", "BLOCKED"].includes(transfer.state)) ? " · Active" : ""}</Link>
        </nav>}
      </div>

      {/* Global Modals */}
      <UploadModal
        isOpen={uploadModalOpen}
        onClose={() => setUploadModalOpen(false)}
        onUploadComplete={() => {
          // Trigger file list refresh if on files page
          window.dispatchEvent(new CustomEvent("refresh_files"));
        }}
      />

      <NewFolderModal
        isOpen={newFolderModalOpen}
        onClose={() => setNewFolderModalOpen(false)}
        onFolderCreated={() => {
          window.dispatchEvent(new CustomEvent("refresh_files"));
        }}
      />
    </div>
  );
}
