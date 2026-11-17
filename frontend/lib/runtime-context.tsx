"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { App } from "@capacitor/app";
import { Network } from "@capacitor/network";
import { StatusBar, Style } from "@capacitor/status-bar";
import type { PluginListenerHandle } from "@capacitor/core";
import { isDeviceVault, isNative, nativeVault, NativeTransfer } from "@/lib/native";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@/lib/toast-context";
import { api } from "@/lib/api";

interface Runtime {
  native: boolean;
  device: boolean;
  connected: boolean;
  serverUnavailable: boolean;
  cachedAt: number | null;
  transfers: NativeTransfer[];
  refreshTransfers: () => Promise<void>;
}

const RuntimeContext = createContext<Runtime | null>(null);

export function RuntimeProvider({ children }: { children: React.ReactNode }) {
  const { user, refreshUser } = useAuth();
  const userId = user?.id;
  const account = useRef(userId);
  account.current = userId;
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const router = useRouter();
  const pathname = usePathname();
  const route = useRef(pathname);
  route.current = pathname;
  const signedIn = useRef(Boolean(user));
  signedIn.current = Boolean(user);
  const [native, setNative] = useState(false);
  const [device, setDevice] = useState(false);
  const [connected, setConnected] = useState(true);
  const [serverUnavailable, setServerUnavailable] = useState(false);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [transfers, setTransfers] = useState<NativeTransfer[]>([]);
  const previousTransfers = useRef(new Map<string, string>());
  const refreshPromise = useRef<{ owner: string; promise: Promise<void> } | null>(null);

  const refreshTransfers = useCallback(async () => {
    if (!isNative() || !userId) return;
    if (refreshPromise.current?.owner === userId) return refreshPromise.current.promise;
    const promise = nativeVault.transfers().then((result) => {
      if (account.current !== userId) return;
      for (const transfer of result.transfers) {
        const previous = previousTransfers.current.get(transfer.id);
        if (previous && previous !== "SUCCEEDED" && transfer.state === "SUCCEEDED") {
          toastRef.current.success(`${transfer.name}: ${isDeviceVault() ? "saved to device vault" : transfer.kind === "upload" ? "uploaded" : "saved offline"}`);
          window.dispatchEvent(new Event("refresh_files"));
        }
        if (previous && previous !== "FAILED" && transfer.state === "FAILED") toastRef.current.error(transfer.error || `${transfer.name}: transfer failed. Retry in Offline & transfers.`);
        previousTransfers.current.set(transfer.id, transfer.state);
      }
      setTransfers(result.transfers);
    }).catch(() => undefined).finally(() => { if (refreshPromise.current?.promise === promise) refreshPromise.current = null; });
    refreshPromise.current = { owner: userId, promise };
    return promise;
  }, [userId]);

  useEffect(() => {
    setNative(isNative());
    setDevice(isDeviceVault());
    const online = () => { setConnected(true); void api.retryPendingLogout().catch(() => undefined); };
    const offline = () => setConnected(false);
    const cached = (event: Event) => { setServerUnavailable(true); setCachedAt((event as CustomEvent<number>).detail || null); };
    const live = () => { setServerUnavailable(false); setCachedAt(null); };
    const pendingLogout = () => toastRef.current.info("Signed out on this device. Server revocation is pending until you reconnect.");
    setConnected(navigator.onLine);
    if (navigator.onLine) void api.retryPendingLogout().catch(() => undefined);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    window.addEventListener("cv_cached_data", cached);
    window.addEventListener("cv_api_live", live);
    window.addEventListener("cv_logout_pending", pendingLogout);
    const listeners: PluginListenerHandle[] = [];
    let disposed = false;
    const keep = async (promise: Promise<PluginListenerHandle>) => {
      try {
        const listener = await promise;
        if (disposed) await listener.remove(); else listeners.push(listener);
      } catch { /* The browser has no native lifecycle plugins. */ }
    };
    if (isNative()) {
      const openLink = (url: string) => {
        try {
          const link = new URL(url);
          const token = link.pathname.replace(/^\//, "");
          if (link.protocol !== "cloudvault:" || link.hostname !== "shared" || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) return;
          router.push(`/share?token=${encodeURIComponent(token)}`);
        } catch { /* Ignore unrelated app intents. */ }
      };
      void App.getLaunchUrl().then((result) => { if (!disposed && result?.url) openLink(result.url); }).catch(() => undefined);
      void keep(App.addListener("appUrlOpen", ({ url }) => openLink(url)));
      if (!isDeviceVault()) {
      void Network.getStatus().then((status) => {
        if (disposed) return;
        setConnected(status.connected);
        if (status.connected) void api.retryPendingLogout().catch(() => undefined);
      }).catch(() => undefined);
      void keep(Network.addListener("networkStatusChange", (status) => {
        setConnected(status.connected);
        window.dispatchEvent(new Event(status.connected ? "online" : "offline"));
      }));
      }
      void keep(App.addListener("appStateChange", ({ isActive }) => {
        if (isActive && signedIn.current) { void refreshUser(); window.dispatchEvent(new Event("cv_transfers_changed")); window.dispatchEvent(new Event("refresh_files")); }
      }));
      void keep(App.addListener("backButton", ({ canGoBack }) => {
        const event = new Event("cv_native_back", { cancelable: true });
        window.dispatchEvent(event);
        if (event.defaultPrevented) return;
        if (["/dashboard", "/login", "/register", ""].includes(route.current.replace(/\/$/, ""))) void App.minimizeApp();
        else if (canGoBack) router.back();
        else router.replace(signedIn.current ? "/dashboard" : "/login");
      }));
      void keep(App.addListener("appRestoredResult", async (result) => {
        if (result.pluginId === "Vault" && ["exportPublic", "exportOffline"].includes(result.methodName)) {
          if (result.success && result.data?.saved) toastRef.current.success("File saved to the selected destination.");
          else if (!result.success) toastRef.current.error("The save could not finish. Reopen the file and try again.");
          return;
        }
        const camera = result.pluginId === "Camera" && result.methodName === "getPhoto";
        const picker = result.pluginId === "Vault" && result.methodName === "pickFiles";
        if (!camera && !picker) return;
        if (!result.success || !(await nativeVault.sessionInfo().catch(() => null))?.user) return;
        if (camera && result.data?.path) {
          try { await nativeVault.stageCamera({ path: result.data.path }); }
          catch (error) { toastRef.current.error(error instanceof Error ? error.message : "The recovered photo could not be saved. Take it again."); return; }
        }
        if ((camera && result.data?.path) || (picker && result.data?.files?.length)) {
          toastRef.current.info("Recovered file selection. Review saved files in Upload.");
          window.dispatchEvent(new Event("cv_open_upload"));
        }
      }));
      const updateStyle = () => { void StatusBar.setStyle({ style: document.documentElement.classList.contains("dark") ? Style.Dark : Style.Light }).catch(() => undefined); };
      const observer = new MutationObserver(updateStyle);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
      updateStyle();
      listeners.push({ remove: async () => observer.disconnect() });
    }
    return () => {
      disposed = true;
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      window.removeEventListener("cv_cached_data", cached);
      window.removeEventListener("cv_api_live", live);
      window.removeEventListener("cv_logout_pending", pendingLogout);
      for (const listener of listeners) void listener.remove();
    };
  }, [refreshUser, router]);

  useEffect(() => {
    setTransfers([]);
    previousTransfers.current.clear();
    if (!isNative() || !userId) return;
    let disposed = false;
    let listener: PluginListenerHandle | null = null;
    const refresh = () => { void refreshTransfers(); };
    void refreshTransfers();
    void nativeVault.addListener("transfersChanged", refresh).then((handle) => { if (disposed) void handle.remove(); else listener = handle; }).catch(() => undefined);
    window.addEventListener("cv_transfers_changed", refresh);
    return () => { disposed = true; window.removeEventListener("cv_transfers_changed", refresh); void listener?.remove(); };
  }, [userId, refreshTransfers]);

  return <RuntimeContext.Provider value={{ native, device, connected, serverUnavailable, cachedAt, transfers, refreshTransfers }}>{children}</RuntimeContext.Provider>;
}

export function useRuntime() {
  const context = useContext(RuntimeContext);
  if (!context) throw new Error("useRuntime requires RuntimeProvider");
  return context;
}
