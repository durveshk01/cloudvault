package com.cloudvault.app;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Versioned, authenticated 64 KiB frames: bounded memory even with Keystore GCM. */
final class VaultCrypto {
    private static final byte[] MAGIC = {'C', 'V', 'F', '1'};
    static final int CHUNK = 64 * 1024;

    interface Progress { void update(long bytes) throws IOException; }

    private static byte[] aad(byte[] nonce, String context, long index, int length) {
        byte[] binding = context.getBytes(StandardCharsets.UTF_8);
        return ByteBuffer.allocate(MAGIC.length + nonce.length + 8 + 4 + binding.length)
            .put(MAGIC).put(nonce).putLong(index).putInt(length).put(binding).array();
    }

    static long encrypt(InputStream input, OutputStream output, SecretKey key, String context,
                        long limit, Progress progress) throws IOException {
        DataOutputStream encoded = new DataOutputStream(output);
        byte[] nonce = new byte[16];
        new SecureRandom().nextBytes(nonce);
        encoded.write(MAGIC);
        encoded.write(nonce);
        byte[] buffer = new byte[CHUNK];
        long total = 0;
        long index = 0;
        while (true) {
            int length = 0;
            while (length < buffer.length) {
                int count = input.read(buffer, length, buffer.length - length);
                if (count < 0) break;
                if (count == 0) continue;
                length += count;
            }
            if (total + length > limit) throw new IOException("File exceeds the device's transfer limit.");
            try {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                // Let the provider generate a fresh IV; Keystore requires randomized encryption.
                cipher.init(Cipher.ENCRYPT_MODE, key);
                byte[] iv = cipher.getIV();
                if (iv.length != 12) throw new IOException("Unsupported encryption IV.");
                cipher.updateAAD(aad(nonce, context, index++, length));
                byte[] ciphertext = cipher.doFinal(buffer, 0, length);
                encoded.writeInt(length);
                encoded.write(iv);
                encoded.write(ciphertext);
            } catch (GeneralSecurityException exception) {
                throw new IOException("Unable to encrypt private data.", exception);
            }
            total += length;
            if (progress != null) progress.update(total);
            // An authenticated empty final frame detects truncation at frame boundaries.
            if (length == 0) break;
        }
        encoded.flush();
        return total;
    }

    static InputStream decrypt(InputStream input, SecretKey key, String context) throws IOException {
        return new DecryptedStream(input, key, context);
    }

    static byte[] encryptBytes(byte[] bytes, SecretKey key, String context) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        encrypt(new ByteArrayInputStream(bytes), output, key, context, 4 * 1024 * 1024, null);
        return output.toByteArray();
    }

    static byte[] readBounded(InputStream input, int limit) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[CHUNK];
        int count;
        while ((count = input.read(buffer)) != -1) {
            if (output.size() + count > limit) throw new IOException("Preview is too large. Download and open the file instead.");
            output.write(buffer, 0, count);
        }
        return output.toByteArray();
    }

    private static final class DecryptedStream extends InputStream {
        private final DataInputStream input;
        private final SecretKey key;
        private final String context;
        private final byte[] nonce = new byte[16];
        private byte[] frame = new byte[0];
        private int offset;
        private long index;
        private boolean finished;

        DecryptedStream(InputStream source, SecretKey key, String context) throws IOException {
            this.input = new DataInputStream(source);
            this.key = key;
            this.context = context;
            byte[] magic = new byte[MAGIC.length];
            input.readFully(magic);
            if (!Arrays.equals(MAGIC, magic)) throw new IOException("Invalid encrypted file format.");
            input.readFully(nonce);
        }

        private boolean nextFrame() throws IOException {
            if (finished) return false;
            int length = input.readInt();
            if (length < 0 || length > CHUNK) throw new IOException("Invalid encrypted frame size.");
            byte[] iv = new byte[12];
            byte[] ciphertext = new byte[length + 16];
            input.readFully(iv);
            input.readFully(ciphertext);
            try {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
                cipher.updateAAD(aad(nonce, context, index++, length));
                frame = cipher.doFinal(ciphertext);
                offset = 0;
            } catch (GeneralSecurityException exception) {
                throw new IOException("Private file integrity verification failed.", exception);
            }
            if (length == 0) {
                finished = true;
                if (input.read() != -1) throw new IOException("Unexpected encrypted file data.");
                return false;
            }
            return true;
        }

        @Override public int read() throws IOException {
            if (offset == frame.length && !nextFrame()) return -1;
            return frame[offset++] & 0xff;
        }

        @Override public int read(byte[] bytes, int start, int length) throws IOException {
            if (start < 0 || length < 0 || start + length > bytes.length) throw new IndexOutOfBoundsException();
            if (length == 0) return 0;
            if (offset == frame.length && !nextFrame()) return -1;
            int count = Math.min(length, frame.length - offset);
            System.arraycopy(frame, offset, bytes, start, count);
            offset += count;
            return count;
        }

        @Override public void close() throws IOException { input.close(); }
    }
}
