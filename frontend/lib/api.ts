import {
  ActivityLog,
  BreadcrumbItem,
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

const API_BASE = "";

class ApiClient {
  private token: string | null = null;

  setToken(token: string | null) {
    this.token = token;
    if (typeof window !== "undefined") {
      if (token) {
        sessionStorage.setItem("cv_token", token);
      } else {
        sessionStorage.removeItem("cv_token");
      }
    }
  }

  getToken(): string | null {
    if (this.token) return this.token;
    if (typeof window !== "undefined") {
      this.token = sessionStorage.getItem("cv_token");
    }
    return this.token;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const headers = new Headers(options.headers || {});
    const token = this.getToken();

    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }

    if (!(options.body instanceof FormData) && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers,
      credentials: "include",
    });

    if (!response.ok) {
      let errorDetail = "An unexpected error occurred.";
      try {
        const errorData = await response.json();
        errorDetail = errorData.detail || errorData.message || errorDetail;
      } catch {
        errorDetail = response.statusText || errorDetail;
      }
      throw new Error(errorDetail);
    }

    // Check if empty body (e.g. 204 or streaming)
    const contentType = response.headers.get("content-type");
    if (contentType && contentType.includes("application/json")) {
      return (await response.json()) as T;
    }
    return {} as T;
  }

  // --- Auth ---
  async register(data: any): Promise<User> {
    return this.request<User>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async login(data: any): Promise<{ access_token: string; refresh_token: string }> {
    const res = await this.request<{ access_token: string; refresh_token: string }>(
      "/api/auth/login",
      {
        method: "POST",
        body: JSON.stringify(data),
      }
    );
    this.setToken(res.access_token);
    return res;
  }

  async logout(): Promise<void> {
    try {
      await this.request("/api/auth/logout", { method: "POST" });
    } finally {
      this.setToken(null);
    }
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

  async changePassword(data: any): Promise<{ message: string }> {
    return this.request<{ message: string }>("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify(data),
    });
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

  async uploadFile(file: File, folderId?: string | null): Promise<FileItem> {
    const formData = new FormData();
    formData.append("file", file);
    const q = folderId ? `?folder_id=${encodeURIComponent(folderId)}` : "";
    return this.request<FileItem>(`/api/files/upload${q}`, {
      method: "POST",
      body: formData,
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

  async bulkAction(fileIds: string[], action: string, folderId?: string | null): Promise<void> {
    await this.request(`/api/files/bulk-action`, {
      method: "POST",
      body: JSON.stringify({ file_ids: fileIds, action, folder_id: folderId }),
    });
  }

  getFileDownloadUrl(id: string): string {
    return `/api/files/${id}/download`;
  }

  getFilePreviewUrl(id: string): string {
    return `/api/files/${id}/preview`;
  }

  // --- Versions ---
  async getVersions(fileId: string): Promise<FileVersion[]> {
    return this.request<FileVersion[]>(`/api/files/${fileId}/versions`);
  }

  async uploadNewVersion(fileId: string, file: File): Promise<FileVersion> {
    const formData = new FormData();
    formData.append("file", file);
    return this.request<FileVersion>(`/api/files/${fileId}/versions`, {
      method: "POST",
      body: formData,
    });
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

  getPublicDownloadUrl(token: string, password?: string): string {
    const q = password ? `?password=${encodeURIComponent(password)}` : "";
    return `/api/public/shares/${token}/download${q}`;
  }

  getPublicPreviewUrl(token: string, password?: string): string {
    const q = password ? `?password=${encodeURIComponent(password)}` : "";
    return `/api/public/shares/${token}/preview${q}`;
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
