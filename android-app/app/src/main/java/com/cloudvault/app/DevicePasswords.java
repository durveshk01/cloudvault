package com.cloudvault.app;

import android.util.Base64;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Arrays;
import javax.crypto.Mac;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONObject;

/** Password verification runs entirely in Android, away from the UI thread. */
final class DevicePasswords {
    private static final int ITERATIONS = 600_000;
    private static final SecureRandom RANDOM = new SecureRandom();

    static void validate(String password, String confirmation) throws DeviceVault.Failure {
        if (password == null || password.length() < 8 || password.length() > 128 ||
            !password.matches("(?s).*[A-Z].*") || !password.matches("(?s).*[a-z].*") || !password.matches("(?s).*\\d.*")) {
            throw new DeviceVault.Failure(400, "Use 8–128 characters with uppercase, lowercase and a number.");
        }
        if (!password.equals(confirmation)) throw new DeviceVault.Failure(400, "Passwords do not match.");
    }

    static JSONObject hash(String password) throws IOException {
        byte[] salt = new byte[32];
        RANDOM.nextBytes(salt);
        return VaultSession.object("salt", Base64.encodeToString(salt, Base64.NO_WRAP),
            "hash", Base64.encodeToString(derive(password, salt), Base64.NO_WRAP));
    }

    static boolean verify(String password, JSONObject stored) throws IOException {
        if (password == null || password.length() > 128) return false;
        try {
            byte[] salt = stored == null ? new byte[32] : Base64.decode(stored.optString("salt"), Base64.NO_WRAP);
            byte[] expected = stored == null ? new byte[32] : Base64.decode(stored.optString("hash"), Base64.NO_WRAP);
            if (salt.length != 32 || expected.length != 32) throw new IOException("The device account's password record is invalid.");
            byte[] actual = derive(password, salt);
            try { return MessageDigest.isEqual(actual, expected) && stored != null; }
            finally { Arrays.fill(actual, (byte) 0); }
        } catch (IllegalArgumentException exception) { throw new IOException("The device account's password record is invalid.", exception); }
    }

    private static byte[] derive(String password, byte[] salt) throws IOException {
        PBEKeySpec spec = new PBEKeySpec(password.toCharArray(), salt, ITERATIONS, 256);
        try { return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded(); }
        catch (NoSuchAlgorithmException exception) {
            // Android 7 (API 24/25) has HmacSHA256 but no named PBKDF2-SHA256
            // factory. Use the same standard KDF, never a weaker algorithm.
            return portableDerive(password, salt, ITERATIONS);
        }
        catch (GeneralSecurityException exception) { throw new IOException("Device password protection is unavailable.", exception); }
        finally { spec.clearPassword(); }
    }

    static byte[] portableDerive(String password, byte[] salt, int iterations) throws IOException {
        if (iterations < 1) throw new IllegalArgumentException("Invalid KDF work factor.");
        byte[] key = password.getBytes(StandardCharsets.UTF_8);
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key.length == 0 ? new byte[]{0} : key, "HmacSHA256"));
            mac.update(salt);
            byte[] block = mac.doFinal(new byte[]{0, 0, 0, 1});
            byte[] result = block.clone();
            for (int iteration = 1; iteration < iterations; iteration++) {
                byte[] next = mac.doFinal(block);
                Arrays.fill(block, (byte) 0); block = next;
                for (int index = 0; index < result.length; index++) result[index] ^= block[index];
            }
            Arrays.fill(block, (byte) 0);
            return result;
        } catch (GeneralSecurityException exception) { throw new IOException("Device password protection is unavailable.", exception); }
        finally { Arrays.fill(key, (byte) 0); }
    }
}
