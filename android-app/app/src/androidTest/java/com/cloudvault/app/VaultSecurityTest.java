package com.cloudvault.app;

import static org.junit.Assert.*;

import android.content.Context;
import android.net.Uri;
import android.util.Base64;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkInfo;
import androidx.work.WorkManager;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Real Android Keystore + WorkManager, with a local server and no production accounts. */
@RunWith(AndroidJUnit4.class)
public final class VaultSecurityTest {
    private static final String OWNER = "11111111-1111-4111-8111-111111111111";
    private static final String TOKEN = "public_share_token_secret_01234567890123456789";
    private Context context;
    private VaultStore store;
    private VaultSession session;
    private MockWebServer server;
    private Field singleton;
    private Object previousSession;
    private String access;
    private String refresh;
    private final List<File> sources = new ArrayList<>();

    @Before public void setup() throws Exception {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        store = VaultStore.get(context);
        WorkManager.getInstance(context).cancelAllWork().getResult().get(10, TimeUnit.SECONDS);
        store.remove("pending_revocations");
        store.clearPrivateData();
        server = new MockWebServer();
        server.start();
        session = new VaultSession(context, new VaultHttp(server.url("/").toString(), true));
        singleton = VaultSession.class.getDeclaredField("instance");
        singleton.setAccessible(true);
        previousSession = singleton.get(null);
        singleton.set(null, session);
    }

    @After public void cleanup() throws Exception {
        WorkManager.getInstance(context).cancelAllWork().getResult().get(10, TimeUnit.SECONDS);
        store.remove("pending_revocations");
        store.clearPrivateData();
        for (File source : sources) source.delete();
        if (server != null) server.shutdown();
        singleton.set(null, previousSession);
    }

    private MockResponse json(JSONObject data) { return new MockResponse().setHeader("Content-Type", "application/json").setBody(data.toString()); }
    private String token(String owner, String sid) {
        String payload = Base64.encodeToString(VaultSession.object("sub", owner, "sid", sid).toString().getBytes(StandardCharsets.UTF_8), Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        return "e30." + payload + ".signature";
    }
    private RecordedRequest request() throws Exception {
        RecordedRequest request = server.takeRequest(10, TimeUnit.SECONDS);
        assertNotNull("Expected native HTTP request", request);
        return request;
    }
    private void login() throws Exception { login(OWNER); }
    private void login(String owner) throws Exception {
        access = token(owner, UUID.randomUUID().toString());
        refresh = "refresh-secret-" + UUID.randomUUID();
        server.enqueue(json(VaultSession.object("access_token", access, "refresh_token", refresh, "expires_in", 1800))
            .addHeader("Set-Cookie", "access_token=" + access + "; HttpOnly").addHeader("Set-Cookie", "refresh_token=" + refresh + "; HttpOnly"));
        server.enqueue(json(VaultSession.object("id", owner, "full_name", "Native test", "email", "native-test@example.test")));
        VaultSession.Reply reply = session.request("/api/auth/login?attempt=canonical", "POST", VaultSession.object("email", "native-test@example.test", "password", "password"), null);
        assertEquals(200, reply.status);
        JSONObject response = (JSONObject) reply.data;
        assertFalse(response.has("access_token"));
        assertFalse(response.has("refresh_token"));
        assertEquals(200, session.request("/api/auth/me", "GET", null, null).status);
        assertNull(request().getHeader("Cookie"));
        RecordedRequest profile = request();
        assertEquals("Bearer " + access, profile.getHeader("Authorization"));
        assertNull(profile.getHeader("Cookie"));
    }
    private File source(byte[] content) throws IOException {
        File file = File.createTempFile("cloudvault-test-", ".txt", context.getCacheDir());
        try (FileOutputStream output = new FileOutputStream(file)) { output.write(content); }
        sources.add(file);
        return file;
    }
    private void assertEncryptedPreferences(String secret) {
        for (Object value : context.getSharedPreferences("cloudvault.encrypted", Context.MODE_PRIVATE).getAll().values()) {
            assertFalse("Secret must not appear in plaintext preferences", value.toString().contains(secret));
        }
    }
    private WorkInfo transfer(JSONObject spec) throws Exception {
        OneTimeWorkRequest work = new OneTimeWorkRequest.Builder(UploadWorker.class).addTag("cloudvault-transfer").build();
        store.write("job/" + work.getId(), spec);
        WorkManager manager = WorkManager.getInstance(context);
        manager.enqueue(work).getResult().get(10, TimeUnit.SECONDS);
        long deadline = System.currentTimeMillis() + 30_000;
        while (System.currentTimeMillis() < deadline) {
            WorkInfo info = manager.getWorkInfoById(work.getId()).get(10, TimeUnit.SECONDS);
            if (info != null && info.getState().isFinished()) return info;
            Thread.sleep(100);
        }
        throw new AssertionError("Transfer did not finish");
    }
    private JSONObject downloadSpec(String id, byte[] content, String checksum) throws IOException {
        JSONObject file = VaultSession.object("id", id, "original_filename", "offline.txt", "mime_type", "text/plain", "size_bytes", content.length, "checksum", checksum);
        return VaultSession.object("owner", OWNER, "session_id", session.sessionId(), "kind", "download", "file", file, "size", content.length);
    }
    private String checksum(byte[] content) { return VaultFiles.hex(VaultFiles.digest().digest(content)); }

    @Test public void credentialsAreEncryptedAndRefreshCannotCrossTheBridge() throws Exception {
        login();
        assertEquals(access, session.accessToken());
        assertEncryptedPreferences(access);
        assertEncryptedPreferences(refresh);
        int requests = server.getRequestCount();
        assertEquals(403, session.request("/api/auth/refresh?alias=true", "POST", null, null).status);
        assertThrows(IOException.class, () -> session.request("/api/auth/%72efresh", "POST", null, null));
        assertEquals(requests, server.getRequestCount());
    }

    @Test public void cameraTargetSurvivesSessionRecreationAndPlaintextIsRemoved() throws Exception {
        login();
        String folder = UUID.randomUUID().toString();
        String version = UUID.randomUUID().toString();
        new VaultFiles(store, session).prepareCamera(folder, version);
        assertEncryptedPreferences(folder);
        byte[] content = "camera-content".getBytes(StandardCharsets.UTF_8);
        File photo = source(content);
        VaultSession recreated = new VaultSession(context, new VaultHttp(server.url("/").toString(), true));
        JSONObject staged = new VaultFiles(store, recreated).stageCamera(Uri.fromFile(photo));
        assertEquals(folder, staged.getString("folder_id"));
        assertEquals(version, staged.getString("version_file_id"));
        assertFalse(photo.exists());
        assertNull(store.read("camera_pending"));
        try (InputStream input = store.open("staged", OWNER, staged.getString("id"))) {
            assertArrayEquals(content, VaultCrypto.readBounded(input, content.length));
        }
        assertEquals(1, new VaultFiles(store, recreated).staged().length());
    }

    @Test public void cameraAndStagedSelectionsCannotEnterAnotherLoginSession() throws Exception {
        login();
        VaultFiles files = new VaultFiles(store, session);
        files.prepareCamera(null, UUID.randomUUID().toString());
        JSONObject original = store.read("session");
        String oldSid = original.getString("sid");
        VaultSession.put(original, "sid", UUID.randomUUID().toString());
        store.write("session", original);
        File photo = source("private-photo".getBytes(StandardCharsets.UTF_8));
        assertThrows(VaultSession.AuthException.class, () -> files.stageCamera(Uri.fromFile(photo)));
        assertThrows(VaultSession.AuthException.class, () -> files.stage(Uri.fromFile(photo), null, null, OWNER, oldSid));
        assertEquals(0, files.staged().length());
    }

    @Test public void signoutWipesPrivateDataBeforeServerResponseAndRevocationSurvivesRestart() throws Exception {
        login();
        JSONObject staged = new VaultFiles(store, session).stage(Uri.fromFile(source("queued-secret".getBytes(StandardCharsets.UTF_8))), null, null);
        File encrypted = store.file("staged", OWNER, staged.getString("id"));
        store.write("cache/test", VaultSession.object("data", "cached-secret"));
        server.enqueue(new MockResponse().setResponseCode(503).setHeadersDelay(3, TimeUnit.SECONDS).setBody("{}"));
        ExecutorService executor = Executors.newSingleThreadExecutor();
        try {
            Future<VaultSession.Reply> logout = executor.submit(() -> session.request("/api/auth/logout", "POST", null, null));
            assertEquals("/api/auth/logout", request().getPath());
            assertNull(store.read("session"));
            assertNull(store.read("cache/test"));
            assertFalse(encrypted.exists());
            assertFalse("Local wipe must not wait for the server", logout.isDone());
            assertTrue(((JSONObject) logout.get(10, TimeUnit.SECONDS).data).getBoolean("revocation_pending"));
            assertEncryptedPreferences(refresh);
            VaultSession recreated = new VaultSession(context, new VaultHttp(server.url("/").toString(), true));
            assertNull(recreated.profile());
            server.enqueue(new MockResponse().setBody("{}"));
            assertFalse(recreated.retryRevocations());
            RecordedRequest revoked = request();
            assertEquals(refresh, new JSONObject(revoked.getBody().readUtf8()).getString("refresh_token"));
            assertNull(revoked.getHeader("Cookie"));
            assertNull(store.read("pending_revocations"));
        } finally { executor.shutdownNow(); }
    }

    @Test public void throttledRevocationsRemainQueued() throws Exception {
        login();
        server.enqueue(new MockResponse().setResponseCode(429).setBody("{}"));
        assertTrue(((JSONObject) session.request("/api/auth/logout", "POST", null, null).data).getBoolean("revocation_pending"));
        request();
        assertNotNull(store.read("pending_revocations"));
        server.enqueue(new MockResponse().setBody("{}"));
        assertFalse(session.retryRevocations());
        request();
    }

    @Test public void lateRefreshCannotRestoreASignedOutSession() throws Exception {
        login();
        JSONObject current = store.read("session");
        VaultSession.put(current, "expires_at", 0);
        store.write("session", current);
        server.enqueue(json(VaultSession.object("access_token", access, "refresh_token", "rotated-secret", "expires_in", 1800)).setHeadersDelay(3, TimeUnit.SECONDS));
        ExecutorService executor = Executors.newSingleThreadExecutor();
        try {
            Future<String> refresh = executor.submit(() -> session.accessToken());
            assertEquals("/api/auth/refresh", request().getPath());
            server.enqueue(new MockResponse().setBody("{}"));
            session.request("/api/auth/logout", "POST", null, null);
            request();
            ExecutionException failed = assertThrows(ExecutionException.class, () -> refresh.get(10, TimeUnit.SECONDS));
            assertTrue(failed.getCause() instanceof VaultSession.AuthException);
            assertNull(store.read("session"));
        } finally { executor.shutdownNow(); }
    }

    @Test public void cachedListsAreWipedAndCannotCrossAccounts() throws Exception {
        login();
        server.enqueue(json(VaultSession.object("private", "first-account-list")));
        session.request("/api/files", "GET", null, null); request();
        server.enqueue(new MockResponse().setResponseCode(503).setBody("{}"));
        assertTrue(session.request("/api/files", "GET", null, null).cached); request();
        server.enqueue(new MockResponse().setBody("{}"));
        session.request("/api/auth/logout", "POST", null, null); request();
        assertThrows(VaultSession.AuthException.class, () -> session.request("/api/files", "GET", null, null));
        login("22222222-2222-4222-8222-222222222222");
        server.enqueue(new MockResponse().setResponseCode(503).setBody("{}"));
        VaultSession.Reply reply = session.request("/api/files", "GET", null, null); request();
        assertFalse(reply.cached);
        assertEquals(503, reply.status);
    }

    private JSONObject publicFile(int size) {
        return VaultSession.object("token", TOKEN, "filename", "public.txt", "file_size", size, "mime_type", "text/plain", "permission", "download", "requires_password", true);
    }

    @Test public void publicExportKeepsSecretsEncryptedAcrossPickerRestoration() throws Exception {
        String password = " pässword🔒 ";
        byte[] content = "public-content".getBytes(StandardCharsets.UTF_8);
        server.enqueue(json(publicFile(content.length)));
        server.enqueue(new MockResponse().setBody("{}"));
        VaultExports exports = new VaultExports(store, session);
        String id = exports.preparePublic(TOKEN, password);
        request();
        assertEquals(password, new JSONObject(request().getBody().readUtf8()).getString("password"));
        assertEncryptedPreferences(password);
        assertEncryptedPreferences(TOKEN);
        VaultExports recreated = new VaultExports(store, new VaultSession(context, new VaultHttp(server.url("/").toString(), true)));
        assertEquals("public.txt", recreated.pending(id).getJSONObject("file").getString("filename"));
        server.enqueue(new MockResponse().setBody(new okio.Buffer().write(content)));
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        recreated.exportPublic(id, output);
        assertArrayEquals(content, output.toByteArray());
        RecordedRequest download = request();
        assertEquals("POST", download.getMethod());
        assertEquals(password, new JSONObject(download.getBody().readUtf8()).getString("password"));
        assertNull(download.getHeader("Authorization"));
        assertNull(download.getHeader("Cookie"));
        recreated.discard(id);
        assertThrows(IOException.class, () -> recreated.pending(id));
    }

    @Test public void publicExportRejectsChangedContentWithoutWritingIt() throws Exception {
        server.enqueue(json(publicFile(3)));
        server.enqueue(new MockResponse().setBody("{}"));
        VaultExports exports = new VaultExports(store, session);
        String id = exports.preparePublic(TOKEN, "password"); request(); request();
        server.enqueue(new MockResponse().setBody("changed-content"));
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        assertThrows(IOException.class, () -> exports.exportPublic(id, output)); request();
        assertEquals(0, output.size());
        exports.discard(id);
    }

    @Test public void uploadWorkerStreamsDecryptedStagingAndVerifiesChecksum() throws Exception {
        login();
        byte[] content = "encrypted-upload-content".getBytes(StandardCharsets.UTF_8);
        JSONObject staged = new VaultFiles(store, session).stage(Uri.fromFile(source(content)), null, null);
        server.enqueue(json(VaultSession.object("checksum", checksum(content))));
        WorkInfo work = transfer(VaultSession.object("owner", OWNER, "session_id", session.sessionId(), "kind", "upload", "staging_id", staged.getString("id"),
            "request_id", staged.getString("id"), "size", content.length));
        assertEquals(work.getOutputData().getString("error"), WorkInfo.State.SUCCEEDED, work.getState());
        RecordedRequest uploaded = request();
        assertEquals(staged.getString("id"), uploaded.getHeader("Idempotency-Key"));
        assertTrue(uploaded.getBody().readUtf8().contains("encrypted-upload-content"));
        assertFalse(store.file("staged", OWNER, staged.getString("id")).exists());
        assertNull(store.read("stage/" + OWNER + "/" + staged.getString("id")));
        assertFalse(store.read("job/" + work.getId()).has("last_token"));
    }

    @Test public void downloadWorkerSavesOnlyVerifiedEncryptedContent() throws Exception {
        login();
        String id = UUID.randomUUID().toString();
        byte[] content = "verified-offline-content".getBytes(StandardCharsets.UTF_8);
        server.enqueue(new MockResponse().setBody(new okio.Buffer().write(content)));
        WorkInfo work = transfer(downloadSpec(id, content, checksum(content))); request();
        assertEquals(work.getOutputData().getString("error"), WorkInfo.State.SUCCEEDED, work.getState());
        try (InputStream input = store.open("offline", OWNER, id)) { assertArrayEquals(content, VaultCrypto.readBounded(input, content.length)); }
        try (FileInputStream input = new FileInputStream(store.file("offline", OWNER, id))) {
            String encrypted = new String(VaultCrypto.readBounded(input, 1024), StandardCharsets.ISO_8859_1);
            assertFalse(encrypted.contains("verified-offline-content"));
        }
        assertEncryptedPreferences("offline.txt");
    }

    @Test public void failedIntegrityAndQuotaNeverProduceAnOfflineCopy() throws Exception {
        login();
        String id = UUID.randomUUID().toString();
        byte[] content = "untrusted-content".getBytes(StandardCharsets.UTF_8);
        server.enqueue(new MockResponse().setBody(new okio.Buffer().write(content)));
        WorkInfo corrupt = transfer(downloadSpec(id, content, checksum("different-content".getBytes(StandardCharsets.UTF_8)))); request();
        assertEquals(WorkInfo.State.FAILED, corrupt.getState());
        assertFalse(store.file("offline", OWNER, id).exists());
        assertNull(store.read("offline/" + OWNER + "/" + id));
        assertTrue(store.names("reservation/").isEmpty());
        store.write("offline/" + OWNER + "/" + UUID.randomUUID(), VaultSession.object("file", VaultSession.object("size_bytes", VaultStore.OFFLINE_QUOTA_BYTES)));
        int requests = server.getRequestCount();
        WorkInfo full = transfer(downloadSpec(UUID.randomUUID().toString(), content, checksum(content)));
        assertEquals(WorkInfo.State.FAILED, full.getState());
        assertTrue(full.getOutputData().getString("error").contains("512 MB"));
        assertEquals(requests, server.getRequestCount());
    }
}
