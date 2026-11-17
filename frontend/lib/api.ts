import {
  ActivityLog,
  BreadcrumbItem,
  BulkActionResult,
  DashboardStats,
  FileItem,
  FileShare,
  FileVersion,
  FolderItem,
  NotificationItem,
  Paginated,
  PublicShareInfo,
  ShareLink,
  StorageUsage,
  Tag,
  User,
} from "@/types";
import { blobFromBase64, isDeviceVault, isNative, nativeVault } from "@/lib/native";
import { readFileResponse, saveBrowserBlob, validateFileBlob } from "@/lib/file-transfer";

const API_BASE = (process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

function errorMessage(data: unknown, fallback: string): string {
  if (!data || typeof data !== "object") return fallback;
  const detail = (data as { detail?: unknown; message?: unknown }).detail ?? (data as { message?: unknown }).message;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((item) => item.msg || "Invalid input").join("; ");
  return fallback;
}

export interface UploadOptions {
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
  requestId?: string;
}

class ApiClient {
  private token: string | null = null;
  private expiresAt = 0;
  private refreshPromise: Promise<void> | null = null;
  private logoutPromise: Promise<void> | null = null;
  private loginPromise: Promise<void> | null = null;
  private authGeneration = 0;

  private signedOut(): boolean { return localStorage.getItem("cv_signed_out") === "1"; }

  private storageChanged = (event: StorageEvent) => {
    if (event.key !== "cv_signed_out") return;
    this.expireSession();
  };

  private requireCurrentSession(generation: number): void {
    if (generation !== this.authGeneration || this.signedOut()) throw new ApiError("Your session changed. Please sign in again.", 401);
  }

  private setToken(token: string | null, expiresIn = 0) {
    this.token = token;
    this.expiresAt = token ? Date.now() + expiresIn * 1000 : 0;
  }

  async initialize(): Promise<void> {
    // Remove credentials left by earlier clients. New browser sessions use only
    // memory + server-issued HttpOnly cookies; native tokens never cross the bridge.
    sessionStorage.removeItem("cv_token");
    if (sessionStorage.getItem("cv_signed_out")) { localStorage.setItem("cv_signed_out", "1"); sessionStorage.removeItem("cv_signed_out"); }
    window.addEventListener("storage", this.storageChanged);
  }

  async getCachedUser(): Promise<User | null> {
    if (this.signedOut()) return null;
    return isNative() ? (await nativeVault.sessionInfo()).user : null;
  }

  private expireSession(): void {
    this.authGeneration += 1;
    this.setToken(null);
    window.dispatchEvent(new Event("cv_session_expired"));
  }

  private refresh(): Promise<void> {
    if (this.signedOut()) return Promise.reject(new ApiError("Please sign in again.", 401));
    if (this.refreshPromise) return this.refreshPromise;
    const generation = this.authGeneration;
    this.refreshPromise = (async () => {
      let response: Response;
      try {
        response = await fetch(`${API_BASE}/api/auth/refresh`, { method: "POST", credentials: "include" });
      } catch {
        throw new ApiError("Unable to connect. Check your connection and try again.", 0);
      }
      if (!response.ok) {
        if (response.status === 401 && generation === this.authGeneration) this.expireSession();
        throw new ApiError(errorMessage(await response.json().catch(() => null), "Please sign in again."), response.status);
      }
      const data = await response.json();
      this.requireCurrentSession(generation);
      this.setToken(data.access_token, data.expires_in);
    })().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  private isAuthenticatedEndpoint(endpoint: string): boolean {
    return !endpoint.startsWith("/api/public/") && !["/api/auth/login", "/api/auth/register", "/api/auth/logout"].includes(endpoint);
  }

  private async fetchResponse(endpoint: string, options: RequestInit = {}, retry = true): Promise<Response> {
    const authenticated = this.isAuthenticatedEndpoint(endpoint);
    const generation = this.authGeneration;
    if (authenticated) {
      if (this.signedOut()) throw new ApiError("Please sign in again.", 401);
      if (!this.token || Date.now() >= this.expiresAt - 30_000) await this.refresh();
      this.requireCurrentSession(generation);
    }
    const headers = new Headers(options.headers);
    if (authenticated && this.token) headers.set("Authorization", `Bearer ${this.token}`);
    if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    let response: Response;
    try {
      response = await fetch(`${API_BASE}${endpoint}`, { ...options, headers, credentials: "include" });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ApiError("Unable to connect. Check your connection and try again.", 0);
    }
    if (authenticated) this.requireCurrentSession(generation);
    if (response.status === 401 && authenticated && retry) {
      await this.refresh();
      return this.fetchResponse(endpoint, options, false);
    }
    if (!response.ok) {
      if (response.status === 401 && authenticated) this.expireSession();
      throw new ApiError(errorMessage(await response.json().catch(() => null), response.statusText || "The request could not be completed."), response.status);
    }
    window.dispatchEvent(new Event("cv_api_live"));
    return response;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    if (isNative()) {
      if (options.body instanceof FormData) throw new ApiError("Use the native file picker to upload files.", 400);
      const generation = this.authGeneration;
      const authenticated = this.isAuthenticatedEndpoint(endpoint);
      if (authenticated) this.requireCurrentSession(generation);
      try {
        const result = await nativeVault.request({
          endpoint,
          method: options.method || "GET",
          body: typeof options.body === "string" ? JSON.parse(options.body) : undefined,
          password: new Headers(options.headers).get("X-Share-Password") || undefined,
        });
        if (authenticated) this.requireCurrentSession(generation);
        if (result.status >= 400) {
          if (result.status === 401 && this.isAuthenticatedEndpoint(endpoint)) this.expireSession();
          throw new ApiError(errorMessage(result.data, "The request could not be completed."), result.status);
        }
        window.dispatchEvent(new CustomEvent(result.cached ? "cv_cached_data" : "cv_api_live", { detail: result.cached_at }));
        return result.data as T;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        const nativeError = error as { message?: string; code?: string };
        if (nativeError.code === "AUTH_REQUIRED" && generation === this.authGeneration && authenticated) this.expireSession();
        throw new ApiError(nativeError.message || "Unable to connect. Check your connection and try again.", nativeError.code === "AUTH_REQUIRED" ? 401 : 0);
      }
    }
    const response = await this.fetchResponse(endpoint, options);
    const contentType = response.headers.get("content-type");
    if (contentType && contentType.includes("application/json")) {
      return (await response.json()) as T;
    }
    return {} as T;
  }

  // --- Auth ---
  async register(data: { full_name: string; email: string; password: string; confirm_password: string }): Promise<User> {
    return this.request<User>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  login(data: { email: string; password: string }): Promise<void> {
    const generation = ++this.authGeneration;
    const previousLogin = this.loginPromise;
    const previousLogout = this.logoutPromise;
    const current = () => { if (generation !== this.authGeneration) throw new ApiError("Your sign-in request was superseded. Try again.", 401); };
    const promise = (async () => {
      await previousLogout;
      await previousLogin?.catch(() => undefined);
      await this.refreshPromise?.catch(() => undefined);
      current();
      if (!isNative() && this.signedOut()) {
        let response: Response;
        try { response = await fetch(`${API_BASE}/api/auth/logout`, { method: "POST", credentials: "include" }); }
        catch { throw new ApiError("Reconnect to finish signing out before signing in again.", 0); }
        if (!response.ok) throw new ApiError("The previous session could not be revoked. Try again.", response.status);
      }
      current();
      const res = await this.request<{ access_token?: string; expires_in: number }>("/api/auth/login", { method: "POST", body: JSON.stringify(data) });
      current();
      if (res.access_token) this.setToken(res.access_token, res.expires_in);
      localStorage.removeItem("cv_signed_out");
      localStorage.removeItem("cv_logout_pending");
    })().finally(() => { if (this.loginPromise === promise) this.loginPromise = null; });
    this.loginPromise = promise;
    return promise;
  }

  logout(): Promise<void> {
    if (this.logoutPromise) return this.logoutPromise;
    const previousLogin = this.loginPromise;
    this.authGeneration += 1;
    this.setToken(null);
    localStorage.setItem("cv_signed_out", "1");
    window.dispatchEvent(new Event("cv_session_expired"));
    const pending = () => { localStorage.setItem("cv_logout_pending", "1"); window.dispatchEvent(new Event("cv_logout_pending")); };
    this.logoutPromise = (async () => {
      await previousLogin?.catch(() => undefined);
      await this.refreshPromise?.catch(() => undefined);
      try {
        const result = await this.request<{ revocation_pending?: boolean }>("/api/auth/logout", { method: "POST" });
        if (result.revocation_pending) pending(); else localStorage.removeItem("cv_logout_pending");
      } catch { pending(); }
      finally { this.setToken(null); }
    })().finally(() => { this.logoutPromise = null; });
    return this.logoutPromise;
  }

  async retryPendingLogout(): Promise<void> {
    if (isNative()) {
      if (!(await nativeVault.retryRevocations()).pending) localStorage.removeItem("cv_logout_pending");
      return;
    }
    if (!localStorage.getItem("cv_logout_pending") || !this.signedOut()) return;
    const response = await fetch(`${API_BASE}/api/auth/logout`, { method: "POST", credentials: "include" });
    if (response.ok) localStorage.removeItem("cv_logout_pending");
  }

  async getMe(): Promise<User> {
    return this.request<User>("/api/auth/me");
  }

  async updateProfile(fullName: string): Promise<User> {
    return this.request<User>("/api/users/me", {
      method: "PATCH",
      body: JSON.stringify({ full_name: fullName }),
    });
  }

  async changePassword(data: { current_password: string; new_password: string; confirm_password: string }): Promise<{ message: string }> {
    const result = await this.request<{ message: string }>("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify(data),
    });
    this.expireSession();
    return result;
  }

  // --- Files ---
  async getFiles(params: {
    folder_id?: string | null;
    category?: string;
    tag?: string;
    search?: string;
    sort_by?: string;
    sort_order?: string;
    page?: number;
    page_size?: number;
  }): Promise<Paginated<FileItem>> {
    const q = new URLSearchParams();
    if (params.folder_id) q.set("folder_id", params.folder_id);
    if (params.category && params.category !== "all") q.set("category", params.category);
    if (params.tag) q.set("tag", params.tag);
    if (params.search) q.set("search", params.search);
    if (params.sort_by) q.set("sort_by", params.sort_by);
    if (params.sort_order) q.set("sort_order", params.sort_order);
    if (params.page) q.set("page", params.page.toString());
    if (params.page_size) q.set("page_size", params.page_size.toString());

    return this.request<Paginated<FileItem>>(`/api/files?${q.toString()}`);
  }

  async uploadFile(file: File, folderId?: string | null, options: UploadOptions = {}): Promise<FileItem> {
    const q = folderId ? `?folder_id=${encodeURIComponent(folderId)}` : "";
    return this.uploadMultipart<FileItem>(`/api/files/upload${q}`, file, options);
  }

  private async uploadMultipart<T>(endpoint: string, file: File, options: UploadOptions, retry = true): Promise<T> {
    const generation = this.authGeneration;
    this.requireCurrentSession(generation);
    if (isNative()) throw new ApiError("Choose files using the Android file picker.", 400);
    if (!file.size || file.size > 100 * 1024 * 1024) throw new ApiError("Choose a nonempty file up to 100 MB.", 400);
    if (options.signal?.aborted) throw new DOMException("Upload cancelled", "AbortError");
    if (!this.token || Date.now() >= this.expiresAt - 30_000) await this.refresh();
    this.requireCurrentSession(generation);
    if (options.signal?.aborted) throw new DOMException("Upload cancelled", "AbortError");
    const requestId = options.requestId || crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const abort = () => xhr.abort();
      const cleanup = () => options.signal?.removeEventListener("abort", abort);
      xhr.open("POST", `${API_BASE}${endpoint}`);
      xhr.withCredentials = true;
      xhr.timeout = 15 * 60 * 1000;
      xhr.setRequestHeader("Idempotency-Key", requestId);
      if (this.token) xhr.setRequestHeader("Authorization", `Bearer ${this.token}`);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) options.onProgress?.(Math.min(100, Math.round(event.loaded * 100 / event.total)));
      };
      xhr.onload = async () => {
        cleanup();
        try { this.requireCurrentSession(generation); } catch (error) { reject(error); return; }
        let data: unknown;
        try { data = JSON.parse(xhr.responseText); } catch { data = null; }
        if (xhr.status === 401 && retry) {
          try {
            await this.refresh();
            resolve(await this.uploadMultipart<T>(endpoint, file, { ...options, requestId }, false));
          } catch (error) { reject(error); }
        } else if (xhr.status >= 200 && xhr.status < 300) {
          window.dispatchEvent(new Event("cv_api_live"));
          resolve(data as T);
        } else {
          if (xhr.status === 401) this.expireSession();
          reject(new ApiError(errorMessage(data, "Upload failed. Try again."), xhr.status));
        }
      };
      xhr.onerror = () => { cleanup(); reject(new ApiError("Connection interrupted. Retry to restart this upload safely.", 0)); };
      xhr.ontimeout = () => { cleanup(); reject(new ApiError("Upload timed out. Retry when your connection is stable.", 0)); };
      xhr.onabort = () => { cleanup(); reject(new DOMException("Upload cancelled", "AbortError")); };
      options.signal?.addEventListener("abort", abort, { once: true });
      const form = new FormData();
      form.append("file", file);
      xhr.send(form);
    });
  }

  async getFile(id: string): Promise<FileItem> {
    return this.request<FileItem>(`/api/files/${id}`);
  }

  async updateFile(id: string, data: { original_filename?: string; is_starred?: boolean; folder_id?: string | null }): Promise<FileItem> {
    return this.request<FileItem>(`/api/files/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  async deleteFile(id: string): Promise<void> {
    await this.request(`/api/files/${id}`, { method: "DELETE" });
  }

  async toggleStar(id: string): Promise<void> {
    await this.request(`/api/files/${id}/favorite`, { method: "POST" });
  }

  async moveFile(id: string, folderId: string | null): Promise<FileItem> {
    return this.request<FileItem>(`/api/files/${id}/move`, {
      method: "POST",
      body: JSON.stringify({ folder_id: folderId }),
    });
  }

  async copyFile(id: string, folderId?: string | null, newName?: string): Promise<FileItem> {
    return this.request<FileItem>(`/api/files/${id}/copy`, {
      method: "POST",
      body: JSON.stringify({ folder_id: folderId, new_name: newName }),
    });
  }

  async bulkAction(fileIds: string[], action: string, folderId?: string | null): Promise<BulkActionResult> {
    return this.request<BulkActionResult>(`/api/files/bulk-action`, {
      method: "POST",
      body: JSON.stringify({ file_ids: fileIds, action, folder_id: folderId }),
    });
  }

  async downloadFile(id: string, filename: string): Promise<void> {
    const generation = this.authGeneration;
    if (isNative()) {
      if (isDeviceVault()) {
        this.requireCurrentSession(generation);
        await nativeVault.exportOffline({ id });
        return;
      }
      const file = await this.getFile(id);
      this.requireCurrentSession(generation);
      await nativeVault.enqueueDownload({ file });
      window.dispatchEvent(new Event("cv_transfers_changed"));
      return;
    }
    const file = await this.getFile(id);
    const response = await this.fetchResponse(`/api/files/${id}/download?direct=true`);
    const blob = await readFileResponse(response, { size: file.size_bytes, checksum: file.checksum, filename: file.original_filename, mime: file.mime_type });
    this.requireCurrentSession(generation);
    saveBrowserBlob(blob, file.original_filename || filename);
  }

  async getPreviewBlob(id: string, signal?: AbortSignal): Promise<Blob> {
    const generation = this.authGeneration;
    this.requireCurrentSession(generation);
    if (isNative()) {
      const result = await nativeVault.preview({ endpoint: `/api/files/${id}/preview`, fileId: id });
      this.requireCurrentSession(generation);
      return validateFileBlob(blobFromBase64(result.data, result.mime));
    }
    const blob = await readFileResponse(await this.fetchResponse(`/api/files/${id}/preview`, { signal }));
    this.requireCurrentSession(generation);
    return blob;
  }

  // --- Versions ---
  async getVersions(fileId: string): Promise<FileVersion[]> {
    return this.request<FileVersion[]>(`/api/files/${fileId}/versions`);
  }

  async uploadNewVersion(fileId: string, file: File, options: UploadOptions = {}): Promise<FileVersion> {
    return this.uploadMultipart<FileVersion>(`/api/files/${fileId}/versions`, file, options);
  }

  async restoreVersion(fileId: string, versionId: string): Promise<FileItem> {
    return this.request<FileItem>(`/api/files/${fileId}/versions/${versionId}/restore`, {
      method: "POST",
    });
  }

  // --- Folders ---
  async getFolders(parentId?: string | null): Promise<FolderItem[]> {
    const q = parentId ? `?parent_id=${encodeURIComponent(parentId)}` : "";
    return this.request<FolderItem[]>(`/api/folders${q}`);
  }

  async createFolder(name: string, parentId?: string | null): Promise<FolderItem> {
    return this.request<FolderItem>("/api/folders", {
      method: "POST",
      body: JSON.stringify({ name, parent_id: parentId }),
    });
  }

  async getFolder(id: string): Promise<FolderItem> {
    return this.request<FolderItem>(`/api/folders/${id}`);
  }

  async getBreadcrumbs(id: string): Promise<BreadcrumbItem[]> {
    return this.request<BreadcrumbItem[]>(`/api/folders/${id}/breadcrumbs`);
  }

  async renameFolder(id: string, name: string): Promise<FolderItem> {
    return this.request<FolderItem>(`/api/folders/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  }

  async moveFolder(id: string, parentId: string | null): Promise<FolderItem> {
    return this.request<FolderItem>(`/api/folders/${id}/move`, {
      method: "POST",
      body: JSON.stringify({ parent_id: parentId }),
    });
  }

  async deleteFolder(id: string): Promise<void> {
    await this.request(`/api/folders/${id}`, { method: "DELETE" });
  }

  // --- Shares ---
  async shareWithUser(fileId: string, email: string, permission: string = "viewer"): Promise<FileShare> {
    return this.request<FileShare>(`/api/files/${fileId}/shares`, {
      method: "POST",
      body: JSON.stringify({ shared_with_email: email, permission }),
    });
  }

  async getFileShares(fileId: string): Promise<FileShare[]> {
    return this.request<FileShare[]>(`/api/files/${fileId}/shares`);
  }

  async revokeShare(shareId: string): Promise<void> {
    await this.request(`/api/shares/${shareId}`, { method: "DELETE" });
  }

  async getSharedWithMe(): Promise<FileShare[]> {
    return this.request<FileShare[]>("/api/shared-with-me");
  }

  async getSharedByMe(): Promise<FileShare[]> {
    return this.request<FileShare[]>("/api/shared-by-me");
  }

  // --- Share Links ---
  async createShareLink(fileId: string, data: { expires_at?: string | null; password?: string | null; max_downloads?: number | null; permission?: string }): Promise<ShareLink> {
    return this.request<ShareLink>(`/api/files/${fileId}/share-links`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async getFileShareLinks(fileId: string): Promise<ShareLink[]> {
    return this.request<ShareLink[]>(`/api/files/${fileId}/share-links`);
  }

  async revokeShareLink(linkId: string): Promise<void> {
    await this.request(`/api/share-links/${linkId}`, { method: "DELETE" });
  }

  async getPublicShareInfo(token: string): Promise<PublicShareInfo> {
    return this.request<PublicShareInfo>(`/api/public/shares/${token}`);
  }

  async verifyPublicLinkPassword(token: string, password: string): Promise<void> {
    await this.request(`/api/public/shares/${token}/verify`, {
      method: "POST",
      body: JSON.stringify({ password }),
    });
  }

  async downloadPublicFile(token: string, filename: string, password?: string): Promise<boolean> {
    if (isNative()) return (await nativeVault.exportPublic({ token, filename, password })).saved;
    const file = await this.getPublicShareInfo(token);
    const response = await this.fetchResponse(`/api/public/shares/${encodeURIComponent(token)}/download`, {
      method: "POST", body: password !== undefined ? JSON.stringify({ password }) : undefined,
    });
    saveBrowserBlob(await readFileResponse(response, { size: file.file_size, filename: file.filename, mime: file.mime_type }), file.filename || filename);
    return true;
  }

  async getPublicPreviewBlob(token: string, password?: string, signal?: AbortSignal): Promise<Blob> {
    const endpoint = `/api/public/shares/${encodeURIComponent(token)}/preview`;
    if (isNative()) {
      const result = await nativeVault.preview({ endpoint, password });
      return validateFileBlob(blobFromBase64(result.data, result.mime));
    }
    return readFileResponse(await this.fetchResponse(endpoint, {
      method: "POST", signal, body: password !== undefined ? JSON.stringify({ password }) : undefined,
    }));
  }

  // --- Dashboard & Storage ---
  async getDashboardStats(): Promise<DashboardStats> {
    return this.request<DashboardStats>("/api/dashboard/stats");
  }

  async getStorageUsage(): Promise<StorageUsage> {
    return this.request<StorageUsage>("/api/storage/usage");
  }

  // --- Trash ---
  async getTrashItems(page: number = 1): Promise<Paginated<FileItem>> {
    return this.request<Paginated<FileItem>>(`/api/trash?page=${page}`);
  }

  async getTrashedFolders(page = 1): Promise<Paginated<FolderItem>> {
    return this.request<Paginated<FolderItem>>(`/api/trash/folders?page=${page}`);
  }

  async restoreFolder(id: string): Promise<{ message: string }> {
    return this.request(`/api/trash/folders/${id}/restore`, { method: "POST" });
  }

  async permanentlyDeleteFolder(id: string): Promise<{ message: string }> {
    return this.request(`/api/trash/folders/${id}/permanent`, { method: "DELETE" });
  }

  async restoreTrashItem(id: string): Promise<void> {
    await this.request(`/api/trash/${id}/restore`, { method: "POST" });
  }

  async permanentlyDeleteItem(id: string): Promise<void> {
    await this.request(`/api/trash/${id}/permanent`, { method: "DELETE" });
  }

  async emptyTrash(): Promise<void> {
    await this.request(`/api/trash/empty`, { method: "DELETE" });
  }

  // --- Starred / Favorites ---
  async getStarredFiles(page: number = 1): Promise<Paginated<FileItem>> {
    return this.request<Paginated<FileItem>>(`/api/favorites?page=${page}`);
  }

  // --- Activity ---
  async getActivity(limit: number = 50): Promise<ActivityLog[]> {
    return this.request<ActivityLog[]>(`/api/activity?limit=${limit}`);
  }

  // --- Notifications ---
  async getNotifications(unreadOnly: boolean = false): Promise<NotificationItem[]> {
    return this.request<NotificationItem[]>(`/api/notifications?unread_only=${unreadOnly}`);
  }

  async markNotificationRead(id: string): Promise<void> {
    await this.request(`/api/notifications/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ is_read: true }),
    });
  }

  async markAllNotificationsRead(): Promise<void> {
    await this.request("/api/notifications/read-all", { method: "POST" });
  }

  // --- Tags ---
  async getTags(): Promise<Tag[]> {
    return this.request<Tag[]>("/api/tags");
  }

  async createTag(name: string): Promise<Tag> {
    return this.request<Tag>("/api/tags", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  }

  async assignTags(fileId: string, tagIds: string[]): Promise<Tag[]> {
    return this.request<Tag[]>(`/api/files/${fileId}/tags`, {
      method: "POST",
      body: JSON.stringify({ tag_ids: tagIds }),
    });
  }
}

export const api = new ApiClient();
