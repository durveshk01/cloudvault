package com.cloudvault.app;

import android.content.Context;
import androidx.work.WorkManager;
import com.getcapacitor.CapConfig;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;
import java.util.function.Consumer;
import okhttp3.Call;
import okhttp3.Request;
import okhttp3.Response;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Native HTTP owns bearer/refresh tokens. Neither is exposed to the JavaScript UI. */
final class VaultSession {
    private static VaultSession instance;
    private final VaultStore store;
    private final VaultHttp http;
    private final DeviceVault device;
    private final Object refreshLock = new Object();
    private final Object revocationLock = new Object();
    private long generation;
    final String apiUrl;

    static synchronized VaultSession get(Context context) throws IOException {
        if (instance == null) instance = new VaultSession(context.getApplicationContext());
        return instance;
    }

    VaultSession(Context context) throws IOException {
        store = VaultStore.get(context);
        String origin = CapConfig.loadDefault(context).getPluginConfiguration("Vault").getString("apiUrl", "");
        if (origin.isEmpty()) {
            http = null;
            apiUrl = "";
            device = new DeviceVault(store, this);
        } else {
            http = new VaultHttp(origin, BuildConfig.DEBUG);
            apiUrl = http.apiUrl;
            device = null;
        }
    }

    VaultSession(Context context, VaultHttp http) {
        store = VaultStore.get(context);
        this.http = http;
        apiUrl = http.apiUrl;
        device = null;
    }

    boolean onDevice() { return device != null; }
    DeviceVault device() throws IOException {
        if (device == null) throw new IOException("The native device vault is not enabled in this build.");
        return device;
    }

    static boolean authenticated(String endpoint) throws IOException {
        String path = VaultHttp.path(endpoint);
        return !path.startsWith("/api/public/") && !path.equals("/api/auth/login") &&
            !path.equals("/api/auth/register") && !path.equals("/api/auth/logout");
    }

    Request.Builder connection(String endpoint, String method, String token) throws IOException {
        if (onDevice()) throw new IOException("Device operations do not use network connections.");
        return http.request(endpoint, method, null, token);
    }
    Call call(Request.Builder request) { return http.call(request); }

    static final class Reply {
        final int status;
        final Object data;
        final boolean cached;
        final long cachedAt;
        Reply(int status, Object data) { this(status, data, false, 0); }
        Reply(int status, Object data, boolean cached, long cachedAt) {
            this.status = status; this.data = data; this.cached = cached; this.cachedAt = cachedAt;
        }
    }

    Reply readReply(Response response) throws IOException {
        int status = response.code();
        if (status >= 300 && status < 400) return new Reply(502, object("detail", "The backend redirected this request. Check the configured API origin."));
        try (InputStream body = response.body().byteStream()) {
            String text = new String(VaultCrypto.readBounded(body, 4 * 1024 * 1024), StandardCharsets.UTF_8);
            try {
                Object data = text.trim().startsWith("[") ? new JSONArray(text) : text.trim().isEmpty() ? new JSONObject() : new JSONObject(text);
                return new Reply(status, data);
            } catch (JSONException exception) {
                return new Reply(status >= 300 ? status : 502, object("detail", "The server returned an invalid response."));
            }
        }
    }

    private Reply raw(String endpoint, String method, Object body, String token, String password) throws IOException {
        Request.Builder request = http.request(endpoint, method, VaultHttp.json(body), token);
        if (password != null) request.header("X-Share-Password", password);
        try (Response response = call(request).execute()) { return readReply(response); }
    }

    synchronized JSONObject session() throws IOException {
        JSONObject session = store.read(onDevice() ? "device/session" : "session");
        if (session != null && !apiUrl.equals(session.optString("api_url"))) throw new IOException("Session belongs to a different backend. Sign out and sign in again.");
        return session;
    }

    synchronized JSONObject profile() throws IOException {
        if (onDevice()) return device.profile();
        JSONObject session = session();
        return session == null ? null : session.optJSONObject("user");
    }

    String account() throws IOException {
        JSONObject current = session();
        JSONObject user = current == null ? null : current.optJSONObject("user");
        if (user == null) throw new AuthException("Please sign in before accessing device files.");
        return VaultStore.uuid(user.optString("id"));
    }

    synchronized String sessionId() throws IOException {
        JSONObject current = session();
        if (current == null) throw new AuthException("Please sign in again.");
        return current.optString("sid");
    }

    synchronized void assertAccount(String owner, String sid) throws IOException {
        if (!owner.equals(account()) || !sid.equals(sessionId())) throw new AuthException("Account changed. Try again.");
    }

    private synchronized void assertCurrent(long expected, String token) throws IOException {
        if (generation != expected || session() == null || !tokenSession(token).equals(sessionId())) throw new AuthException("Session changed. Please sign in again.");
    }

    private synchronized void saveTokens(JSONObject tokens, boolean preserveUser) throws IOException {
        JSONObject session = preserveUser ? session() : new JSONObject();
        if (session == null) session = new JSONObject();
        if (tokens.optString("access_token").isEmpty() || tokens.optString("refresh_token").isEmpty()) throw new IOException("Invalid server session response.");
        String sid = tokenSession(tokens.optString("access_token"));
        if (preserveUser && !sid.equals(session.optString("sid"))) throw new IOException("The refreshed session did not match this account.");
        put(session, "sid", sid);
        put(session, "access_token", tokens.optString("access_token"));
        put(session, "refresh_token", tokens.optString("refresh_token"));
        put(session, "expires_at", System.currentTimeMillis() + tokens.optLong("expires_in", 1800) * 1000);
        put(session, "api_url", apiUrl);
        store.write("session", session);
    }

    String accessToken() throws IOException {
        JSONObject current;
        long expected;
        synchronized (this) {
            current = session();
            expected = generation;
            if (current == null) throw new AuthException("Please sign in again.");
        }
        if (current.optLong("expires_at") <= System.currentTimeMillis() + 30_000) rotate(current.optString("access_token"));
        synchronized (this) {
            assertCurrent(expected, current.optString("access_token"));
            return session().optString("access_token");
        }
    }

    private static String tokenSession(String token) throws IOException {
        try {
            String[] parts = token.split("\\.");
            if (parts.length != 3) throw new IllegalArgumentException();
            JSONObject payload = new JSONObject(new String(android.util.Base64.decode(parts[1], android.util.Base64.URL_SAFE | android.util.Base64.NO_WRAP), StandardCharsets.UTF_8));
            return VaultStore.uuid(payload.optString("sid"));
        } catch (IllegalArgumentException | JSONException exception) { throw new IOException("Invalid session identifier."); }
    }

    void rotate(String rejectedToken) throws IOException {
        synchronized (refreshLock) {
            JSONObject current;
            long expected;
            synchronized (this) {
                current = session();
                expected = generation;
                if (current == null || !tokenSession(rejectedToken).equals(current.optString("sid"))) throw new AuthException("Please sign in again.");
                if (!current.optString("access_token").equals(rejectedToken)) return;
            }
            Reply reply = raw("/api/auth/refresh", "POST", object("refresh_token", current.optString("refresh_token")), null, null);
            synchronized (this) {
                assertCurrent(expected, rejectedToken);
                if (reply.status == 401) {
                    clearLocal();
                    throw new AuthException("Session expired or revoked. Please sign in again.");
                }
                if (reply.status >= 300 || !(reply.data instanceof JSONObject)) throw new IOException("Unable to renew your session. Try again when the server is available.");
                saveTokens((JSONObject) reply.data, true);
            }
        }
    }

    Response authenticatedDownload(String endpoint) throws IOException { return authenticatedDownload(endpoint, (call) -> { }); }

    Response authenticatedDownload(String endpoint, Consumer<Call> active) throws IOException {
        long expected;
        synchronized (this) { expected = generation; }
        String token = accessToken();
        Call request = call(connection(endpoint, "GET", token));
        active.accept(request);
        Response response = request.execute();
        if (response.code() == 401) {
            response.close();
            assertCurrent(expected, token);
            rotate(token);
            token = accessToken();
            request = call(connection(endpoint, "GET", token));
            active.accept(request);
            response = request.execute();
        }
        try {
            synchronized (this) {
                assertCurrent(expected, token);
                if (response.code() == 401) { clearLocal(); throw new AuthException("Please sign in again."); }
            }
            return response;
        } catch (IOException exception) { response.close(); throw exception; }
    }

    Response publicDownload(String endpoint, String password) throws IOException {
        return call(http.request(endpoint, "POST", VaultHttp.json(password == null ? null : object("password", password)), null)).execute();
    }

    synchronized void clearLocal() throws IOException {
        generation++;
        WorkManager.getInstance(store.context).cancelAllWorkByTag("cloudvault-transfer");
        if (onDevice()) store.clearDeviceSession(); else store.clearPrivateData();
    }

    private void queueRevocation(String token) throws IOException { queueRevocation(token, apiUrl); }

    private synchronized void queueRevocation(String token, String origin) throws IOException {
        if (token.isEmpty()) return;
        JSONObject queue = store.read("pending_revocations");
        if (queue == null) queue = object("tokens", new JSONArray());
        queue.optJSONArray("tokens").put(object("token", token, "api_url", origin));
        store.write("pending_revocations", queue);
    }

    private Reply logout() throws IOException {
        synchronized (this) {
            JSONObject current = store.read("session");
            try {
                if (current != null) queueRevocation(current.optString("refresh_token"), current.optString("api_url", apiUrl));
            } finally {
            // Local credentials and private files disappear before waiting for the network.
            clearLocal();
            }
        }
        return new Reply(200, object("revocation_pending", retryRevocations()));
    }

    boolean retryRevocations() throws IOException {
        if (onDevice()) return false;
        synchronized (revocationLock) {
            JSONObject queue;
            synchronized (this) { queue = store.read("pending_revocations"); }
            if (queue == null) return false;
            JSONArray tokens = queue.optJSONArray("tokens");
            Set<String> completed = new HashSet<>();
            for (int index = 0; index < tokens.length(); index++) {
                try {
                    JSONObject pending = tokens.optJSONObject(index);
                    if (pending == null || !apiUrl.equals(pending.optString("api_url"))) continue;
                    Reply reply = raw("/api/auth/logout", "POST", object("refresh_token", pending.optString("token")), null, null);
                    if (reply.status >= 200 && reply.status < 300) completed.add(pending.optString("token"));
                } catch (IOException ignored) { /* Keep failed, throttled and redirected revocations encrypted. */ }
            }
            synchronized (this) {
                // Merge against the current queue so a concurrent logout cannot lose its token.
                queue = store.read("pending_revocations");
                JSONArray remaining = new JSONArray();
                if (queue != null) {
                    tokens = queue.optJSONArray("tokens");
                    for (int index = 0; index < tokens.length(); index++) {
                        JSONObject pending = tokens.optJSONObject(index);
                        if (pending == null || !apiUrl.equals(pending.optString("api_url")) || !completed.contains(pending.optString("token"))) remaining.put(tokens.opt(index));
                    }
                }
                if (remaining.length() == 0) store.remove("pending_revocations");
                else store.write("pending_revocations", object("tokens", remaining));
                return remaining.length() > 0;
            }
        }
    }

    private Reply login(Object body) throws IOException {
        long expected;
        synchronized (this) { expected = ++generation; }
        Reply reply = raw("/api/auth/login", "POST", body, null, null);
        if (reply.status >= 300) return reply;
        if (!(reply.data instanceof JSONObject)) throw new IOException("Invalid server session response.");
        JSONObject tokens = (JSONObject) reply.data;
        synchronized (this) {
            if (generation != expected) {
                queueRevocation(tokens.optString("refresh_token"));
                throw new AuthException("Sign-in was cancelled. Please sign in again.");
            }
            JSONObject previous = store.read("session");
            if (previous != null) queueRevocation(previous.optString("refresh_token"), previous.optString("api_url", apiUrl));
            clearLocal();
            saveTokens(tokens, false);
        }
        retryRevocations();
        return new Reply(reply.status, object("expires_in", tokens.optLong("expires_in")));
    }

    Reply request(String endpoint, String method, Object body, String password) throws IOException {
        if (onDevice()) return device.request(endpoint, method, body);
        String path = VaultHttp.path(endpoint);
        if (method == null || !method.matches("GET|POST|PATCH|DELETE")) throw new IOException("Unsupported HTTP method.");
        if (path.equals("/api/auth/refresh")) return new Reply(403, object("detail", "Session refresh is native-only."));
        if (path.equals("/api/auth/login") && method.equals("POST")) return login(body);
        if (path.equals("/api/auth/logout") && method.equals("POST")) return logout();
        boolean authenticated = authenticated(endpoint);
        long expected;
        String cacheKey = null;
        synchronized (this) {
            expected = generation;
            if (authenticated && method.equals("GET") && profile() != null) cacheKey = cacheKey(endpoint);
        }
        try {
            String token = authenticated ? accessToken() : null;
            Reply reply = raw(endpoint, method, body, token, password);
            if (authenticated) assertCurrent(expected, token);
            if (authenticated && reply.status == 401) {
                rotate(token);
                token = accessToken();
                reply = raw(endpoint, method, body, token, password);
            }
            synchronized (this) {
                if (authenticated) {
                    assertCurrent(expected, token);
                    if (reply.status == 401) { clearLocal(); throw new AuthException("Please sign in again."); }
                }
                if (reply.status >= 500 && cacheKey != null) {
                    Reply cached = cached(cacheKey);
                    if (cached != null) return cached;
                }
                if (reply.status < 300 && authenticated) {
                    if (path.equals("/api/auth/me") || path.equals("/api/users/me")) {
                        JSONObject current = session();
                        put(current, "user", reply.data);
                        store.write("session", current);
                    }
                    if (path.equals("/api/auth/change-password")) clearLocal();
                    else if (method.equals("GET")) {
                        cacheKey = cacheKey(endpoint);
                        store.write(cacheKey, object("data", reply.data, "saved_at", System.currentTimeMillis()));
                        ListCache.trim(store);
                    } else {
                        for (String name : store.names("cache/")) store.remove(name);
                    }
                }
            }
            return reply;
        } catch (AuthException exception) { throw exception; }
        catch (IOException exception) {
            synchronized (this) {
                if (authenticated && (generation != expected || session() == null)) throw new AuthException("Session changed. Please sign in again.");
                if (cacheKey != null) {
                    Reply cached = cached(cacheKey);
                    if (cached != null) return cached;
                }
            }
            throw exception;
        }
    }

    private String cacheKey(String endpoint) throws IOException {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(endpoint.getBytes(StandardCharsets.UTF_8));
            return "cache/" + account() + "/" + android.util.Base64.encodeToString(hash, android.util.Base64.NO_WRAP);
        } catch (GeneralSecurityException exception) { throw new IOException(exception); }
    }

    private Reply cached(String name) throws IOException {
        JSONObject cached = store.read(name);
        return cached == null ? null : new Reply(200, cached.opt("data"), true, cached.optLong("saved_at"));
    }

    static JSONObject object(Object... pairs) {
        JSONObject object = new JSONObject();
        for (int index = 0; index < pairs.length; index += 2) put(object, (String) pairs[index], pairs[index + 1]);
        return object;
    }

    static void put(JSONObject object, String key, Object value) {
        try { object.put(key, value == null ? JSONObject.NULL : value); }
        catch (JSONException exception) { throw new IllegalArgumentException(exception); }
    }

    static String string(JSONObject object, String key) { return object.isNull(key) ? "" : object.optString(key, ""); }

    static final class AuthException extends IOException { AuthException(String message) { super(message); } }

    private static final class ListCache {
        static void trim(VaultStore store) throws IOException {
            synchronized (store) {
            java.util.List<String> names = store.names("cache/");
            if (names.size() <= 80 && store.storedBytes("cache/") <= 8 * 1024 * 1024) return;
            names.sort((left, right) -> {
                try { return Long.compare(store.read(left).optLong("saved_at"), store.read(right).optLong("saved_at")); }
                catch (IOException exception) { return 0; }
            });
            int index = 0;
            while (index < names.size() && (names.size() - index > 80 || store.storedBytes("cache/") > 8 * 1024 * 1024)) store.remove(names.get(index++));
            }
        }
    }
}
