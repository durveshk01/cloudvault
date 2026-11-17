package com.cloudvault.app;

import android.net.Uri;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Native, server-free file engine. Account catalogs are atomically committed in
 * encrypted preferences; every immutable revision is streamed to a Keystore-
 * encrypted private file. No HTTP, Python server, or cloud database is involved.
 */
final class DeviceVault {
    static final long QUOTA_BYTES = 1024L * 1024 * 1024;
    private final VaultStore store;
    private final VaultSession session;

    DeviceVault(VaultStore store, VaultSession session) { this.store = store; this.session = session; }

    static final class Failure extends IOException {
        final int status;
        Failure(int status, String message) { super(message); this.status = status; }
    }

    private static JSONObject cloneObject(JSONObject value) throws IOException {
        try { return new JSONObject(value.toString()); }
        catch (JSONException exception) { throw new IOException("Device metadata could not be read.", exception); }
    }

    private static String now() {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date());
    }

    private static String id() { return UUID.randomUUID().toString(); }
    private static String nullable(JSONObject data, String field) { return VaultSession.string(data, field); }
    private static String query(Uri uri, String key) { String value = uri.getQueryParameter(key); return value == null ? "" : value; }
    private static String lower(String value) { return value.toLowerCase(Locale.ROOT); }

    private JSONObject account(String owner) throws IOException {
        JSONObject account = store.read("device/account/" + VaultStore.uuid(owner));
        if (account == null) throw new VaultSession.AuthException("This device account is unavailable. Create an account or sign in again.");
        return account;
    }

    private JSONObject findAccount(String email) throws IOException {
        for (String key : store.names("device/account/")) {
            JSONObject account = store.read(key);
            if (account != null && email.equals(account.optJSONObject("user").optString("email"))) return account;
        }
        return null;
    }

    private JSONObject catalog(String owner) throws IOException {
        JSONObject catalog = store.read("device/catalog/" + VaultStore.uuid(owner));
        return catalog == null ? VaultSession.object("files", new JSONArray(), "folders", new JSONArray(), "tags", new JSONArray(),
            "shares", new JSONArray(), "activity", new JSONArray(), "notifications", new JSONArray(), "garbage", new JSONArray()) : catalog;
    }

    private long used(JSONObject catalog) {
        long bytes = 0;
        Set<String> counted = new HashSet<>();
        for (JSONObject file : objects(catalog.optJSONArray("files"))) {
            for (JSONObject version : objects(file.optJSONArray("_versions"))) {
                if (counted.add(version.optString("storage_key"))) bytes += version.optLong("size_bytes");
            }
        }
        return bytes;
    }

    JSONObject profile() throws IOException {
        JSONObject current = store.read("device/session");
        if (current == null) return null;
        String owner = current.optJSONObject("user").optString("id");
        JSONObject user = cloneObject(account(owner).optJSONObject("user"));
        VaultSession.put(user, "storage_used_bytes", used(catalog(owner)));
        return user;
    }

    private void save(String owner, JSONObject catalog) throws IOException {
        store.write("device/catalog/" + VaultStore.uuid(owner), catalog);
        // A committed deletion leaves durable garbage receipts. Cleanup can be
        // retried after process death without deleting a live file or revision.
        JSONArray remaining = new JSONArray();
        JSONArray garbage = catalog.optJSONArray("garbage");
        if (garbage == null || garbage.length() == 0) return;
        for (int index = 0; index < garbage.length(); index++) {
            String blob = garbage.optString(index);
            try {
                File content = store.file("library", owner, blob);
                if (content.exists() && !content.delete()) remaining.put(blob);
            } catch (IOException exception) { remaining.put(blob); }
        }
        VaultSession.put(catalog, "garbage", remaining);
        // The catalog is already committed. A failed receipt cleanup must never
        // make an importer roll back content that the committed catalog uses.
        try { store.write("device/catalog/" + owner, catalog); }
        catch (IOException ignored) { /* The original receipts remain safe to retry. */ }
    }

    private static List<JSONObject> objects(JSONArray array) {
        List<JSONObject> values = new ArrayList<>();
        if (array != null) for (int index = 0; index < array.length(); index++) {
            JSONObject object = array.optJSONObject(index);
            if (object != null) values.add(object);
        }
        return values;
    }

    private static JSONObject find(JSONArray values, String id) {
        for (JSONObject value : objects(values)) if (id.equals(value.optString("id"))) return value;
        return null;
    }

    private static void remove(JSONArray values, String id) {
        for (int index = values.length() - 1; index >= 0; index--) {
            if (id.equals(values.optJSONObject(index).optString("id"))) values.remove(index);
        }
    }

    private void log(JSONObject catalog, String owner, String action, String type, String resourceId, String name) {
        JSONArray activity = catalog.optJSONArray("activity");
        activity.put(VaultSession.object("id", id(), "user_id", owner, "action", action, "resource_type", type,
            "resource_id", resourceId, "resource_name", name, "details", null, "created_at", now()));
        while (activity.length() > 300) activity.remove(0);
    }

    private JSONObject register(JSONObject body) throws IOException {
        String name = body.optString("full_name").trim();
        String email = lower(body.optString("email").trim());
        if (name.length() < 2 || name.length() > 100) throw new Failure(400, "Enter a name between 2 and 100 characters.");
        if (email.length() > 254 || !email.matches("[^\\s@]+@[^\\s@]+\\.[^\\s@]+")) throw new Failure(400, "Enter a valid email address.");
        DevicePasswords.validate(body.optString("password"), body.optString("confirm_password"));
        if (findAccount(email) != null) throw new Failure(400, "An account with this email already exists on this device.");
        String owner = id();
        JSONObject user = VaultSession.object("id", owner, "email", email, "full_name", name, "storage_quota_bytes", QUOTA_BYTES,
            "storage_used_bytes", 0, "is_active", true, "created_at", now());
        JSONObject catalog = catalog(owner);
        log(catalog, owner, "account_created", "user", owner, email);
        save(owner, catalog);
        store.write("device/account/" + owner, VaultSession.object("user", user, "password", DevicePasswords.hash(body.optString("password"))));
        return user;
    }

    private JSONObject login(JSONObject body) throws IOException {
        JSONObject account = findAccount(lower(body.optString("email").trim()));
        if (account != null && account.optLong("locked_until") > System.currentTimeMillis()) throw new Failure(429, "Too many attempts. Wait 30 seconds and try again.");
        if (!DevicePasswords.verify(body.optString("password"), account == null ? null : account.optJSONObject("password"))) {
            if (account != null) {
                int attempts = account.optInt("failed_attempts") + 1;
                VaultSession.put(account, "failed_attempts", attempts >= 5 ? 0 : attempts);
                VaultSession.put(account, "locked_until", attempts >= 5 ? System.currentTimeMillis() + 30_000 : 0);
                store.write("device/account/" + account.optJSONObject("user").optString("id"), account);
            }
            throw new Failure(401, "Invalid email or password. Use an account created on this device.");
        }
        String owner = account.optJSONObject("user").optString("id");
        VaultSession.put(account, "failed_attempts", 0);
        VaultSession.put(account, "locked_until", 0);
        store.write("device/account/" + owner, account);
        session.clearLocal();
        store.write("device/session", VaultSession.object("sid", id(), "api_url", "", "user", account.optJSONObject("user")));
        JSONObject catalog = catalog(owner);
        log(catalog, owner, "login", "user", owner, account.optJSONObject("user").optString("email"));
        save(owner, catalog);
        return VaultSession.object("expires_in", 0);
    }

    VaultSession.Reply request(String endpoint, String method, Object payload) throws IOException {
        synchronized (session) {
            try { return new VaultSession.Reply(200, route(endpoint, method, payload instanceof JSONObject ? (JSONObject) payload : new JSONObject())); }
            catch (Failure failure) { return new VaultSession.Reply(failure.status, VaultSession.object("detail", failure.getMessage())); }
            catch (IllegalArgumentException exception) { return new VaultSession.Reply(400, VaultSession.object("detail", "Invalid file or folder identifier.")); }
        }
    }

    private Object route(String endpoint, String method, JSONObject body) throws IOException {
        String path = VaultHttp.path(endpoint);
        if (method == null || !method.matches("GET|POST|PATCH|DELETE")) throw new Failure(405, "Unsupported operation.");
        Uri uri = Uri.parse(endpoint);
        if (path.equals("/api/auth/register") && method.equals("POST")) return register(body);
        if (path.equals("/api/auth/login") && method.equals("POST")) return login(body);
        if (path.equals("/api/auth/logout") && method.equals("POST")) { session.clearLocal(); return VaultSession.object("revocation_pending", false); }
        if (path.startsWith("/api/public/")) throw new Failure(400, "This on-device vault uses Android file sharing. Internet share links belong to the web application.");
        String owner = session.account();
        JSONObject catalog = catalog(owner);
        if (path.equals("/api/auth/me") && method.equals("GET")) return profile();
        if (path.equals("/api/auth/refresh")) throw new Failure(403, "Device sessions do not use network tokens.");
        if (path.equals("/api/users/me") && method.equals("PATCH")) {
            String name = body.optString("full_name").trim();
            if (name.length() < 2 || name.length() > 100) throw new Failure(400, "Enter a name between 2 and 100 characters.");
            JSONObject account = account(owner);
            VaultSession.put(account.optJSONObject("user"), "full_name", name);
            store.write("device/account/" + owner, account);
            log(catalog, owner, "profile_updated", "user", owner, name); save(owner, catalog);
            return profile();
        }
        if (path.equals("/api/auth/change-password") && method.equals("POST")) {
            JSONObject account = account(owner);
            if (!DevicePasswords.verify(body.optString("current_password"), account.optJSONObject("password"))) throw new Failure(400, "Current password is incorrect.");
            DevicePasswords.validate(body.optString("new_password"), body.optString("confirm_password"));
            VaultSession.put(account, "password", DevicePasswords.hash(body.optString("new_password")));
            store.write("device/account/" + owner, account);
            log(catalog, owner, "password_changed", "user", owner, null); save(owner, catalog);
            session.clearLocal();
            return VaultSession.object("message", "Password updated. Sign in again; your encrypted files are preserved.");
        }
        if (path.equals("/api/files") && method.equals("GET")) return listFiles(catalog, uri, false, false);
        if (path.equals("/api/favorites") && method.equals("GET")) return listFiles(catalog, uri, true, false);
        if (path.equals("/api/trash") && method.equals("GET")) return listFiles(catalog, uri, false, true);
        if (path.equals("/api/files/bulk-action") && method.equals("POST")) return bulk(catalog, owner, body);
        if (path.equals("/api/folders")) {
            if (method.equals("GET")) return listFolders(catalog, query(uri, "parent_id"), false);
            if (method.equals("POST")) return createFolder(catalog, owner, body);
        }
        if (path.equals("/api/trash/folders") && method.equals("GET")) return paginate(objects(listFolders(catalog, "", true)), uri);
        if (path.equals("/api/trash/empty") && method.equals("DELETE")) {
            for (JSONObject file : new ArrayList<>(objects(catalog.optJSONArray("files")))) if (file.optBoolean("is_trashed")) purgeFile(catalog, file);
            for (JSONObject folder : new ArrayList<>(objects(catalog.optJSONArray("folders")))) if (folder.optBoolean("is_trashed")) {
                for (JSONObject live : objects(catalog.optJSONArray("folders"))) if (!live.optBoolean("is_trashed") && folder.optString("id").equals(nullable(live, "parent_id"))) VaultSession.put(live, "parent_id", null);
                remove(catalog.optJSONArray("folders"), folder.optString("id"));
            }
            log(catalog, owner, "trash_emptied", "trash", null, null); save(owner, catalog);
            return VaultSession.object("message", "Trash emptied.");
        }
        if (path.equals("/api/dashboard/stats") && method.equals("GET")) return dashboard(catalog, owner);
        if (path.equals("/api/storage/usage") && method.equals("GET")) {
            long used = used(catalog);
            return VaultSession.object("quota_bytes", QUOTA_BYTES, "used_bytes", used,
                "available_bytes", Math.min(Math.max(0, QUOTA_BYTES - used), Math.max(0, store.context.getNoBackupFilesDir().getUsableSpace() - 1024 * 1024)),
                "used_percentage", Math.round(used * 10000.0 / QUOTA_BYTES) / 100.0);
        }
        if (path.equals("/api/activity") && method.equals("GET")) return recent(catalog.optJSONArray("activity"), number(query(uri, "limit"), 50, 300));
        if (path.equals("/api/notifications") && method.equals("GET")) {
            List<JSONObject> notifications = objects(catalog.optJSONArray("notifications"));
            if (query(uri, "unread_only").equals("true")) notifications.removeIf(value -> value.optBoolean("is_read"));
            notifications.sort(Comparator.comparing((JSONObject value) -> value.optString("created_at")).reversed());
            return new JSONArray(notifications);
        }
        if (path.equals("/api/notifications/read-all") && method.equals("POST")) {
            for (JSONObject notification : objects(catalog.optJSONArray("notifications"))) VaultSession.put(notification, "is_read", true);
            save(owner, catalog); return new JSONObject();
        }
        if (path.equals("/api/tags")) {
            if (method.equals("GET")) return catalog.optJSONArray("tags");
            if (method.equals("POST")) {
                String name = body.optString("name").trim();
                if (name.isEmpty() || name.length() > 50) throw new Failure(400, "Use a tag name between 1 and 50 characters.");
                for (JSONObject tag : objects(catalog.optJSONArray("tags"))) if (name.equals(tag.optString("name"))) return tag;
                JSONObject tag = VaultSession.object("id", id(), "name", name);
                catalog.optJSONArray("tags").put(tag); save(owner, catalog); return tag;
            }
        }
        if ((path.equals("/api/shared-with-me") || path.equals("/api/shared-by-me")) && method.equals("GET")) return shares(owner, path.endsWith("with-me"));
        String[] parts = path.split("/");
        if (parts.length >= 4 && parts[2].equals("files")) return fileRoute(parts, method, body);
        if (parts.length >= 4 && parts[2].equals("folders")) return folderRoute(catalog, owner, parts, method, body);
        if (parts.length >= 4 && parts[2].equals("trash")) return trashRoute(catalog, owner, parts, method);
        if (parts.length == 4 && parts[2].equals("notifications") && method.equals("PATCH")) {
            JSONObject notification = find(catalog.optJSONArray("notifications"), VaultStore.uuid(parts[3]));
            if (notification == null) throw new Failure(404, "Notification not found.");
            VaultSession.put(notification, "is_read", true); save(owner, catalog); return notification;
        }
        if (parts.length == 4 && parts[2].equals("shares") && method.equals("DELETE")) {
            String shareId = VaultStore.uuid(parts[3]);
            JSONObject share = find(catalog.optJSONArray("shares"), shareId);
            if (share == null) throw new Failure(404, "Share record not found.");
            remove(catalog.optJSONArray("shares"), shareId); save(owner, catalog); return new JSONObject();
        }
        throw new Failure(404, "This operation is unavailable in the device vault.");
    }

    private static int number(String value, int fallback, int maximum) throws Failure {
        if (value.isEmpty()) return fallback;
        try {
            int result = Integer.parseInt(value);
            if (result < 1 || result > maximum) throw new NumberFormatException();
            return result;
        } catch (NumberFormatException exception) { throw new Failure(400, "Invalid page size or page number."); }
    }

    private static JSONObject publicFile(JSONObject file) throws IOException {
        JSONObject result = cloneObject(file);
        result.remove("_versions"); result.remove("_trash_batch_id");
        return result;
    }

    private static JSONArray recent(JSONArray array, int limit) {
        List<JSONObject> values = objects(array);
        values.sort(Comparator.comparing((JSONObject value) -> value.optString("created_at")).reversed());
        return new JSONArray(values.subList(0, Math.min(limit, values.size())));
    }

    private static JSONObject paginate(List<JSONObject> values, Uri uri) throws Failure {
        int page = number(query(uri, "page"), 1, 1_000_000);
        int size = number(query(uri, "page_size"), 50, 100);
        int start = Math.min(values.size(), (page - 1) * size);
        return VaultSession.object("items", new JSONArray(values.subList(start, Math.min(values.size(), start + size))),
            "total", values.size(), "page", page, "page_size", size, "total_pages", Math.max(1, (values.size() + size - 1) / size));
    }

    private static String category(JSONObject file) {
        String name = lower(file.optString("original_filename"));
        String extension = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1) : "";
        if (Set.of("jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "avif", "heic", "ico", "tiff").contains(extension)) return "image";
        if (Set.of("mp4", "mkv", "mov", "avi", "webm", "m4v", "3gp").contains(extension)) return "video";
        if (Set.of("mp3", "wav", "ogg", "flac", "aac", "m4a", "opus").contains(extension)) return "audio";
        if (Set.of("zip", "rar", "7z", "tar", "gz", "bz2", "xz").contains(extension)) return "archive";
        if (Set.of("js", "jsx", "ts", "tsx", "py", "java", "c", "cpp", "h", "css", "html", "json", "xml", "yaml", "yml", "sql", "sh").contains(extension)) return "code";
        if (Set.of("pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv", "rtf", "odt").contains(extension)) return "document";
        String mime = file.optString("mime_type");
        for (String type : List.of("image", "audio", "video")) if (mime.startsWith(type + "/")) return type;
        return mime.startsWith("text/") ? "document" : "other";
    }

    private Object listFiles(JSONObject catalog, Uri uri, boolean starred, boolean trash) throws IOException {
        String folder = query(uri, "folder_id");
        String search = lower(query(uri, "search").trim());
        String category = query(uri, "category");
        String tag = query(uri, "tag");
        if (!folder.isEmpty()) folder(catalog, folder, false);
        List<JSONObject> files = new ArrayList<>();
        for (JSONObject file : objects(catalog.optJSONArray("files"))) {
            if (file.optBoolean("is_trashed") != trash || (starred && !file.optBoolean("is_starred"))) continue;
            if (search.isEmpty() && category.isEmpty() && !starred && !trash && !folder.equals(nullable(file, "folder_id"))) continue;
            if (!search.isEmpty() && !lower(file.optString("original_filename")).contains(search) && !lower(file.optString("mime_type")).contains(search)) continue;
            if (!category.isEmpty() && !category.equals("all") && !category.equals(category(file))) continue;
            if (!tag.isEmpty() && objects(file.optJSONArray("tags")).stream().noneMatch(value -> tag.equals(value.optString("name")))) continue;
            files.add(publicFile(file));
        }
        String sort = query(uri, "sort_by");
        String field = Set.of("original_filename", "size_bytes", "created_at", "updated_at").contains(sort) ? sort : "created_at";
        Comparator<JSONObject> order = field.equals("size_bytes") ? Comparator.comparingLong(value -> value.optLong(field)) : Comparator.comparing(value -> lower(value.optString(field)));
        if (!query(uri, "sort_order").equals("asc")) order = order.reversed();
        files.sort(order.thenComparing(value -> value.optString("id")));
        return paginate(files, uri);
    }

    private JSONObject folder(JSONObject catalog, String folderId, boolean trash) throws IOException {
        JSONObject folder = find(catalog.optJSONArray("folders"), VaultStore.uuid(folderId));
        if (folder == null || (!trash && folder.optBoolean("is_trashed"))) throw new Failure(404, "Folder not found.");
        return folder;
    }

    private JSONArray listFolders(JSONObject catalog, String parent, boolean trash) throws IOException {
        if (!parent.isEmpty()) folder(catalog, parent, false);
        List<JSONObject> folders = new ArrayList<>();
        for (JSONObject folder : objects(catalog.optJSONArray("folders"))) {
            if (folder.optBoolean("is_trashed") != trash || (!trash && !parent.equals(nullable(folder, "parent_id")))) continue;
            JSONObject result = cloneObject(folder); result.remove("_trash_batch_id");
            String id = folder.optString("id");
            VaultSession.put(result, "file_count", objects(catalog.optJSONArray("files")).stream().filter(file -> !file.optBoolean("is_trashed") && id.equals(nullable(file, "folder_id"))).count());
            VaultSession.put(result, "subfolder_count", objects(catalog.optJSONArray("folders")).stream().filter(child -> !child.optBoolean("is_trashed") && id.equals(nullable(child, "parent_id"))).count());
            folders.add(result);
        }
        folders.sort(Comparator.comparing(value -> lower(value.optString("name"))));
        return new JSONArray(folders);
    }

    private void checkFolderName(JSONObject catalog, String name, String parent, String except) throws Failure {
        if (name.isEmpty() || name.length() > 255 || name.matches("(?s).*[\\p{Cntrl}\\\\/].*") || name.equals(".") || name.equals("..")) throw new Failure(400, "Enter a valid folder name up to 255 characters.");
        for (JSONObject folder : objects(catalog.optJSONArray("folders"))) {
            if (!folder.optBoolean("is_trashed") && !folder.optString("id").equals(except) && parent.equals(nullable(folder, "parent_id")) && name.equals(folder.optString("name"))) throw new Failure(400, "A folder with this name already exists here.");
        }
    }

    private JSONObject createFolder(JSONObject catalog, String owner, JSONObject body) throws IOException {
        String name = body.optString("name").trim();
        String parent = nullable(body, "parent_id");
        if (!parent.isEmpty()) folder(catalog, parent, false);
        checkFolderName(catalog, name, parent, "");
        if (ancestors(catalog, parent).size() >= 50) throw new Failure(400, "Folders support up to 50 levels.");
        JSONObject folder = VaultSession.object("id", id(), "owner_id", owner, "parent_id", parent.isEmpty() ? null : parent, "name", name,
            "is_trashed", false, "trashed_at", null, "created_at", now(), "updated_at", now(), "file_count", 0, "subfolder_count", 0);
        catalog.optJSONArray("folders").put(folder);
        log(catalog, owner, "folder_created", "folder", folder.optString("id"), name); save(owner, catalog);
        return folder;
    }

    private List<JSONObject> ancestors(JSONObject catalog, String folderId) throws IOException {
        List<JSONObject> chain = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        while (!folderId.isEmpty()) {
            if (!seen.add(folderId) || chain.size() >= 50) throw new Failure(400, "Invalid or excessively deep folder hierarchy.");
            JSONObject folder = folder(catalog, folderId, true);
            chain.add(folder); folderId = nullable(folder, "parent_id");
        }
        return chain;
    }

    private Set<String> descendants(JSONObject catalog, String root) {
        Set<String> ids = new HashSet<>(); ids.add(root);
        boolean changed;
        do {
            changed = false;
            for (JSONObject folder : objects(catalog.optJSONArray("folders"))) if (ids.contains(nullable(folder, "parent_id")) && ids.add(folder.optString("id"))) changed = true;
        } while (changed);
        return ids;
    }

    private void trash(JSONObject record, String batch) {
        VaultSession.put(record, "is_trashed", true); VaultSession.put(record, "trashed_at", now());
        VaultSession.put(record, "_trash_batch_id", batch); VaultSession.put(record, "updated_at", now());
    }

    private void restore(JSONObject record) {
        VaultSession.put(record, "is_trashed", false); VaultSession.put(record, "trashed_at", null);
        record.remove("_trash_batch_id"); VaultSession.put(record, "updated_at", now());
    }

    private Object folderRoute(JSONObject catalog, String owner, String[] parts, String method, JSONObject body) throws IOException {
        JSONObject folder = folder(catalog, parts[3], false);
        String folderId = folder.optString("id");
        if (parts.length == 4 && method.equals("GET")) return folder;
        if (parts.length == 5 && parts[4].equals("breadcrumbs") && method.equals("GET")) {
            List<JSONObject> chain = ancestors(catalog, folderId);
            JSONArray result = new JSONArray();
            for (int index = chain.size() - 1; index >= 0; index--) result.put(VaultSession.object("id", chain.get(index).optString("id"), "name", chain.get(index).optString("name")));
            return result;
        }
        if (parts.length == 4 && method.equals("PATCH")) {
            String name = body.optString("name").trim(); checkFolderName(catalog, name, nullable(folder, "parent_id"), folderId);
            VaultSession.put(folder, "name", name); VaultSession.put(folder, "updated_at", now());
            log(catalog, owner, "folder_renamed", "folder", folderId, name); save(owner, catalog); return folder;
        }
        if (parts.length == 5 && parts[4].equals("move") && method.equals("POST")) {
            String parent = nullable(body, "parent_id");
            for (JSONObject ancestor : ancestors(catalog, parent)) if (ancestor.optString("id").equals(folderId)) throw new Failure(400, "Cannot move a folder into itself or a descendant.");
            if (ancestors(catalog, parent).size() + subtreeDepth(catalog, folderId) > 50) throw new Failure(400, "Folders support up to 50 levels.");
            if (!parent.isEmpty()) folder(catalog, parent, false);
            checkFolderName(catalog, folder.optString("name"), parent, folderId);
            VaultSession.put(folder, "parent_id", parent.isEmpty() ? null : parent); VaultSession.put(folder, "updated_at", now());
            log(catalog, owner, "folder_moved", "folder", folderId, folder.optString("name")); save(owner, catalog); return folder;
        }
        if (parts.length == 4 && method.equals("DELETE")) {
            String batch = id(); Set<String> ids = descendants(catalog, folderId);
            for (JSONObject child : objects(catalog.optJSONArray("folders"))) if (ids.contains(child.optString("id")) && !child.optBoolean("is_trashed")) trash(child, batch);
            for (JSONObject file : objects(catalog.optJSONArray("files"))) if (ids.contains(nullable(file, "folder_id")) && !file.optBoolean("is_trashed")) trash(file, batch);
            log(catalog, owner, "folder_deleted", "folder", folderId, folder.optString("name")); save(owner, catalog); return new JSONObject();
        }
        throw new Failure(405, "Unsupported folder operation.");
    }

    private int subtreeDepth(JSONObject catalog, String root) throws IOException {
        int depth = 1;
        for (String descendant : descendants(catalog, root)) {
            int current = 0;
            for (JSONObject ancestor : ancestors(catalog, descendant)) { current++; if (root.equals(ancestor.optString("id"))) break; }
            depth = Math.max(depth, current);
        }
        return depth;
    }

    private void purgeFile(JSONObject catalog, JSONObject file) {
        for (JSONObject version : objects(file.optJSONArray("_versions"))) catalog.optJSONArray("garbage").put(version.optString("storage_key"));
        String fileId = file.optString("id");
        remove(catalog.optJSONArray("files"), fileId);
        for (JSONObject share : new ArrayList<>(objects(catalog.optJSONArray("shares")))) if (fileId.equals(share.optString("file_id"))) remove(catalog.optJSONArray("shares"), share.optString("id"));
    }

    private Object trashRoute(JSONObject catalog, String owner, String[] parts, String method) throws IOException {
        boolean isFolder = parts[3].equals("folders");
        int index = isFolder ? 4 : 3;
        if (parts.length != index + 2) throw new Failure(404, "Trash item not found.");
        String resourceId = VaultStore.uuid(parts[index]);
        JSONObject record = find(catalog.optJSONArray(isFolder ? "folders" : "files"), resourceId);
        if (record == null || !record.optBoolean("is_trashed")) throw new Failure(404, "Item not found in trash.");
        String action = parts[index + 1];
        Set<String> ids = isFolder ? descendants(catalog, resourceId) : Set.of(resourceId);
        if (action.equals("restore") && method.equals("POST")) {
            String parentField = isFolder ? "parent_id" : "folder_id";
            JSONObject parent = find(catalog.optJSONArray("folders"), nullable(record, parentField));
            if (parent == null || parent.optBoolean("is_trashed")) VaultSession.put(record, parentField, null);
            if (isFolder) {
                String batch = record.optString("_trash_batch_id");
                String name = record.optString("name"); int suffix = 0;
                while (true) {
                    try { checkFolderName(catalog, record.optString("name"), nullable(record, "parent_id"), resourceId); break; }
                    catch (Failure conflict) { VaultSession.put(record, "name", name.substring(0, Math.min(230, name.length())) + " (restored " + (++suffix) + ")"); }
                }
                for (JSONObject child : objects(catalog.optJSONArray("folders"))) if (ids.contains(child.optString("id")) && child.optBoolean("is_trashed") && batch.equals(child.optString("_trash_batch_id"))) restore(child);
                for (JSONObject file : objects(catalog.optJSONArray("files"))) if (ids.contains(nullable(file, "folder_id")) && file.optBoolean("is_trashed") && batch.equals(file.optString("_trash_batch_id"))) restore(file);
            } else restore(record);
            log(catalog, owner, isFolder ? "folder_restored" : "file_restored", isFolder ? "folder" : "file", resourceId, record.optString(isFolder ? "name" : "original_filename"));
            save(owner, catalog); return VaultSession.object("message", "Restored.");
        }
        if (action.equals("permanent") && method.equals("DELETE")) {
            if (isFolder) {
                for (JSONObject file : objects(catalog.optJSONArray("files"))) if (ids.contains(nullable(file, "folder_id")) && !file.optBoolean("is_trashed")) throw new Failure(409, "Move restored files out before deleting this folder.");
                for (JSONObject child : objects(catalog.optJSONArray("folders"))) if (ids.contains(child.optString("id")) && !child.optBoolean("is_trashed")) throw new Failure(409, "Move restored subfolders out before deleting this folder.");
                for (JSONObject file : new ArrayList<>(objects(catalog.optJSONArray("files")))) if (ids.contains(nullable(file, "folder_id"))) purgeFile(catalog, file);
                for (String folderId : ids) remove(catalog.optJSONArray("folders"), folderId);
            } else purgeFile(catalog, record);
            log(catalog, owner, isFolder ? "folder_permanently_deleted" : "file_permanently_deleted", isFolder ? "folder" : "file", resourceId, record.optString(isFolder ? "name" : "original_filename"));
            save(owner, catalog); return VaultSession.object("message", "Permanently deleted.");
        }
        throw new Failure(405, "Unsupported trash operation.");
    }

    private static final class Located {
        final String owner;
        final JSONObject catalog;
        final JSONObject file;
        final String permission;
        Located(String owner, JSONObject catalog, JSONObject file, String permission) {
            this.owner = owner; this.catalog = catalog; this.file = file; this.permission = permission;
        }
    }

    private Located locate(String fileId) throws IOException {
        fileId = VaultStore.uuid(fileId);
        String user = session.account();
        JSONObject own = catalog(user);
        JSONObject file = find(own.optJSONArray("files"), fileId);
        if (file != null) return new Located(user, own, file, "owner");
        for (String key : store.names("device/catalog/")) {
            String owner = key.substring("device/catalog/".length());
            if (user.equals(owner)) continue;
            JSONObject catalog = catalog(owner);
            JSONObject candidate = find(catalog.optJSONArray("files"), fileId);
            if (candidate == null || candidate.optBoolean("is_trashed")) continue;
            for (JSONObject share : objects(catalog.optJSONArray("shares"))) if (user.equals(share.optString("shared_with")) && fileId.equals(share.optString("file_id"))) return new Located(owner, catalog, candidate, share.optString("permission"));
        }
        throw new Failure(404, "File is unavailable or access has been revoked.");
    }

    private static void editable(Located located, boolean ownerOnly) throws Failure {
        if ((ownerOnly && !located.permission.equals("owner")) || located.permission.equals("viewer")) throw new Failure(403, "You do not have permission to change this file.");
        if (located.file.optBoolean("is_trashed")) throw new Failure(409, "Restore this file before changing it.");
    }

    JSONObject file(String fileId) throws IOException {
        synchronized (session) {
            Located located = locate(fileId);
            if (located.file.optBoolean("is_trashed")) throw new Failure(404, "Restore this file before opening it.");
            return publicFile(located.file);
        }
    }

    InputStream open(String fileId) throws IOException {
        synchronized (session) {
            Located located = locate(fileId);
            if (located.file.optBoolean("is_trashed")) throw new Failure(404, "Restore this file before opening it.");
            return store.open("library", located.owner, located.file.optString("storage_key"));
        }
    }

    JSONArray files() throws IOException {
        synchronized (session) {
            String owner = session.account();
            List<JSONObject> files = new ArrayList<>();
            for (JSONObject file : objects(catalog(owner).optJSONArray("files"))) if (!file.optBoolean("is_trashed")) files.add(publicFile(file));
            for (JSONObject share : objects(shares(owner, true))) files.add(share.optJSONObject("file"));
            return new JSONArray(files);
        }
    }

    private Object fileRoute(String[] parts, String method, JSONObject body) throws IOException {
        Located located = locate(parts[3]);
        JSONObject file = located.file;
        String fileId = file.optString("id");
        String user = session.account();
        if (parts.length == 4 && method.equals("GET")) return publicFile(file);
        if (parts.length == 5 && parts[4].equals("versions") && method.equals("GET")) {
            List<JSONObject> versions = objects(file.optJSONArray("_versions"));
            versions.sort(Comparator.comparingInt((JSONObject value) -> value.optInt("version_number")).reversed());
            return new JSONArray(versions);
        }
        if (parts.length == 5 && parts[4].equals("shares") && method.equals("GET")) {
            if (!located.permission.equals("owner")) throw new Failure(403, "Only the owner can manage sharing.");
            List<JSONObject> shares = objects(shares(user, false));
            shares.removeIf(value -> !fileId.equals(value.optString("file_id"))); return new JSONArray(shares);
        }
        if (parts.length == 5 && parts[4].equals("share-links")) {
            if (method.equals("GET")) return new JSONArray();
            throw new Failure(400, "Use Android sharing to send this device file.");
        }
        if (parts.length == 5 && parts[4].equals("copy") && method.equals("POST")) return copyFile(located, body);
        editable(located, parts.length == 4 && method.equals("DELETE") || parts.length == 5 && (parts[4].equals("favorite") || parts[4].equals("tags") || parts[4].equals("shares")));
        String action = "";
        if (parts.length == 4 && method.equals("PATCH")) {
            if (body.has("original_filename")) {
                String name = body.optString("original_filename").trim();
                if (name.isEmpty() || name.length() > 255) throw new Failure(400, "Enter a filename up to 255 characters.");
                VaultSession.put(file, "original_filename", VaultStore.safeName(name)); action = "file_renamed";
            }
            if (body.has("folder_id")) {
                String folder = nullable(body, "folder_id");
                if (!folder.isEmpty()) folder(located.catalog, folder, false);
                VaultSession.put(file, "folder_id", folder.isEmpty() ? null : folder); action = "file_moved";
            }
            if (body.has("is_starred")) {
                if (!located.permission.equals("owner")) throw new Failure(403, "Only the owner can change favorites.");
                VaultSession.put(file, "is_starred", body.optBoolean("is_starred")); action = "file_starred";
            }
        } else if (parts.length == 4 && method.equals("DELETE")) {
            trash(file, id()); action = "file_deleted";
        } else if (parts.length == 5 && parts[4].equals("favorite") && method.equals("POST")) {
            VaultSession.put(file, "is_starred", !file.optBoolean("is_starred")); action = "file_starred";
        } else if (parts.length == 5 && parts[4].equals("move") && method.equals("POST")) {
            String folder = nullable(body, "folder_id");
            if (!folder.isEmpty()) folder(located.catalog, folder, false);
            VaultSession.put(file, "folder_id", folder.isEmpty() ? null : folder); action = "file_moved";
        } else if (parts.length == 7 && parts[4].equals("versions") && parts[6].equals("restore") && method.equals("POST")) {
            JSONObject version = find(file.optJSONArray("_versions"), VaultStore.uuid(parts[5]));
            if (version == null) throw new Failure(404, "Version not found.");
            // Authenticate the encrypted content before changing the active pointer.
            verifyContent(located.owner, version.optString("storage_key"), version.optLong("size_bytes"), version.optString("checksum"), null);
            activate(file, version); action = "file_version_restored";
        } else if (parts.length == 5 && parts[4].equals("tags") && method.equals("POST")) {
            JSONArray requested = body.optJSONArray("tag_ids");
            if (requested == null || requested.length() > 50) throw new Failure(400, "Choose up to 50 tags.");
            JSONArray tags = new JSONArray(); Set<String> seen = new HashSet<>();
            for (int index = 0; index < requested.length(); index++) {
                String tagId = VaultStore.uuid(requested.optString(index));
                JSONObject tag = find(located.catalog.optJSONArray("tags"), tagId);
                if (tag == null) throw new Failure(404, "Tag not found.");
                if (seen.add(tagId)) tags.put(tag);
            }
            VaultSession.put(file, "tags", tags); save(located.owner, located.catalog); return tags;
        } else if (parts.length == 5 && parts[4].equals("shares") && method.equals("POST")) return share(located, body);
        else throw new Failure(405, "Unsupported file operation.");
        VaultSession.put(file, "updated_at", now());
        log(located.catalog, user, action, "file", fileId, file.optString("original_filename")); save(located.owner, located.catalog);
        return publicFile(file);
    }

    private JSONObject bulk(JSONObject catalog, String owner, JSONObject body) throws IOException {
        JSONArray ids = body.optJSONArray("file_ids");
        String action = body.optString("action");
        if (ids == null || ids.length() == 0 || ids.length() > 100 || !Set.of("delete", "restore", "permanent_delete", "star", "unstar", "move").contains(action)) throw new Failure(400, "Select 1–100 files and a valid action.");
        String folder = nullable(body, "folder_id");
        if (action.equals("move") && !folder.isEmpty()) folder(catalog, folder, false);
        Set<String> selected = new HashSet<>(); List<JSONObject> files = new ArrayList<>();
        for (int index = 0; index < ids.length(); index++) {
            String fileId = VaultStore.uuid(ids.optString(index));
            JSONObject file = find(catalog.optJSONArray("files"), fileId);
            if (file == null || !selected.add(fileId)) throw new Failure(404, "Select unique files owned by this account.");
            if (file.optBoolean("is_trashed") != (action.equals("restore") || action.equals("permanent_delete"))) throw new Failure(409, "The selected files changed. Refresh and try again.");
            files.add(file);
        }
        for (JSONObject file : files) {
            switch (action) {
                case "delete": trash(file, id()); break;
                case "restore":
                    JSONObject parent = find(catalog.optJSONArray("folders"), nullable(file, "folder_id"));
                    if (parent == null || parent.optBoolean("is_trashed")) VaultSession.put(file, "folder_id", null);
                    restore(file); break;
                case "permanent_delete": purgeFile(catalog, file); break;
                case "star": VaultSession.put(file, "is_starred", true); break;
                case "unstar": VaultSession.put(file, "is_starred", false); break;
                case "move": VaultSession.put(file, "folder_id", folder.isEmpty() ? null : folder); break;
                default: throw new Failure(400, "Unsupported action.");
            }
            VaultSession.put(file, "updated_at", now());
        }
        log(catalog, owner, "files_" + action, "file", null, files.size() + " files"); save(owner, catalog);
        return VaultSession.object("message", "Processed " + files.size() + " files.", "processed_count", files.size(), "failed", new JSONArray());
    }

    private JSONObject collaborator(String owner) throws IOException {
        JSONObject user = account(owner).optJSONObject("user");
        return VaultSession.object("id", owner, "email", user.optString("email"), "full_name", user.optString("full_name"));
    }

    private JSONArray shares(String user, boolean received) throws IOException {
        List<JSONObject> result = new ArrayList<>();
        for (String key : store.names("device/catalog/")) {
            String owner = key.substring("device/catalog/".length());
            if (!received && !user.equals(owner)) continue;
            JSONObject catalog = catalog(owner);
            for (JSONObject share : objects(catalog.optJSONArray("shares"))) {
                if (received && !user.equals(share.optString("shared_with"))) continue;
                JSONObject file = find(catalog.optJSONArray("files"), share.optString("file_id"));
                if (file == null || file.optBoolean("is_trashed")) continue;
                JSONObject item = cloneObject(share);
                VaultSession.put(item, "file", publicFile(file)); VaultSession.put(item, "sharer", collaborator(owner));
                VaultSession.put(item, "recipient", collaborator(share.optString("shared_with"))); result.add(item);
            }
        }
        result.sort(Comparator.comparing((JSONObject value) -> value.optString("created_at")).reversed());
        return new JSONArray(result);
    }

    private JSONObject share(Located located, JSONObject body) throws IOException {
        JSONObject recipient = findAccount(lower(body.optString("shared_with_email").trim()));
        if (recipient == null) throw new Failure(404, "Create the recipient's account on this device first, or use Android sharing.");
        String target = recipient.optJSONObject("user").optString("id");
        if (target.equals(located.owner)) throw new Failure(400, "This account already owns the file.");
        String permission = body.optString("permission", "viewer");
        if (!Set.of("viewer", "editor").contains(permission)) throw new Failure(400, "Choose Viewer or Editor.");
        JSONObject share = null;
        for (JSONObject existing : objects(located.catalog.optJSONArray("shares"))) if (target.equals(existing.optString("shared_with")) && located.file.optString("id").equals(existing.optString("file_id"))) share = existing;
        if (share == null) {
            share = VaultSession.object("id", id(), "file_id", located.file.optString("id"), "shared_by", located.owner, "shared_with", target, "permission", permission, "created_at", now());
            located.catalog.optJSONArray("shares").put(share);
        } else VaultSession.put(share, "permission", permission);
        log(located.catalog, located.owner, "file_shared", "file", located.file.optString("id"), located.file.optString("original_filename")); save(located.owner, located.catalog);
        JSONObject targetCatalog = catalog(target);
        targetCatalog.optJSONArray("notifications").put(VaultSession.object("id", id(), "user_id", target, "type", "file_shared", "title", "File shared on this device",
            "message", collaborator(located.owner).optString("full_name") + " shared " + located.file.optString("original_filename"), "is_read", false,
            "resource_type", "file", "resource_id", located.file.optString("id"), "created_at", now()));
        while (targetCatalog.optJSONArray("notifications").length() > 100) targetCatalog.optJSONArray("notifications").remove(0);
        save(target, targetCatalog);
        return share;
    }

    private JSONObject dashboard(JSONObject catalog, String owner) throws IOException {
        List<JSONObject> files = new ArrayList<>(); int starred = 0, trash = 0, folders = 0;
        JSONObject distribution = new JSONObject();
        for (JSONObject file : objects(catalog.optJSONArray("files"))) {
            if (file.optBoolean("is_trashed")) { trash++; continue; }
            files.add(publicFile(file)); if (file.optBoolean("is_starred")) starred++;
            String category = category(file);
            JSONObject stat = distribution.optJSONObject(category);
            if (stat == null) { stat = VaultSession.object("category", category, "count", 0, "size_bytes", 0); VaultSession.put(distribution, category, stat); }
            VaultSession.put(stat, "count", stat.optInt("count") + 1); VaultSession.put(stat, "size_bytes", stat.optLong("size_bytes") + file.optLong("size_bytes"));
        }
        for (JSONObject folder : objects(catalog.optJSONArray("folders"))) if (!folder.optBoolean("is_trashed")) folders++;
        files.sort(Comparator.comparing((JSONObject value) -> value.optString("created_at")).reversed());
        JSONArray types = new JSONArray();
        for (String category : List.of("document", "image", "video", "audio", "archive", "code", "other")) if (distribution.has(category)) types.put(distribution.optJSONObject(category));
        Set<String> shared = new HashSet<>();
        for (JSONObject share : objects(shares(owner, false))) shared.add(share.optString("file_id"));
        return VaultSession.object("total_files", files.size(), "total_folders", folders, "storage_used_bytes", used(catalog), "storage_quota_bytes", QUOTA_BYTES,
            "shared_files_count", shared.size(), "starred_files_count", starred, "trash_files_count", trash, "file_type_distribution", types,
            "recent_files", new JSONArray(files.subList(0, Math.min(files.size(), 10))), "recent_activities", recent(catalog.optJSONArray("activity"), 10));
    }

    private static void activate(JSONObject file, JSONObject version) {
        VaultSession.put(file, "storage_key", version.optString("storage_key")); VaultSession.put(file, "size_bytes", version.optLong("size_bytes"));
        VaultSession.put(file, "checksum", version.optString("checksum")); VaultSession.put(file, "current_version", version.optInt("version_number"));
        if (version.has("mime_type")) VaultSession.put(file, "mime_type", version.optString("mime_type"));
        VaultSession.put(file, "updated_at", now());
    }

    private static JSONObject revision(String revisionId, String fileId, int number, String mime, long size, String checksum, String uploader) {
        return VaultSession.object("id", revisionId, "file_id", fileId, "version_number", number, "storage_key", revisionId,
            "mime_type", mime, "size_bytes", size, "checksum", checksum, "uploaded_by", uploader, "created_at", now());
    }

    private static JSONObject newFile(String fileId, String owner, String folder, String name, JSONObject version) {
        JSONObject file = VaultSession.object("id", fileId, "owner_id", owner, "folder_id", folder.isEmpty() ? null : folder,
            "original_filename", VaultStore.safeName(name), "is_starred", false, "is_trashed", false, "trashed_at", null,
            "created_at", now(), "updated_at", now(), "tags", new JSONArray(), "_versions", new JSONArray().put(version));
        activate(file, version); return file;
    }

    private void checkSpace(JSONObject catalog, long bytes) throws IOException {
        if (bytes <= 0 || bytes > VaultStore.MAX_FILE_BYTES) throw new Failure(400, "Choose a nonempty file up to 100 MB.");
        if (used(catalog) + bytes > QUOTA_BYTES) throw new Failure(400, "The 1 GB device vault is full. Permanently delete items from Trash to free space.");
        if (store.context.getNoBackupFilesDir().getUsableSpace() < bytes + bytes / 100 + 1024 * 1024) throw new Failure(507, "The phone has insufficient free space. Free device storage and retry.");
    }

    private void verifyContent(String owner, String blob, long size, String checksum, VaultCrypto.Progress progress) throws IOException {
        MessageDigest digest = VaultFiles.digest(); long actual = 0;
        try (InputStream input = new DigestInputStream(store.open("library", owner, blob), digest)) {
            byte[] buffer = new byte[VaultCrypto.CHUNK]; int count;
            while ((count = input.read(buffer)) != -1) {
                actual += count;
                if (actual > size) throw new Failure(400, "File integrity verification failed.");
                if (progress != null) progress.update(actual);
            }
        }
        if (actual != size || !VaultFiles.hex(digest.digest()).equals(checksum)) throw new Failure(400, "File integrity verification failed.");
    }

    private void writeContent(String owner, String blob, InputStream input, long size, String checksum, VaultCrypto.Progress progress) throws IOException {
        File destination = store.file("library", owner, blob);
        if (destination.exists()) { verifyContent(owner, blob, size, checksum, progress); return; }
        File part = new File(destination.getPath() + ".part");
        MessageDigest digest = VaultFiles.digest();
        try {
            long actual;
            try (FileOutputStream output = new FileOutputStream(part)) {
                actual = VaultCrypto.encrypt(new DigestInputStream(input, digest), output, store.key(), "library/" + owner + "/" + blob, size, progress);
                output.getFD().sync();
            }
            if (actual != size || !VaultFiles.hex(digest.digest()).equals(checksum)) throw new Failure(400, "The selected file's integrity check failed. Select it again.");
            if (!part.renameTo(destination)) throw new IOException("The encrypted file could not be committed to device storage.");
        } finally { part.delete(); }
    }

    JSONObject importFile(JSONObject spec, VaultCrypto.Progress progress) throws IOException {
        synchronized (session) {
            String uploader = session.account();
            session.assertAccount(spec.optString("owner"), spec.optString("session_id"));
            String stagingId = VaultStore.uuid(spec.optString("staging_id"));
            String versionFileId = nullable(spec, "version_file_id");
            Located located = versionFileId.isEmpty() ? null : locate(versionFileId);
            if (located != null) editable(located, false);
            String owner = located == null ? uploader : located.owner;
            JSONObject catalog = located == null ? catalog(owner) : located.catalog;
            JSONObject existing = located == null ? find(catalog.optJSONArray("files"), stagingId) : find(located.file.optJSONArray("_versions"), stagingId);
            if (existing != null) {
                JSONObject receipt = located == null ? find(existing.optJSONArray("_versions"), stagingId) : existing;
                if (receipt == null || spec.has("checksum") && !spec.optString("checksum").equals(receipt.optString("checksum"))) throw new Failure(409, "This import key belongs to different content.");
                if (existing.optBoolean("is_trashed")) throw new Failure(409, "This file was already imported and moved to trash. Restore it instead.");
                cleanupStage(uploader, stagingId);
                return located == null ? publicFile(existing) : existing;
            }
            JSONObject staged = store.read("stage/" + uploader + "/" + stagingId);
            if (staged == null) throw new Failure(404, "The selected file is unavailable. Select it again.");
            session.assertAccount(uploader, staged.optString("session_id"));
            String folder = nullable(spec, "folder_id");
            if (!folder.equals(nullable(staged, "folder_id")) || !versionFileId.equals(nullable(staged, "version_file_id"))) throw new Failure(409, "The import destination changed. Select the file again.");
            if (located == null && !folder.isEmpty()) folder(catalog, folder, false);
            long size = staged.optLong("size"); String checksum = staged.optString("checksum");
            checkSpace(catalog, size);
            try (InputStream input = store.open("staged", uploader, stagingId)) { writeContent(owner, stagingId, input, size, checksum, progress); }
            String fileId = located == null ? stagingId : located.file.optString("id");
            int versionNumber = 1;
            if (located != null) for (JSONObject old : objects(located.file.optJSONArray("_versions"))) versionNumber = Math.max(versionNumber, old.optInt("version_number") + 1);
            String mime = staged.optString("mime", "application/octet-stream");
            JSONObject version = revision(stagingId, fileId, versionNumber, mime, size, checksum, uploader);
            JSONObject file = located == null ? newFile(fileId, owner, folder, staged.optString("name"), version) : located.file;
            if (located == null) catalog.optJSONArray("files").put(file);
            else { file.optJSONArray("_versions").put(version); activate(file, version); }
            log(catalog, uploader, located == null ? "file_uploaded" : "file_version_uploaded", "file", fileId, file.optString("original_filename"));
            try { save(owner, catalog); }
            catch (IOException exception) { store.file("library", owner, stagingId).delete(); throw exception; }
            cleanupStage(uploader, stagingId);
            return located == null ? publicFile(file) : version;
        }
    }

    private void cleanupStage(String owner, String stagingId) throws IOException {
        File staged = store.file("staged", owner, stagingId);
        if (staged.exists() && !staged.delete()) throw new IOException("The completed import's staging file could not be removed.");
        store.remove("stage/" + owner + "/" + stagingId);
    }

    private JSONObject copyFile(Located source, JSONObject body) throws IOException {
        if (source.file.optBoolean("is_trashed")) throw new Failure(409, "Restore the file before copying it.");
        String owner = session.account();
        JSONObject catalog = owner.equals(source.owner) ? source.catalog : catalog(owner);
        String folder = body.has("folder_id") ? nullable(body, "folder_id") : owner.equals(source.owner) ? nullable(source.file, "folder_id") : "";
        if (!folder.isEmpty()) folder(catalog, folder, false);
        String name = body.optString("new_name").trim();
        if (name.isEmpty()) name = "Copy of " + source.file.optString("original_filename");
        if (name.length() > 255) throw new Failure(400, "Use a filename up to 255 characters.");
        long size = source.file.optLong("size_bytes"); checkSpace(catalog, size);
        String fileId = id(); String checksum = source.file.optString("checksum");
        try (InputStream input = store.open("library", source.owner, source.file.optString("storage_key"))) { writeContent(owner, fileId, input, size, checksum, null); }
        JSONObject version = revision(fileId, fileId, 1, source.file.optString("mime_type"), size, checksum, owner);
        JSONObject file = newFile(fileId, owner, folder, name, version);
        catalog.optJSONArray("files").put(file); log(catalog, owner, "file_copied", "file", fileId, name);
        try { save(owner, catalog); }
        catch (IOException exception) { store.file("library", owner, fileId).delete(); throw exception; }
        return publicFile(file);
    }

    void recordExport(String fileId, boolean share) throws IOException {
        synchronized (session) {
            Located located = locate(fileId);
            String user = session.account(); JSONObject catalog = user.equals(located.owner) ? located.catalog : catalog(user);
            log(catalog, user, share ? "file_shared_android" : "file_downloaded", "file", fileId, located.file.optString("original_filename"));
            save(user, catalog);
        }
    }
}
