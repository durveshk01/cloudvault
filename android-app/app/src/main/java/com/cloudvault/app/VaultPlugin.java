package com.cloudvault.app;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import androidx.lifecycle.LiveData;
import androidx.lifecycle.Observer;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkInfo;
import androidx.work.WorkManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import okhttp3.Response;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name = "Vault")
public final class VaultPlugin extends Plugin {
    private final ExecutorService executor = Executors.newFixedThreadPool(3);
    private LiveData<List<WorkInfo>> workChanges;
    private Observer<List<WorkInfo>> workObserver;

    @Override public void load() {
        getActivity().runOnUiThread(() -> {
            workChanges = WorkManager.getInstance(getContext()).getWorkInfosByTagLiveData("cloudvault-transfer");
            workObserver = (work) -> notifyListeners("transfersChanged", new JSObject());
            workChanges.observe(getActivity(), workObserver);
        });
        // Shared plaintext exists only for explicit open/share operations, and expires.
        executor.execute(() -> {
            try {
                VaultStore store = VaultStore.get(getContext());
                for (String key : store.names("public_export/")) {
                    JSONObject pending = store.read(key);
                    if (pending == null || System.currentTimeMillis() - pending.optLong("created_at") > 24L * 60 * 60 * 1000) store.remove(key);
                }
            } catch (IOException ignored) { }
            File root = new File(getContext().getCacheDir(), "offline-share");
            File[] files = root.listFiles();
            if (files == null) return;
            for (File file : files) {
                if (file.lastModified() < System.currentTimeMillis() - 24L * 60 * 60 * 1000) {
                    try { VaultStore.deleteTree(file); } catch (IOException ignored) { }
                }
            }
        });
    }

    @Override protected void handleOnDestroy() {
        if (workChanges != null && workObserver != null) workChanges.removeObserver(workObserver);
        executor.shutdown();
    }

    private interface Operation { JSONObject run() throws Exception; }

    private void execute(PluginCall call, Operation operation) {
        executor.execute(() -> {
            try {
                JSONObject result = operation.run();
                if (result != null) call.resolve(JSObject.fromJSONObject(result));
            }
            catch (VaultSession.AuthException exception) { call.reject(exception.getMessage(), "AUTH_REQUIRED"); }
            catch (IOException exception) { call.reject(exception.getMessage(), "NETWORK_OR_STORAGE"); }
            catch (Exception exception) { call.reject("The operation could not be completed. Try again.", "INVALID_OPERATION"); }
        });
    }

    @PluginMethod public void sessionInfo(PluginCall call) {
        execute(call, () -> {
            VaultSession session = VaultSession.get(getContext());
            return VaultSession.object("user", session.profile(), "authenticated", session.session() != null,
                "on_device", session.onDevice(), "revocation_pending", !session.onDevice() && VaultStore.get(getContext()).read("pending_revocations") != null);
        });
    }

    @PluginMethod public void retryRevocations(PluginCall call) {
        execute(call, () -> VaultSession.object("pending", VaultSession.get(getContext()).retryRevocations()));
    }

    @PluginMethod public void request(PluginCall call) {
        execute(call, () -> {
            VaultSession.Reply reply = VaultSession.get(getContext()).request(call.getString("endpoint", ""), call.getString("method", "GET"),
                call.getData().opt("body"), call.getString("password"));
            return VaultSession.object("status", reply.status, "data", reply.data, "cached", reply.cached, "cached_at", reply.cachedAt);
        });
    }

    @PluginMethod public void capabilities(PluginCall call) {
        call.resolve(new JSObject().put("camera", getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)));
    }

    @PluginMethod public void preview(PluginCall call) {
        execute(call, () -> {
            String endpoint = call.getString("endpoint", "");
            String fileId = call.getString("fileId");
            VaultSession session = VaultSession.get(getContext());
            String path = VaultHttp.path(endpoint);
            boolean authenticated = VaultSession.authenticated(endpoint);
            if (!path.matches("/api/(files/[A-Fa-f0-9-]{36}|public/shares/[A-Za-z0-9_-]{16,128})/preview")) throw new IOException("Invalid preview path.");
            String owner = authenticated ? session.account() : null;
            String sid = authenticated ? session.sessionId() : null;
            if (fileId != null && (!authenticated || !path.equals("/api/files/" + VaultStore.uuid(fileId) + "/preview"))) throw new IOException("Invalid preview file.");
            if (session.onDevice()) {
                if (!authenticated || fileId == null) throw new IOException("Open device files from Files or Android sharing.");
                JSONObject metadata;
                InputStream content;
                synchronized (session) {
                    session.assertAccount(owner, sid);
                    metadata = session.device().file(fileId);
                    if (metadata.optLong("size_bytes") > 12 * 1024 * 1024) throw new PreviewUnavailable("This file is too large for an in-app preview. Use Open or Save to device.");
                    content = session.device().open(fileId);
                }
                try (InputStream input = content) {
                    byte[] bytes = VaultCrypto.readBounded(input, 12 * 1024 * 1024);
                    session.assertAccount(owner, sid);
                    if (bytes.length != metadata.optLong("size_bytes")) throw new IOException("The file changed. Refresh its preview.");
                    if (!VaultFiles.hex(VaultFiles.digest().digest(bytes)).equalsIgnoreCase(metadata.optString("checksum"))) throw new IOException("File integrity verification failed. Refresh its preview.");
                    return VaultSession.object("data", Base64.encodeToString(bytes, Base64.NO_WRAP), "mime", VaultStore.safeMime(metadata.optString("mime_type")));
                }
            }
            try {
                try (Response response = authenticated ? session.authenticatedDownload(endpoint) : session.publicDownload(endpoint, call.getString("password"))) {
                int status = response.code();
                if (status >= 300) {
                    if (status == 401 && authenticated) throw new VaultSession.AuthException("Please sign in again.");
                    if (status < 500) throw new PreviewUnavailable("Preview is unavailable or access has been revoked.");
                    throw new IOException("Server unavailable.");
                }
                try (InputStream input = response.body().byteStream()) {
                    byte[] bytes = VaultCrypto.readBounded(input, 12 * 1024 * 1024);
                    if (authenticated) session.assertAccount(owner, sid);
                    return VaultSession.object("data", Base64.encodeToString(bytes, Base64.NO_WRAP), "mime", VaultStore.safeMime(response.header("Content-Type")));
                }
                }
            } catch (VaultSession.AuthException | PreviewUnavailable exception) { throw exception; }
            catch (IOException exception) {
                if (fileId == null || !authenticated) throw exception;
                session.assertAccount(owner, sid);
                VaultFiles files = new VaultFiles(getContext());
                JSONObject metadata = files.offline(fileId).optJSONObject("file");
                try (InputStream input = VaultStore.get(getContext()).open("offline", owner, fileId)) {
                    byte[] bytes = VaultCrypto.readBounded(input, 12 * 1024 * 1024);
                    session.assertAccount(owner, sid);
                    return VaultSession.object("data", Base64.encodeToString(bytes, Base64.NO_WRAP),
                        "mime", VaultStore.safeMime(metadata.optString("mime_type")));
                }
            }
        });
    }

    @PluginMethod public void pickFiles(PluginCall call) {
        execute(call, () -> {
            VaultSession session = VaultSession.get(getContext());
            synchronized (session) {
                call.getData().put("selection_owner", session.account());
                call.getData().put("selection_session", session.sessionId());
            }
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, call.getBoolean("multiple", true));
            getActivity().runOnUiThread(() -> {
                try { startActivityForResult(call, intent, "pickedFiles"); }
                catch (android.content.ActivityNotFoundException exception) { call.reject("No file picker is installed. Try the camera or install a Files app.", "UNAVAILABLE"); }
            });
            return null;
        });
    }

    @ActivityCallback private void pickedFiles(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.resolve(new JSObject().put("files", new JSONArray()));
            return;
        }
        execute(call, () -> {
            String owner = call.getString("selection_owner", "");
            String sid = call.getString("selection_session", "");
            VaultSession.get(getContext()).assertAccount(owner, sid);
            List<Uri> selected = new ArrayList<>();
            ClipData clip = result.getData().getClipData();
            if (clip != null) for (int index = 0; index < clip.getItemCount(); index++) selected.add(clip.getItemAt(index).getUri());
            else if (result.getData().getData() != null) selected.add(result.getData().getData());
            if (selected.size() > 20) throw new IOException("Select up to 20 files at a time.");
            if (call.getString("version_file_id") != null && selected.size() > 1) throw new IOException("Choose one file for a new version.");
            JSONArray files = new JSONArray();
            VaultFiles vault = new VaultFiles(getContext());
            for (Uri uri : selected) files.put(vault.stage(uri, call.getString("folder_id"), call.getString("version_file_id"), owner, sid));
            return VaultSession.object("files", files);
        });
    }

    @PluginMethod public void prepareCamera(PluginCall call) {
        execute(call, () -> {
            new VaultFiles(getContext()).prepareCamera(call.getString("folder_id"), call.getString("version_file_id"));
            return new JSONObject();
        });
    }

    @PluginMethod public void stageCamera(PluginCall call) {
        execute(call, () -> {
            JSONObject staged = new VaultFiles(getContext()).stageCamera(Uri.parse(call.getString("path", "")));
            return VaultSession.object("files", new JSONArray().put(staged));
        });
    }

    @PluginMethod public void stagedFiles(PluginCall call) { execute(call, () -> VaultSession.object("files", new VaultFiles(getContext()).staged())); }

    private JSONObject enqueue(JSONObject spec) throws IOException { return enqueue(spec, false); }

    private JSONObject enqueue(JSONObject spec, boolean retry) throws IOException {
        String id = UUID.randomUUID().toString();
        VaultSession.put(spec, "created_at", System.currentTimeMillis());
        VaultStore store = VaultStore.get(getContext());
        VaultSession session = VaultSession.get(getContext());
        synchronized (session) {
            session.assertAccount(spec.optString("owner"), spec.optString("session_id"));
            String stageKey = "stage/" + spec.optString("owner") + "/" + spec.optString("staging_id");
            JSONObject staged = spec.optString("kind").equals("upload") ? store.read(stageKey) : null;
            if (spec.optString("kind").equals("upload") && staged == null && (!retry || !session.onDevice())) throw new IOException("Staged file is unavailable. Choose it again.");
            boolean queued = staged != null && staged.optBoolean("queued");
            if (queued && !retry) throw new IOException("This file is already queued. Check Offline & transfers.");
            OneTimeWorkRequest work = new OneTimeWorkRequest.Builder(UploadWorker.class).setId(UUID.fromString(id))
                .setConstraints(new Constraints.Builder().setRequiredNetworkType(session.onDevice() ? NetworkType.NOT_REQUIRED : NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).addTag("cloudvault-transfer").build();
            try {
                store.write("job/" + id, spec);
                if (staged != null) { VaultSession.put(staged, "queued", true); store.write(stageKey, staged); }
                WorkManager.getInstance(getContext()).enqueue(work).getResult().get();
            } catch (Exception exception) {
                store.remove("job/" + id);
                if (staged != null) { VaultSession.put(staged, "queued", queued); store.write(stageKey, staged); }
                throw new IOException("The transfer queue could not be saved. Try again.", exception);
            }
        }
        notifyListeners("transfersChanged", new JSObject());
        return VaultSession.object("id", id);
    }

    @PluginMethod public void enqueueUpload(PluginCall call) {
        execute(call, () -> {
            String owner = VaultSession.get(getContext()).account();
            String stagingId = VaultStore.uuid(call.getString("stagingId"));
            JSONObject staged = VaultStore.get(getContext()).read("stage/" + owner + "/" + stagingId);
            if (staged == null) throw new IOException("Staged file is unavailable. Choose it again.");
            String folder = call.getString("folder_id");
            String version = call.getString("version_file_id");
            if (folder != null) VaultStore.uuid(folder);
            if (version != null) VaultStore.uuid(version);
            VaultSession.get(getContext()).assertAccount(owner, staged.optString("session_id"));
            if (!VaultSession.string(staged, "folder_id").equals(folder == null ? "" : folder) ||
                !VaultSession.string(staged, "version_file_id").equals(version == null ? "" : version)) throw new IOException("Upload destination changed. Choose the file again.");
            return enqueue(VaultSession.object("owner", owner, "kind", "upload", "name", staged.optString("name"), "size", staged.optLong("size"),
                "checksum", staged.optString("checksum"), "session_id", staged.optString("session_id"), "staging_id", stagingId, "request_id", stagingId, "folder_id", folder, "version_file_id", version));
        });
    }

    @PluginMethod public void enqueueDownload(PluginCall call) {
        execute(call, () -> {
            JSONObject file = call.getObject("file");
            if (file == null) throw new IOException("File metadata is required.");
            VaultStore.uuid(file.optString("id"));
            if (file.optLong("size_bytes") <= 0 || file.optLong("size_bytes") > VaultStore.MAX_FILE_BYTES) throw new IOException("Offline files must be nonempty and up to 100 MB.");
            VaultSession session = VaultSession.get(getContext());
            synchronized (session) {
                return enqueue(VaultSession.object("owner", session.account(), "session_id", session.sessionId(), "kind", "download", "name", file.optString("original_filename"),
                    "size", file.optLong("size_bytes"), "file", file));
            }
        });
    }

    @PluginMethod public void transfers(PluginCall call) {
        execute(call, () -> {
            String owner = VaultSession.get(getContext()).account();
            VaultStore store = VaultStore.get(getContext());
            List<WorkInfo> work = WorkManager.getInstance(getContext()).getWorkInfosByTag("cloudvault-transfer").get();
            List<JSONObject> transfers = new ArrayList<>();
            for (WorkInfo info : work) {
                JSONObject spec = store.read("job/" + info.getId());
                if (spec == null || !owner.equals(spec.optString("owner"))) continue;
                long total = spec.optLong("size");
                transfers.add(VaultSession.object("id", info.getId().toString(), "name", spec.optString("name"), "kind", spec.optString("kind"),
                    "state", info.getState().name(), "completed_bytes", info.getState() == WorkInfo.State.SUCCEEDED ? total : info.getProgress().getLong("completed_bytes", 0),
                    "total_bytes", total, "created_at", spec.optLong("created_at"), "error", info.getOutputData().getString("error")));
            }
            transfers.sort(Comparator.comparingLong((JSONObject spec) -> spec.optLong("created_at")).reversed());
            return VaultSession.object("transfers", new JSONArray(transfers.subList(0, Math.min(50, transfers.size()))));
        });
    }

    @PluginMethod public void cancelTransfer(PluginCall call) {
        execute(call, () -> {
            String id = VaultStore.uuid(call.getString("id"));
            JSONObject job = VaultStore.get(getContext()).read("job/" + id);
            if (job == null || !job.optString("owner").equals(VaultSession.get(getContext()).account())) throw new IOException("Transfer is unavailable.");
            WorkManager.getInstance(getContext()).cancelWorkById(UUID.fromString(id)).getResult().get();
            notifyListeners("transfersChanged", new JSObject());
            return new JSONObject();
        });
    }

    @PluginMethod public void retryTransfer(PluginCall call) {
        execute(call, () -> {
            String id = VaultStore.uuid(call.getString("id"));
            WorkInfo info = WorkManager.getInstance(getContext()).getWorkInfoById(UUID.fromString(id)).get();
            if (info == null || (info.getState() != WorkInfo.State.FAILED && info.getState() != WorkInfo.State.CANCELLED)) throw new IOException("Only stopped transfers can be retried.");
            JSONObject job = VaultStore.get(getContext()).read("job/" + id);
            if (job == null || !job.optString("owner").equals(VaultSession.get(getContext()).account())) throw new IOException("Transfer is unavailable.");
            if (job.optString("kind").equals("download")) {
                VaultSession.Reply reply = VaultSession.get(getContext()).request("/api/files/" + job.optJSONObject("file").optString("id"), "GET", null, null);
                if (reply.status >= 400) throw new IOException("File metadata is unavailable.");
                VaultSession.put(job, "file", reply.data);
                VaultSession.put(job, "size", ((JSONObject) reply.data).optLong("size_bytes"));
            }
            return enqueue(job, true);
        });
    }

    @PluginMethod public void offlineFiles(PluginCall call) {
        execute(call, () -> {
            VaultFiles files = new VaultFiles(getContext());
            VaultSession session = VaultSession.get(getContext());
            return VaultSession.object("files", files.offlineFiles(), "used_bytes", session.onDevice() ? session.profile().optLong("storage_used_bytes") : files.offlineUsed(),
                "quota_bytes", session.onDevice() ? DeviceVault.QUOTA_BYTES : VaultStore.OFFLINE_QUOTA_BYTES);
        });
    }

    @PluginMethod public void removeOffline(PluginCall call) {
        execute(call, () -> { new VaultFiles(getContext()).removeOffline(call.getString("id")); return new JSONObject(); });
    }

    @PluginMethod public void openOffline(PluginCall call) {
        execute(call, () -> {
            String id = call.getString("id");
            boolean share = call.getBoolean("share", false);
            VaultSession session = VaultSession.get(getContext());
            VaultFiles files = new VaultFiles(getContext());
            String owner;
            String sid;
            JSONObject metadata;
            File plaintext;
            synchronized (session) {
                owner = session.account(); sid = session.sessionId();
                metadata = files.offline(id).optJSONObject("file");
                plaintext = files.shareCopy(id);
            }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", plaintext);
            Intent intent = new Intent(share ? Intent.ACTION_SEND : Intent.ACTION_VIEW);
            intent.setType(VaultStore.safeMime(metadata.optString("mime_type")));
            if (share) intent.putExtra(Intent.EXTRA_STREAM, uri);
            else intent.setDataAndType(uri, VaultStore.safeMime(metadata.optString("mime_type")));
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.setClipData(ClipData.newRawUri("CloudVault file", uri));
            getActivity().runOnUiThread(() -> {
                try {
                    synchronized (session) {
                        session.assertAccount(owner, sid);
                        getActivity().startActivity(Intent.createChooser(intent, share ? "Share a copy" : "Open CloudVault file"));
                    }
                    if (session.onDevice() && share) executor.execute(() -> {
                        try {
                            synchronized (session) {
                                session.assertAccount(owner, sid);
                                session.device().recordExport(id, true);
                            }
                        } catch (IOException ignored) { /* The Android chooser has already opened. */ }
                    });
                    call.resolve();
                }
                catch (android.content.ActivityNotFoundException exception) { call.reject("No compatible viewer is installed. Use Save to device or Share.", "UNAVAILABLE"); }
                catch (IOException exception) { call.reject(exception.getMessage(), "AUTH_REQUIRED"); }
            });
            return null;
        });
    }

    @PluginMethod public void exportOffline(PluginCall call) {
        execute(call, () -> {
            VaultSession session = VaultSession.get(getContext());
            JSONObject metadata;
            synchronized (session) {
                metadata = new VaultFiles(getContext()).offline(call.getString("id")).optJSONObject("file");
                call.getData().put("selection_owner", session.account());
                call.getData().put("selection_session", session.sessionId());
            }
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType(VaultStore.safeMime(metadata.optString("mime_type"))).putExtra(Intent.EXTRA_TITLE, VaultStore.safeName(metadata.optString("original_filename")));
            getActivity().runOnUiThread(() -> {
                try { startActivityForResult(call, intent, "exportedFile"); }
                catch (android.content.ActivityNotFoundException exception) { call.reject("No file picker is installed. Use Share instead.", "UNAVAILABLE"); }
            });
            return null;
        });
    }

    @PluginMethod public void exportPublic(PluginCall call) {
        execute(call, () -> {
            VaultExports exports = new VaultExports(getContext());
            String id = exports.preparePublic(call.getString("token"), call.getString("password"));
            JSONObject file = exports.pending(id).optJSONObject("file");
            // Capacitor saves activity-call arguments in a Bundle. Keep link/password out of it.
            call.getData().remove("token");
            call.getData().remove("password");
            call.getData().remove("filename");
            call.getData().put("export_id", id);
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                .setType(VaultStore.safeMime(file.optString("mime_type"))).putExtra(Intent.EXTRA_TITLE, VaultStore.safeName(file.optString("filename")));
            getActivity().runOnUiThread(() -> {
                try { startActivityForResult(call, intent, "exportedPublicFile"); }
                catch (android.content.ActivityNotFoundException exception) {
                    exports.discard(id);
                    call.reject("No file picker is installed. Install a Files app to save this file.", "UNAVAILABLE");
                }
            });
            return null;
        });
    }

    @ActivityCallback private void exportedPublicFile(PluginCall call, ActivityResult result) {
        if (call == null) return;
        execute(call, () -> {
            VaultExports exports = new VaultExports(getContext());
            String id = call.getString("export_id");
            try {
                if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
                    return VaultSession.object("saved", false);
                }
                Uri uri = result.getData().getData();
                try (OutputStream output = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                    if (output == null) throw new IOException("The selected destination could not be opened.");
                    exports.exportPublic(id, output);
                } catch (IOException exception) {
                    try { DocumentsContract.deleteDocument(getContext().getContentResolver(), uri); } catch (Exception ignored) { }
                    throw exception;
                }
                return VaultSession.object("saved", true);
            } finally { exports.discard(id); }
        });
    }

    @ActivityCallback private void exportedFile(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.resolve(new JSObject().put("saved", false));
            return;
        }
        execute(call, () -> {
            VaultSession session = VaultSession.get(getContext());
            String owner = call.getString("selection_owner", "");
            String sid = call.getString("selection_session", "");
            Uri uri = result.getData().getData();
            try {
                JSONObject file;
                InputStream content;
                synchronized (session) {
                    session.assertAccount(owner, sid);
                    VaultFiles files = new VaultFiles(getContext());
                    file = files.offline(call.getString("id")).optJSONObject("file");
                    content = files.open(call.getString("id"));
                }
                try (InputStream input = content;
                     OutputStream output = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                    if (output == null) throw new IOException("The selected destination could not be opened.");
                    VaultFiles.copy(input, output, file.optLong("size_bytes"), file.optString("checksum"), (bytes) -> session.assertAccount(owner, sid));
                }
                session.assertAccount(owner, sid);
            } catch (IOException exception) {
                try { DocumentsContract.deleteDocument(getContext().getContentResolver(), uri); } catch (Exception ignored) { }
                throw exception;
            }
            if (session.onDevice()) {
                try {
                    synchronized (session) {
                        session.assertAccount(owner, sid);
                        session.device().recordExport(call.getString("id"), false);
                    }
                } catch (IOException ignored) { /* A completed user-selected export stays completed. */ }
            }
            return VaultSession.object("saved", true);
        });
    }

    private static final class PreviewUnavailable extends IOException { PreviewUnavailable(String message) { super(message); } }
}
