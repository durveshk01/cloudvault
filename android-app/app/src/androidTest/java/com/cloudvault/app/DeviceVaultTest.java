package com.cloudvault.app;

import static org.junit.Assert.*;

import android.content.Context;
import android.net.Uri;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkInfo;
import androidx.work.WorkManager;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

/** End-to-end native engine tests using real Android Keystore, disk and workers. */
@RunWith(AndroidJUnit4.class)
public final class DeviceVaultTest {
    private static final String PASSWORD = "NativePassword123!";
    private Context context;
    private VaultStore store;
    private VaultSession session;
    private Field singleton;
    private Object previousSession;
    private JSONObject primary;
    private final List<JSONObject> accounts = new ArrayList<>();
    private final List<File> sources = new ArrayList<>();

    @Before public void setup() throws Exception {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        store = VaultStore.get(context);
        WorkManager.getInstance(context).cancelAllWork().getResult().get(10, TimeUnit.SECONDS);
        store.clearDeviceSession();
        session = new VaultSession(context);
        assertTrue("These tests require a default device-mode build", session.onDevice());
        singleton = VaultSession.class.getDeclaredField("instance"); singleton.setAccessible(true);
        previousSession = singleton.get(null); singleton.set(null, session);
        primary = register(); login(primary, PASSWORD);
    }

    @After public void cleanup() throws Exception {
        WorkManager.getInstance(context).cancelAllWork().getResult().get(10, TimeUnit.SECONDS);
        store.clearDeviceSession();
        for (JSONObject user : accounts) {
            String owner = user.getString("id");
            store.remove("device/account/" + owner); store.remove("device/catalog/" + owner);
            VaultStore.deleteTree(store.file("library", owner, UUID.randomUUID().toString()).getParentFile());
        }
        for (File source : sources) source.delete();
        if (singleton != null) singleton.set(null, previousSession);
    }

    private JSONObject register() throws Exception {
        String email = "native-" + UUID.randomUUID() + "@example.test";
        JSONObject user = ok("/api/auth/register", "POST", VaultSession.object("full_name", "Device test", "email", email, "password", PASSWORD, "confirm_password", PASSWORD));
        accounts.add(user); return user;
    }

    private void login(JSONObject user, String password) throws Exception {
        ok("/api/auth/login", "POST", VaultSession.object("email", user.getString("email"), "password", password));
        assertEquals(user.getString("id"), session.account());
    }

    private VaultSession.Reply call(String endpoint, String method, JSONObject body) throws Exception { return session.request(endpoint, method, body, null); }
    private JSONObject ok(String endpoint, String method, JSONObject body) throws Exception {
        VaultSession.Reply reply = call(endpoint, method, body);
        assertEquals(String.valueOf(reply.data), 200, reply.status);
        assertFalse("Device requests must never be cached HTTP replies", reply.cached);
        return (JSONObject) reply.data;
    }
    private JSONObject get(String endpoint) throws Exception { return ok(endpoint, "GET", null); }
    private JSONArray array(String endpoint) throws Exception {
        VaultSession.Reply reply = call(endpoint, "GET", null); assertEquals(String.valueOf(reply.data), 200, reply.status); return (JSONArray) reply.data;
    }
    private JSONObject folder(String name, String parent) throws Exception { return ok("/api/folders", "POST", VaultSession.object("name", name, "parent_id", parent)); }
    private File source(String text) throws Exception {
        File file = File.createTempFile("native-fixture-", ".txt", context.getCacheDir());
        try (FileOutputStream output = new FileOutputStream(file)) { output.write(text.getBytes(StandardCharsets.UTF_8)); }
        sources.add(file); return file;
    }
    private JSONObject stage(String text, String folder, String version) throws Exception {
        return new VaultFiles(store, session).stage(Uri.fromFile(source(text)), folder, version);
    }
    private JSONObject spec(JSONObject staged) throws Exception {
        return VaultSession.object("owner", session.account(), "session_id", session.sessionId(), "kind", "upload", "staging_id", staged.getString("id"),
            "request_id", staged.getString("id"), "checksum", staged.getString("checksum"), "size", staged.getLong("size"), "folder_id", staged.opt("folder_id"), "version_file_id", staged.opt("version_file_id"));
    }
    private JSONObject importFile(String text, String folder) throws Exception { return session.device().importFile(spec(stage(text, folder, null)), null); }
    private String content(String id) throws Exception {
        try (InputStream input = session.device().open(id)) { return new String(VaultCrypto.readBounded(input, 1024 * 1024), StandardCharsets.UTF_8); }
    }
    private void encrypted(String secret) {
        for (Object value : context.getSharedPreferences("cloudvault.encrypted", Context.MODE_PRIVATE).getAll().values()) assertFalse(value.toString().contains(secret));
    }

    @Test public void importsAreEncryptedOrganizableAndPersistAcrossLogoutAndSessionRecreation() throws Exception {
        JSONObject folder = folder("Private documents", null); String folderId = folder.getString("id");
        JSONObject file = importFile("device-only confidential content", folderId); String id = file.getString("id");
        assertEquals("device-only confidential content", content(id));
        assertFalse(file.has("_versions"));
        assertEquals(0, get("/api/files").getInt("total"));
        assertEquals(1, get("/api/files?folder_id=" + folderId).getInt("total"));
        assertEquals(1, get("/api/files?search=fixture").getInt("total"));
        assertEquals(1, array("/api/folders/" + folderId + "/breadcrumbs").length());
        encrypted(primary.getString("email")); encrypted(PASSWORD); encrypted(file.getString("original_filename"));
        try (InputStream input = new FileInputStream(store.file("library", session.account(), file.getString("storage_key")))) {
            assertFalse(new String(VaultCrypto.readBounded(input, 2048), StandardCharsets.ISO_8859_1).contains("device-only confidential content"));
        }
        JSONObject tag = ok("/api/tags", "POST", VaultSession.object("name", "Important"));
        assertEquals(200, call("/api/files/" + id + "/tags", "POST", VaultSession.object("tag_ids", new JSONArray().put(tag.getString("id")))).status);
        ok("/api/files/" + id + "/favorite", "POST", null);
        assertEquals(1, get("/api/favorites").getInt("total"));
        JSONObject copy = ok("/api/files/" + id + "/copy", "POST", VaultSession.object("folder_id", null, "new_name", "copy.txt"));
        assertEquals(content(id), content(copy.getString("id")));
        assertNotEquals(id, copy.getString("id"));
        assertEquals(file.getLong("size_bytes") * 2, get("/api/storage/usage").getLong("used_bytes"));
        assertEquals(2, get("/api/dashboard/stats").getInt("total_files"));
        assertEquals(2, new VaultFiles(store, session).offlineFiles().length());
        File shared = new VaultFiles(store, session).shareCopy(id);
        try (InputStream input = new FileInputStream(shared)) {
            assertEquals("device-only confidential content", new String(VaultCrypto.readBounded(input, 2048), StandardCharsets.UTF_8));
        }
        session.device().recordExport(id, true);
        assertEquals("file_shared_android", array("/api/activity?limit=1").getJSONObject(0).getString("action"));
        assertThrows(java.io.IOException.class, () -> new VaultFiles(store, session).removeOffline(id));
        ok("/api/auth/logout", "POST", null); assertNull(session.profile());
        assertThrows(VaultSession.AuthException.class, () -> session.device().open(id));
        session = new VaultSession(context); singleton.set(null, session); login(primary, PASSWORD);
        assertEquals("device-only confidential content", content(id));
        JSONObject other = register(); login(other, PASSWORD);
        assertEquals(0, get("/api/files").getInt("total"));
        assertEquals(404, call("/api/files/" + id, "GET", null).status);
        assertEquals(404, call("/api/folders/" + folderId, "GET", null).status);
        assertEquals(400, call("/api/files/1-1-1-1-1", "GET", null).status);
    }

    @Test public void immutableVersionsSharingAndRevocationEnforceNativeAccountPermissions() throws Exception {
        JSONObject recipient = register(); JSONObject file = importFile("original version", null); String id = file.getString("id");
        JSONObject originalSpec = spec(stage("new version", null, id));
        JSONObject version = session.device().importFile(originalSpec, null);
        assertEquals(2, version.getInt("version_number"));
        assertEquals(2, array("/api/files/" + id + "/versions").length());
        session.device().importFile(originalSpec, null);
        assertEquals("A retried import must not duplicate a revision", 2, array("/api/files/" + id + "/versions").length());
        ok("/api/files/" + id + "/versions/" + file.getString("storage_key") + "/restore", "POST", null);
        assertEquals("original version", content(id));
        JSONObject share = ok("/api/files/" + id + "/shares", "POST", VaultSession.object("shared_with_email", recipient.getString("email"), "permission", "viewer"));
        login(recipient, PASSWORD); assertEquals("original version", content(id));
        assertEquals(1, array("/api/shared-with-me").length());
        assertEquals(403, call("/api/files/" + id, "PATCH", VaultSession.object("original_filename", "not-allowed.txt")).status);
        assertEquals(403, call("/api/files/" + id + "/versions/" + version.getString("id") + "/restore", "POST", null).status);
        assertEquals(1, array("/api/notifications?unread_only=true").length());
        ok("/api/notifications/read-all", "POST", null); assertEquals(0, array("/api/notifications?unread_only=true").length());
        JSONObject savedCopy = ok("/api/files/" + id + "/copy", "POST", VaultSession.object("new_name", "my-copy.txt"));
        login(primary, PASSWORD);
        ok("/api/files/" + id + "/shares", "POST", VaultSession.object("shared_with_email", recipient.getString("email"), "permission", "editor"));
        login(recipient, PASSWORD);
        ok("/api/files/" + id, "PATCH", VaultSession.object("original_filename", "collaborated.txt"));
        session.device().importFile(spec(stage("editor version", null, id)), null);
        assertEquals("editor version", content(id));
        assertEquals(403, call("/api/files/" + id, "DELETE", null).status);
        login(primary, PASSWORD); ok("/api/shares/" + share.getString("id"), "DELETE", null);
        login(recipient, PASSWORD);
        assertEquals(0, array("/api/shared-with-me").length());
        assertEquals(404, call("/api/files/" + id, "GET", null).status);
        assertEquals("original version", content(savedCopy.getString("id")));
        assertEquals(400, call("/api/files/" + savedCopy.getString("id") + "/share-links", "POST", null).status);
    }

    @Test public void recursiveTrashRestoresOnlyItsBatchAndBulkOperationsAreAtomic() throws Exception {
        String parent = folder("Parent", null).getString("id"); String child = folder("Child", parent).getString("id");
        JSONObject prior = importFile("previously trashed", child); JSONObject nested = importFile("nested content", child);
        ok("/api/files/" + prior.getString("id"), "DELETE", null);
        assertEquals(400, call("/api/folders/" + parent + "/move", "POST", VaultSession.object("parent_id", child)).status);
        ok("/api/folders/" + parent, "DELETE", null);
        assertEquals(2, get("/api/trash").getInt("total"));
        assertEquals(2, get("/api/trash/folders").getInt("total"));
        folder("Parent", null);
        ok("/api/trash/folders/" + parent + "/restore", "POST", null);
        assertEquals(1, get("/api/trash").getInt("total"));
        assertEquals("nested content", content(nested.getString("id")));
        assertTrue(get("/api/folders/" + parent).getString("name").startsWith("Parent (restored"));
        assertEquals(404, call("/api/files/bulk-action", "POST", VaultSession.object("action", "delete", "file_ids", new JSONArray().put(nested.getString("id")).put(UUID.randomUUID().toString()))).status);
        assertEquals("Atomic validation must leave existing files untouched", "nested content", content(nested.getString("id")));
        long before = get("/api/storage/usage").getLong("used_bytes");
        ok("/api/trash/" + prior.getString("id") + "/permanent", "DELETE", null);
        assertTrue(get("/api/storage/usage").getLong("used_bytes") < before);
        assertFalse(store.file("library", session.account(), prior.getString("storage_key")).exists());
        ok("/api/folders/" + parent, "DELETE", null); ok("/api/trash/empty", "DELETE", null);
        assertEquals(0, get("/api/storage/usage").getLong("used_bytes"));
        assertEquals(0, get("/api/trash").getInt("total"));
        assertEquals(0, get("/api/trash/folders").getInt("total"));
    }

    @Test public void restartSafeWorkerImportsNeedNoServerAndFailuresCannotCommitCorruptContent() throws Exception {
        JSONObject staged = stage("worker content", null, null); JSONObject spec = spec(staged);
        session = new VaultSession(context); singleton.set(null, session);
        WorkInfo work = transfer(spec);
        assertEquals(work.getOutputData().getString("error"), WorkInfo.State.SUCCEEDED, work.getState());
        String id = staged.getString("id"); assertEquals("worker content", content(id));
        assertNull(store.read("stage/" + session.account() + "/" + id));
        assertFalse(store.file("staged", session.account(), id).exists());
        assertEquals(WorkInfo.State.SUCCEEDED, transfer(spec).getState());
        assertEquals(1, get("/api/files").getInt("total"));
        JSONObject changed = stage("corrupted selection", null, null); JSONObject wrong = spec(changed);
        VaultSession.put(changed, "checksum", "0000000000000000000000000000000000000000000000000000000000000000");
        store.write("stage/" + session.account() + "/" + changed.getString("id"), changed);
        assertEquals(WorkInfo.State.FAILED, transfer(wrong).getState());
        assertEquals(1, get("/api/files").getInt("total"));
        assertFalse(store.file("library", session.account(), changed.getString("id")).exists());
        JSONObject destination = stage("wrong destination", null, null); JSONObject moved = spec(destination);
        VaultSession.put(moved, "folder_id", UUID.randomUUID().toString());
        assertEquals(409, assertThrows(DeviceVault.Failure.class, () -> session.device().importFile(moved, null)).status);
        JSONObject other = register(); login(other, PASSWORD);
        assertThrows(VaultSession.AuthException.class, () -> session.device().importFile(spec, null));
    }

    @Test public void passwordChangesLockTheSessionWithoutDeletingTheLibrary() throws Exception {
        JSONObject file = importFile("preserved after password change", null);
        assertEquals(400, call("/api/auth/change-password", "POST", VaultSession.object("current_password", "wrong", "new_password", "NewPassword456!", "confirm_password", "NewPassword456!")).status);
        assertEquals(200, call("/api/auth/change-password", "POST", VaultSession.object("current_password", PASSWORD, "new_password", "NewPassword456!", "confirm_password", "NewPassword456!")).status);
        assertNull(session.profile());
        assertEquals(401, call("/api/auth/login", "POST", VaultSession.object("email", primary.getString("email"), "password", PASSWORD)).status);
        login(primary, "NewPassword456!");
        assertEquals("preserved after password change", content(file.getString("id")));
        encrypted("NewPassword456!");
    }

    private WorkInfo transfer(JSONObject spec) throws Exception {
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(UploadWorker.class).addTag("cloudvault-transfer").build();
        store.write("job/" + request.getId(), spec);
        WorkManager manager = WorkManager.getInstance(context); manager.enqueue(request).getResult().get(10, TimeUnit.SECONDS);
        long deadline = System.currentTimeMillis() + 30_000;
        while (System.currentTimeMillis() < deadline) {
            WorkInfo info = manager.getWorkInfoById(request.getId()).get(10, TimeUnit.SECONDS);
            if (info != null && info.getState().isFinished()) return info;
            Thread.sleep(100);
        }
        throw new AssertionError("Device import worker did not finish");
    }
}
