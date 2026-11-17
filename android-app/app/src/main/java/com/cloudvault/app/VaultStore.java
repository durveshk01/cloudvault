package com.cloudvault.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Environment;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import org.json.JSONException;
import org.json.JSONObject;

/** All tokens, metadata, staged uploads and offline content are encrypted at rest. */
final class VaultStore {
    static final long MAX_FILE_BYTES = 100L * 1024 * 1024;
    static final long OFFLINE_QUOTA_BYTES = 512L * 1024 * 1024;
    private static final String KEY_ALIAS = "cloudvault.private.v1";
    private static VaultStore instance;
    final Context context;
    private final SharedPreferences preferences;
    private final File root;
    private SecretKey key;

    static synchronized VaultStore get(Context context) {
        if (instance == null) instance = new VaultStore(context.getApplicationContext());
        return instance;
    }

    private VaultStore(Context context) {
        this.context = context;
        preferences = context.getSharedPreferences("cloudvault.encrypted", Context.MODE_PRIVATE);
        root = new File(context.getNoBackupFilesDir(), "vault");
    }

    synchronized SecretKey key() throws IOException {
        if (key != null) return key;
        try {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            if (store.containsAlias(KEY_ALIAS)) {
                key = (SecretKey) store.getKey(KEY_ALIAS, null);
            } else {
                KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
                generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256).build());
                key = generator.generateKey();
            }
            return key;
        } catch (GeneralSecurityException exception) {
            throw new IOException("Android secure storage is unavailable.", exception);
        }
    }

    synchronized JSONObject read(String name) throws IOException {
        String encoded = preferences.getString(name, null);
        if (encoded == null) return null;
        try (InputStream decrypted = VaultCrypto.decrypt(new ByteArrayInputStream(Base64.decode(encoded, Base64.NO_WRAP)), key(), name)) {
            return new JSONObject(new String(VaultCrypto.readBounded(decrypted, 4 * 1024 * 1024), StandardCharsets.UTF_8));
        } catch (JSONException | IllegalArgumentException exception) {
            throw new IOException("Unable to read encrypted device data.", exception);
        }
    }

    synchronized void write(String name, JSONObject data) throws IOException {
        byte[] serialized = data.toString().getBytes(StandardCharsets.UTF_8);
        if (serialized.length > 4 * 1024 * 1024) throw new IOException("The device metadata limit was reached. Remove unused entries and try again.");
        byte[] encrypted = VaultCrypto.encryptBytes(serialized, key(), name);
        if (!preferences.edit().putString(name, Base64.encodeToString(encrypted, Base64.NO_WRAP)).commit()) {
            throw new IOException("Device storage is full. Free space and try again.");
        }
    }

    synchronized void remove(String name) { preferences.edit().remove(name).commit(); }

    synchronized List<String> names(String prefix) {
        List<String> names = new ArrayList<>();
        for (String name : preferences.getAll().keySet()) if (name.startsWith(prefix)) names.add(name);
        return names;
    }

    synchronized long storedBytes(String prefix) {
        long size = 0;
        for (java.util.Map.Entry<String, ?> entry : preferences.getAll().entrySet()) {
            if (entry.getKey().startsWith(prefix) && entry.getValue() instanceof String) size += ((String) entry.getValue()).length();
        }
        return size;
    }

    static String uuid(String id) {
        if (id == null || !id.matches("[A-Fa-f0-9]{8}(-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}")) throw new IllegalArgumentException("Invalid file identifier.");
        return UUID.fromString(id).toString();
    }

    File file(String kind, String owner, String id) throws IOException {
        if (!kind.equals("offline") && !kind.equals("staged") && !kind.equals("library")) throw new IllegalArgumentException("Invalid file collection.");
        File directory = new File(new File(root, kind), uuid(owner));
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Unable to create private file storage.");
        return new File(directory, uuid(id) + ".cvf");
    }

    InputStream open(String kind, String owner, String id) throws IOException {
        return VaultCrypto.decrypt(new FileInputStream(file(kind, owner, id)), key(), kind + "/" + uuid(owner) + "/" + uuid(id));
    }

    synchronized void clearPrivateData() throws IOException {
        // Offline sign-out revocations are retained encrypted until connectivity returns.
        JSONObject pending = read("pending_revocations");
        SharedPreferences.Editor editor = preferences.edit();
        for (String name : preferences.getAll().keySet()) if (!name.startsWith("device/") || name.equals("device/session")) editor.remove(name);
        if (!editor.commit()) throw new IOException("Unable to clear device session.");
        if (pending != null) write("pending_revocations", pending);
        File[] collections = root.listFiles();
        if (collections != null) for (File collection : collections) if (!collection.getName().equals("library")) deleteTree(collection);
        deleteTree(new File(context.getCacheDir(), "offline-share"));
        File pictures = context.getExternalFilesDir(Environment.DIRECTORY_PICTURES);
        if (pictures != null) deleteTree(pictures);
    }

    synchronized void clearDeviceSession() throws IOException {
        SharedPreferences.Editor editor = preferences.edit().remove("device/session").remove("camera_pending");
        for (String name : preferences.getAll().keySet()) {
            if (name.startsWith("stage/") || name.startsWith("job/") || name.startsWith("reservation/")) editor.remove(name);
        }
        if (!editor.commit()) throw new IOException("Unable to lock the device vault.");
        deleteTree(new File(root, "staged"));
        deleteTree(new File(context.getCacheDir(), "offline-share"));
        File pictures = context.getExternalFilesDir(Environment.DIRECTORY_PICTURES);
        if (pictures != null) deleteTree(pictures);
    }

    static void deleteTree(File file) throws IOException {
        if (!file.exists()) return;
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children == null) throw new IOException("Unable to access private file storage.");
            for (File child : children) deleteTree(child);
        }
        if (!file.delete()) throw new IOException("Unable to remove private device data.");
    }

    static String safeName(String name) {
        String safe = name == null ? "download" : name.replaceAll("[\\p{Cntrl}\\\\/\"<>:|?*]", "_").trim();
        if (safe.isEmpty() || safe.equals(".") || safe.equals("..")) safe = "download";
        return safe.length() > 180 ? safe.substring(0, 180) : safe;
    }

    static String safeMime(String mime) {
        if (mime != null) mime = mime.split(";")[0].trim().toLowerCase(java.util.Locale.ROOT);
        if (mime == null || !mime.matches("[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+")) return "application/octet-stream";
        if (mime.equals("image/svg+xml") || mime.contains("html") || mime.contains("xml")) return "text/plain";
        return mime;
    }
}
