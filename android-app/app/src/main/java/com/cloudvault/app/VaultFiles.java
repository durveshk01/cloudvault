package com.cloudvault.app;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

final class VaultFiles {
    private static final Object CAMERA_LOCK = new Object();
    private final VaultStore store;
    private final VaultSession session;

    VaultFiles(Context context) throws IOException { this(VaultStore.get(context), VaultSession.get(context)); }
    VaultFiles(VaultStore store, VaultSession session) { this.store = store; this.session = session; }

    static String hex(byte[] bytes) {
        StringBuilder encoded = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) encoded.append(String.format(java.util.Locale.ROOT, "%02x", value & 0xff));
        return encoded.toString();
    }

    static MessageDigest digest() {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException exception) { throw new IllegalStateException(exception); }
    }

    void prepareCamera(String folderId, String versionFileId) throws IOException {
        if (folderId != null) VaultStore.uuid(folderId);
        if (versionFileId != null) VaultStore.uuid(versionFileId);
        synchronized (session) {
            store.write("camera_pending", VaultSession.object("id", UUID.randomUUID().toString(), "owner", session.account(),
                "session_id", session.sessionId(), "folder_id", folderId, "version_file_id", versionFileId, "created_at", System.currentTimeMillis()));
        }
    }

    JSONObject stageCamera(Uri uri) throws IOException {
        synchronized (CAMERA_LOCK) {
            JSONObject pending = store.read("camera_pending");
            if (pending == null || System.currentTimeMillis() - pending.optLong("created_at") > 24L * 60 * 60 * 1000) {
                throw new IOException("The camera selection expired. Take the photo again.");
            }
            File plaintext = null;
            if ("file".equals(uri.getScheme())) {
                plaintext = new File(uri.getPath()).getCanonicalFile();
                File cache = store.context.getCacheDir().getCanonicalFile();
                File pictures = store.context.getExternalFilesDir(Environment.DIRECTORY_PICTURES);
                boolean allowed = plaintext.getPath().startsWith(cache.getPath() + File.separator) ||
                    (pictures != null && plaintext.getPath().startsWith(pictures.getCanonicalPath() + File.separator));
                if (!allowed) throw new IOException("Invalid camera file path.");
            } else if (!"content".equals(uri.getScheme())) throw new IOException("Invalid camera result.");
            JSONObject staged = stage(uri, pending.isNull("folder_id") ? null : pending.optString("folder_id"),
                pending.isNull("version_file_id") ? null : pending.optString("version_file_id"), pending.optString("owner"), pending.optString("session_id"));
            synchronized (session) {
                session.assertAccount(pending.optString("owner"), pending.optString("session_id"));
                JSONObject current = store.read("camera_pending");
                if (current != null && pending.optString("id").equals(current.optString("id"))) store.remove("camera_pending");
            }
            if (plaintext != null) plaintext.delete();
            return staged;
        }
    }

    JSONObject stage(Uri uri, String folderId, String versionFileId) throws IOException {
        String owner;
        String sid;
        synchronized (session) { owner = session.account(); sid = session.sessionId(); }
        return stage(uri, folderId, versionFileId, owner, sid);
    }

    JSONObject stage(Uri uri, String folderId, String versionFileId, String owner, String sid) throws IOException {
        session.assertAccount(owner, sid);
        if (folderId != null) VaultStore.uuid(folderId);
        if (versionFileId != null) VaultStore.uuid(versionFileId);
        String name = "upload";
        long declaredSize = -1;
        String mime;
        if ("file".equals(uri.getScheme())) {
            File file = new File(uri.getPath());
            name = file.getName();
            declaredSize = file.length();
            mime = java.net.URLConnection.guessContentTypeFromName(name);
        } else {
            mime = store.context.getContentResolver().getType(uri);
            try (Cursor cursor = store.context.getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);
                    if (nameIndex >= 0) name = cursor.getString(nameIndex);
                    if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) declaredSize = cursor.getLong(sizeIndex);
                }
            }
        }
        if (declaredSize > VaultStore.MAX_FILE_BYTES) throw new IOException("Choose a file up to 100 MB.");
        String id = UUID.randomUUID().toString();
        File destination = store.file("staged", owner, id);
        File part = new File(destination.getPath() + ".part");
        MessageDigest digest = digest();
        try {
            long size;
            try (InputStream raw = store.context.getContentResolver().openInputStream(uri);
                 FileOutputStream encrypted = new FileOutputStream(part)) {
                if (raw == null) throw new IOException("The selected file could not be opened.");
                size = VaultCrypto.encrypt(new DigestInputStream(raw, digest), encrypted, store.key(), "staged/" + owner + "/" + id,
                    VaultStore.MAX_FILE_BYTES, null);
                encrypted.getFD().sync();
            }
            if (size == 0) throw new IOException("Empty files cannot be uploaded.");
            JSONObject metadata = VaultSession.object("id", id, "owner", owner, "name", VaultStore.safeName(name), "size", size,
                "mime", mime == null ? "application/octet-stream" : mime, "checksum", hex(digest.digest()),
                "folder_id", folderId, "version_file_id", versionFileId, "session_id", sid, "queued", false);
            synchronized (session) {
                session.assertAccount(owner, sid);
                synchronized (store) {
                    long stagedBytes = 0;
                    for (String key : store.names("stage/" + owner + "/")) stagedBytes += store.read(key).optLong("size");
                    if (stagedBytes + size > VaultStore.OFFLINE_QUOTA_BYTES) throw new IOException("The encrypted upload queue is full. Complete or cancel uploads first.");
                    if (!part.renameTo(destination)) throw new IOException("Unable to store the selected file.");
                    store.write("stage/" + owner + "/" + id, metadata);
                }
            }
            return metadata;
        } catch (IOException | RuntimeException exception) {
            part.delete();
            destination.delete();
            throw exception;
        }
    }

    JSONArray staged() throws IOException {
        String owner = session.account();
        JSONArray staged = new JSONArray();
        for (String name : store.names("stage/" + owner + "/")) {
            JSONObject metadata = store.read(name);
            if (!metadata.optBoolean("queued")) staged.put(metadata);
        }
        return staged;
    }

    JSONObject offline(String id) throws IOException {
        if (session.onDevice()) return localMetadata(session.device().file(id));
        String owner = session.account();
        JSONObject metadata = store.read("offline/" + owner + "/" + VaultStore.uuid(id));
        if (metadata == null) throw new IOException("This file is not saved for offline use.");
        return metadata;
    }

    JSONArray offlineFiles() throws IOException {
        if (session.onDevice()) {
            JSONArray files = new JSONArray();
            JSONArray local = session.device().files();
            for (int index = 0; index < local.length(); index++) files.put(localMetadata(local.optJSONObject(index)));
            return files;
        }
        String owner = session.account();
        JSONArray files = new JSONArray();
        for (String name : store.names("offline/" + owner + "/")) files.put(store.read(name));
        return files;
    }

    private static JSONObject localMetadata(JSONObject file) {
        long savedAt;
        try { savedAt = java.time.Instant.parse(file.optString("created_at")).toEpochMilli(); }
        catch (java.time.format.DateTimeParseException exception) { savedAt = 0; }
        return VaultSession.object("file", file, "saved_at", savedAt);
    }

    InputStream open(String id) throws IOException {
        return session.onDevice() ? session.device().open(id) : store.open("offline", session.account(), id);
    }

    long offlineUsed() throws IOException {
        JSONArray files = offlineFiles();
        long used = 0;
        for (int index = 0; index < files.length(); index++) used += files.optJSONObject(index).optJSONObject("file").optLong("size_bytes");
        return used;
    }

    void removeOffline(String id) throws IOException {
        if (session.onDevice()) throw new IOException("Device vault files are the originals. Use Files to move an owned file to Trash.");
        synchronized (session) {
            String owner = session.account();
            File content = store.file("offline", owner, id);
            if (content.exists() && !content.delete()) throw new IOException("Unable to remove the offline file.");
            store.remove("offline/" + owner + "/" + VaultStore.uuid(id));
            VaultStore.deleteTree(new File(new File(store.context.getCacheDir(), "offline-share"), VaultStore.uuid(id)));
        }
    }

    File shareCopy(String id) throws IOException {
        synchronized (session) {
            JSONObject metadata = offline(id).optJSONObject("file");
            File directory = new File(new File(store.context.getCacheDir(), "offline-share"), VaultStore.uuid(id));
            if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Unable to prepare the file.");
            File destination = new File(directory, VaultStore.safeName(metadata.optString("original_filename")));
            try (InputStream input = open(id); FileOutputStream output = new FileOutputStream(destination)) {
                copy(input, output, metadata.optLong("size_bytes"), metadata.optString("checksum"), null);
                output.getFD().sync();
            } catch (IOException exception) { destination.delete(); throw exception; }
            return destination;
        }
    }

    static void copy(InputStream input, java.io.OutputStream output) throws IOException {
        byte[] buffer = new byte[VaultCrypto.CHUNK];
        int count;
        while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
    }

    static void copy(InputStream input, java.io.OutputStream output, long expected, VaultCrypto.Progress progress) throws IOException {
        copy(input, output, expected, null, progress);
    }

    static void copy(InputStream input, java.io.OutputStream output, long expected, String checksum, VaultCrypto.Progress progress) throws IOException {
        if (expected < 0 || expected > VaultStore.MAX_FILE_BYTES) throw new IOException("File exceeds the device's transfer limit.");
        MessageDigest digest = checksum == null || checksum.isEmpty() ? null : digest();
        byte[] buffer = new byte[VaultCrypto.CHUNK];
        long completed = 0;
        int count;
        while ((count = input.read(buffer)) != -1) {
            if (completed + count > expected) throw new IOException("The file size changed. Refresh and try again.");
            if (progress != null) progress.update(completed + count);
            if (digest != null) digest.update(buffer, 0, count);
            output.write(buffer, 0, count);
            completed += count;
        }
        if (completed != expected) throw new IOException("The file was incomplete. Try again when your connection is stable.");
        if (digest != null && !hex(digest.digest()).equalsIgnoreCase(checksum)) throw new IOException("File integrity verification failed. Refresh and try again.");
        if (progress != null) progress.update(completed);
    }
}
