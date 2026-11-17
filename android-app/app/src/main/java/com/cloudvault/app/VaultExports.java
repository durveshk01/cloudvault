package com.cloudvault.app;

import android.content.Context;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.UUID;
import okhttp3.Response;
import org.json.JSONObject;

/** Public-link secrets survive the document picker only in encrypted private storage. */
final class VaultExports {
    private final VaultStore store;
    private final VaultSession session;

    VaultExports(Context context) throws IOException { this(VaultStore.get(context), VaultSession.get(context)); }
    VaultExports(VaultStore store, VaultSession session) { this.store = store; this.session = session; }

    private static void requireSuccess(VaultSession.Reply reply) throws IOException {
        if (reply.status >= 200 && reply.status < 300) return;
        String detail = reply.data instanceof JSONObject ? ((JSONObject) reply.data).optString("detail") : "";
        throw new IOException(detail.isEmpty() ? "The shared file is unavailable. Reopen the link and try again." : detail);
    }

    String preparePublic(String token, String password) throws IOException {
        if (token == null || !token.matches("[A-Za-z0-9_-]{16,128}")) throw new IOException("Invalid share link.");
        if (password != null && password.length() > 100) throw new IOException("The share password is too long.");
        String endpoint = "/api/public/shares/" + token;
        VaultSession.Reply reply = session.request(endpoint, "GET", null, null);
        requireSuccess(reply);
        if (!(reply.data instanceof JSONObject)) throw new IOException("Invalid shared file metadata.");
        JSONObject file = (JSONObject) reply.data;
        if (file.optString("permission").equals("view")) throw new IOException("This link is view-only. Direct download is not permitted.");
        long size = file.optLong("file_size", -1);
        if (size < 0 || size > VaultStore.MAX_FILE_BYTES) throw new IOException("Shared files must be no larger than 100 MB to save on this device.");
        if (file.optBoolean("requires_password")) {
            if (password == null) throw new IOException("Enter the share password before saving this file.");
            requireSuccess(session.request(endpoint + "/verify", "POST", VaultSession.object("password", password), null));
        }
        String id = UUID.randomUUID().toString();
        store.write("public_export/" + id, VaultSession.object("token", token, "password", password, "file", file,
            "api_url", session.apiUrl, "created_at", System.currentTimeMillis()));
        return id;
    }

    JSONObject pending(String id) throws IOException {
        JSONObject pending = store.read("public_export/" + VaultStore.uuid(id));
        if (pending == null || !session.apiUrl.equals(pending.optString("api_url")) ||
            System.currentTimeMillis() - pending.optLong("created_at") > 24L * 60 * 60 * 1000) {
            throw new IOException("The save request expired. Reopen the shared link and try again.");
        }
        return pending;
    }

    void exportPublic(String id, OutputStream output) throws IOException {
        JSONObject pending = pending(id);
        long expected = pending.optJSONObject("file").optLong("file_size");
        String password = pending.isNull("password") ? null : pending.optString("password");
        try (Response response = session.publicDownload("/api/public/shares/" + pending.optString("token") + "/download", password)) {
            if (!response.isSuccessful()) requireSuccess(session.readReply(response));
            long declared = response.body().contentLength();
            if (declared >= 0 && declared != expected) throw new IOException("The shared file changed. Reopen the link and try again.");
            try (InputStream input = response.body().byteStream()) { VaultFiles.copy(input, output, expected, null); }
        }
    }

    void discard(String id) { store.remove("public_export/" + VaultStore.uuid(id)); }
}
