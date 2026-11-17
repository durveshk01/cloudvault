import { Capacitor, registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";
import type { FileItem, User } from "@/types";

export interface StagedFile {
  id: string;
  name: string;
  size: number;
  mime: string;
  folder_id?: string | null;
  version_file_id?: string | null;
}

export interface NativeTransfer {
  id: string;
  name: string;
  kind: "upload" | "download";
  state: "ENQUEUED" | "BLOCKED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  completed_bytes: number;
  total_bytes: number;
  created_at: number;
  error?: string;
}

export interface OfflineFile {
  file: FileItem;
  saved_at: number;
}

interface VaultPlugin {
  sessionInfo(): Promise<{ user: User | null; authenticated: boolean; revocation_pending: boolean; on_device: boolean }>;
  retryRevocations(): Promise<{ pending: boolean }>;
  request(options: {
    endpoint: string;
    method: string;
    body?: unknown;
    password?: string;
  }): Promise<{ status: number; data: unknown; cached?: boolean; cached_at?: number }>;
  preview(options: { endpoint: string; fileId?: string; password?: string }): Promise<{ data: string; mime: string }>;
  pickFiles(options: { folder_id?: string | null; version_file_id?: string; multiple?: boolean }): Promise<{ files: StagedFile[] }>;
  prepareCamera(options: { folder_id?: string | null; version_file_id?: string }): Promise<void>;
  stageCamera(options: { path: string }): Promise<{ files: StagedFile[] }>;
  stagedFiles(): Promise<{ files: StagedFile[] }>;
  enqueueUpload(options: { stagingId: string; folder_id?: string | null; version_file_id?: string }): Promise<{ id: string }>;
  enqueueDownload(options: { file: FileItem }): Promise<{ id: string }>;
  transfers(): Promise<{ transfers: NativeTransfer[] }>;
  cancelTransfer(options: { id: string }): Promise<void>;
  retryTransfer(options: { id: string }): Promise<{ id: string }>;
  offlineFiles(): Promise<{ files: OfflineFile[]; used_bytes: number; quota_bytes: number }>;
  removeOffline(options: { id: string }): Promise<void>;
  openOffline(options: { id: string; share?: boolean }): Promise<void>;
  exportOffline(options: { id: string }): Promise<{ saved: boolean }>;
  exportPublic(options: { token: string; filename: string; password?: string }): Promise<{ saved: boolean }>;
  capabilities(): Promise<{ camera: boolean }>;
  addListener(event: "transfersChanged", listener: () => void): Promise<PluginListenerHandle>;
}

export const nativeVault = registerPlugin<VaultPlugin>("Vault");
export const isNative = () => Capacitor.isNativePlatform();
export const isDeviceVault = () => isNative() && process.env.NEXT_PUBLIC_VAULT_MODE !== "cloud";

export function blobFromBase64(data: string, mime: string): Blob {
  const decoded = atob(data);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}
