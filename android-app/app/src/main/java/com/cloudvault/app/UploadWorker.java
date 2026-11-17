package com.cloudvault.app;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.Data;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import okhttp3.Call;
import okhttp3.MediaType;
import okhttp3.RequestBody;
import okhttp3.Response;
import okio.BufferedSink;
import org.json.JSONObject;

/** Durable constrained transfers; encrypted staging + idempotency make process-death retries safe. */
public final class UploadWorker extends Worker {
    private VaultStore store;
    private VaultSession session;
    private JSONObject spec;
    private long lastProgress;
    private volatile Call activeCall;

    public UploadWorker(@NonNull Context context, @NonNull WorkerParameters parameters) { super(context, parameters); }

    @Override public void onStopped() {
        Call call = activeCall;
        if (call != null) call.cancel();
    }

    private void active(Call call) throws IOException {
        activeCall = call;
        if (isStopped()) { call.cancel(); throw new IOException("Transfer cancelled."); }
    }

    private void progress(long bytes, long total) throws IOException {
        if (isStopped()) throw new IOException("Transfer cancelled.");
        if (System.currentTimeMillis() - lastProgress < 300 && bytes != total) return;
        lastProgress = System.currentTimeMillis();
        setProgressAsync(new Data.Builder().putLong("completed_bytes", bytes).putLong("total_bytes", total).build());
    }

    private void assertAccount() throws IOException {
        if (isStopped()) throw new VaultSession.AuthException("Transfer cancelled.");
        session.assertAccount(spec.optString("owner"), spec.optString("session_id"));
    }

    @NonNull @Override public Result doWork() {
        try {
            store = VaultStore.get(getApplicationContext());
            session = VaultSession.get(getApplicationContext());
            spec = store.read("job/" + getId());
            if (spec == null) return Result.failure(new Data.Builder().putString("error", "Transfer data is unavailable. Select the file again.").build());
            assertAccount();
            return spec.optString("kind").equals("upload") ? upload() : download();
        } catch (VaultSession.AuthException exception) {
            return failure(exception.getMessage());
        } catch (DeviceVault.Failure exception) {
            return failure(exception.getMessage());
        } catch (IOException exception) {
            if (!isStopped() && getRunAttemptCount() < 4 && !(exception instanceof PermanentFailure) && (session == null || !session.onDevice())) return Result.retry();
            return failure(exception.getMessage());
        } catch (RuntimeException exception) {
            return failure("The transfer could not be completed. Retry or select the file again.");
        }
    }

    private Result failure(String message) {
        String safe = message == null ? "Transfer failed." : message;
        return Result.failure(new Data.Builder().putString("error", safe.substring(0, Math.min(300, safe.length()))).build());
    }

    private Result upload() throws IOException {
        if (session.onDevice()) {
            session.device().importFile(spec, (bytes) -> { assertAccount(); progress(bytes, spec.optLong("size")); });
            progress(spec.optLong("size"), spec.optLong("size"));
            return Result.success();
        }
        String owner = spec.optString("owner");
        String stagingId = spec.optString("staging_id");
        JSONObject staged = store.read("stage/" + owner + "/" + stagingId);
        if (staged == null) throw new PermanentFailure("The staged upload is unavailable. Select the file again.");
        String versionFileId = VaultSession.string(spec, "version_file_id");
        String folderId = VaultSession.string(spec, "folder_id");
        String endpoint = versionFileId.isEmpty() ? "/api/files/upload" + (folderId.isEmpty() ? "" : "?folder_id=" + URLEncoder.encode(folderId, "UTF-8"))
            : "/api/files/" + VaultStore.uuid(versionFileId) + "/versions";
        String token = session.accessToken();
        VaultSession.Reply reply = multipart(endpoint, staged, token);
        if (reply.status == 401) {
            session.rotate(token);
            reply = multipart(endpoint, staged, session.accessToken());
        }
        checkStatus(reply);
        if (!(reply.data instanceof JSONObject) || !staged.optString("checksum").equals(((JSONObject) reply.data).optString("checksum"))) {
            throw new PermanentFailure("The uploaded file's checksum did not match. Refresh the vault before retrying.");
        }
        synchronized (session) {
            assertAccount();
            store.file("staged", owner, stagingId).delete();
            store.remove("stage/" + owner + "/" + stagingId);
            for (String name : store.names("cache/")) store.remove(name);
        }
        return Result.success();
    }

    private VaultSession.Reply multipart(String endpoint, JSONObject staged, String token) throws IOException {
        String boundary = "CloudVault" + getId().toString().replace("-", "");
        byte[] header = ("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + VaultStore.safeName(staged.optString("name")) +
            "\"\r\nContent-Type: " + VaultStore.safeMime(staged.optString("mime")) + "\r\n\r\n").getBytes(StandardCharsets.UTF_8);
        byte[] footer = ("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8);
        long total = staged.optLong("size");
        RequestBody body = new RequestBody() {
            @Override public MediaType contentType() { return MediaType.get("multipart/form-data; boundary=" + boundary); }
            @Override public long contentLength() { return total + header.length + footer.length; }
            @Override public boolean isOneShot() { return true; }
            @Override public void writeTo(BufferedSink sink) throws IOException {
                assertAccount();
                OutputStream output = sink.outputStream();
                try (InputStream input = store.open("staged", spec.optString("owner"), spec.optString("staging_id"))) {
                output.write(header);
                byte[] buffer = new byte[VaultCrypto.CHUNK];
                long completed = 0;
                int count;
                while ((count = input.read(buffer)) != -1) {
                    assertAccount();
                    output.write(buffer, 0, count);
                    completed += count;
                    progress(completed, total);
                }
                if (completed != total) throw new PermanentFailure("The staged file size changed.");
                output.write(footer);
                }
            }
        };
        Call call = session.call(session.connection(endpoint, "POST", token).post(body).header("Idempotency-Key", spec.optString("request_id")));
        active(call);
        try (Response response = call.execute()) { assertAccount(); return session.readReply(response); }
        finally { activeCall = null; }
    }

    private void checkStatus(VaultSession.Reply reply) throws IOException {
        if (reply.status < 300) return;
        String message = reply.data instanceof JSONObject ? ((JSONObject) reply.data).optString("detail", "The server could not complete this transfer.") : "The server could not complete this transfer.";
        if (reply.status == 401) throw new VaultSession.AuthException("Please sign in again before retrying.");
        if (reply.status == 429 || reply.status >= 500) throw new IOException(message);
        throw new PermanentFailure(message);
    }

    private Result download() throws IOException {
        if (session.onDevice()) {
            JSONObject file = session.device().file(spec.optJSONObject("file").optString("id"));
            // Device files already live in the encrypted library; never create
            // a second stale cache or require connectivity for this operation.
            progress(file.optLong("size_bytes"), file.optLong("size_bytes"));
            return Result.success();
        }
        JSONObject metadata = spec.optJSONObject("file");
        String owner = spec.optString("owner");
        String id = VaultStore.uuid(metadata.optString("id"));
        long expected = metadata.optLong("size_bytes");
        if (expected <= 0 || expected > VaultStore.MAX_FILE_BYTES) throw new PermanentFailure("Offline files must be nonempty and no larger than 100 MB.");
        String reservation = "reservation/" + owner + "/" + getId();
        VaultFiles files = new VaultFiles(getApplicationContext());
        synchronized (session) {
            assertAccount();
            synchronized (store) {
                long used = files.offlineUsed();
                JSONObject previous = store.read("offline/" + owner + "/" + id);
                if (previous != null) used -= previous.optJSONObject("file").optLong("size_bytes");
                for (String name : store.names("reservation/" + owner + "/")) {
                    if (!name.equals(reservation)) used += store.read(name).optLong("size");
                }
                if (used + expected > VaultStore.OFFLINE_QUOTA_BYTES) throw new PermanentFailure("The 512 MB offline vault is full. Remove an offline copy first.");
                store.write(reservation, VaultSession.object("size", expected));
            }
        }
        File destination = store.file("offline", owner, id);
        File part = new File(destination.getPath() + "." + getId() + ".part");
        try {
            try (Response response = session.authenticatedDownload("/api/files/" + id + "/download?direct=true", (call) -> {
                activeCall = call;
                if (isStopped()) call.cancel();
            })) {
            if (response.code() >= 300) checkStatus(session.readReply(response));
            long declared = response.body().contentLength();
            if (declared >= 0 && declared != expected) throw new PermanentFailure("File changed since it was listed. Refresh the vault and retry.");
            MessageDigest digest = VaultFiles.digest();
            long actual;
            try (InputStream input = new DigestInputStream(response.body().byteStream(), digest); FileOutputStream output = new FileOutputStream(part)) {
                actual = VaultCrypto.encrypt(input, output, store.key(), "offline/" + owner + "/" + id, expected, (bytes) -> {
                    assertAccount();
                    progress(bytes, expected);
                });
                output.getFD().sync();
            }
            String checksum = VaultFiles.hex(digest.digest());
            if (actual != expected || (!metadata.isNull("checksum") && !metadata.optString("checksum").isEmpty() && !checksum.equals(metadata.optString("checksum")))) {
                throw new PermanentFailure("File integrity verification failed. Refresh the vault and retry.");
            }
            VaultSession.put(metadata, "checksum", checksum);
            synchronized (session) {
                assertAccount();
                if (!part.renameTo(destination)) throw new IOException("Unable to save the offline file.");
                store.write("offline/" + owner + "/" + id, VaultSession.object("file", metadata, "saved_at", System.currentTimeMillis()));
            }
            return Result.success();
            }
        } finally {
            activeCall = null;
            part.delete();
            store.remove(reservation);
        }
    }

    private static final class PermanentFailure extends IOException { PermanentFailure(String message) { super(message); } }
}
