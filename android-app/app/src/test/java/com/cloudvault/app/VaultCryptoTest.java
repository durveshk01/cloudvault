package com.cloudvault.app;

import static org.junit.Assert.*;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.SecureRandom;
import java.util.Arrays;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import org.junit.Before;
import org.junit.Test;

public final class VaultCryptoTest {
    private SecretKey key;
    private byte[] content;

    @Before public void setup() throws Exception {
        KeyGenerator generator = KeyGenerator.getInstance("AES");
        generator.init(256);
        key = generator.generateKey();
        content = new byte[VaultCrypto.CHUNK * 2 + 17];
        new SecureRandom().nextBytes(content);
    }

    private byte[] encrypted(byte[] bytes) throws IOException { return VaultCrypto.encryptBytes(bytes, key, "offline/account/file"); }
    private byte[] decrypted(byte[] bytes, String context) throws IOException {
        try (InputStream input = VaultCrypto.decrypt(new ByteArrayInputStream(bytes), key, context)) { return VaultCrypto.readBounded(input, content.length + 1); }
    }

    @Test public void multiFrameRoundtripAndRandomizedCiphertexts() throws Exception {
        byte[] first = encrypted(content);
        byte[] second = encrypted(content);
        assertFalse(Arrays.equals(first, second));
        assertArrayEquals(content, decrypted(first, "offline/account/file"));
        assertArrayEquals(new byte[0], decrypted(encrypted(new byte[0]), "offline/account/file"));
    }

    @Test public void cannotMoveEncryptedContentToAnotherAccountOrCollection() throws Exception {
        byte[] encrypted = encrypted(content);
        assertThrows(IOException.class, () -> decrypted(encrypted, "offline/other-account/file"));
        assertThrows(IOException.class, () -> decrypted(encrypted, "staged/account/file"));
    }

    @Test public void detectsModifiedCiphertextAndMissingFinalFrame() throws Exception {
        byte[] encrypted = encrypted(content);
        byte[] corrupt = encrypted.clone();
        corrupt[40] ^= 1;
        assertThrows(IOException.class, () -> decrypted(corrupt, "offline/account/file"));
        byte[] truncated = Arrays.copyOf(encrypted, encrypted.length - 32);
        assertThrows(IOException.class, () -> decrypted(truncated, "offline/account/file"));
        byte[] appended = Arrays.copyOf(encrypted, encrypted.length + 1);
        assertThrows(IOException.class, () -> decrypted(appended, "offline/account/file"));
    }

    @Test public void detectsReorderedFrames() throws Exception {
        byte[] encrypted = encrypted(content);
        int frame = VaultCrypto.CHUNK + 32;
        byte[] first = Arrays.copyOfRange(encrypted, 20, 20 + frame);
        System.arraycopy(encrypted, 20 + frame, encrypted, 20, frame);
        System.arraycopy(first, 0, encrypted, 20 + frame, frame);
        assertThrows(IOException.class, () -> decrypted(encrypted, "offline/account/file"));
    }

    @Test public void encryptionAndReadsStayWithinDeclaredLimits() throws Exception {
        assertThrows(IOException.class, () -> VaultCrypto.encrypt(new ByteArrayInputStream(content), new ByteArrayOutputStream(), key, "staged/account/file", content.length - 1, null));
        assertThrows(IOException.class, () -> VaultCrypto.readBounded(new ByteArrayInputStream(content), content.length - 1));
        assertArrayEquals(content, VaultCrypto.readBounded(new ByteArrayInputStream(content), content.length));
    }

    @Test public void exportRejectsChangedOrIncompleteStreamsBeforeReportingSuccess() throws Exception {
        assertThrows(IOException.class, () -> VaultFiles.copy(new ByteArrayInputStream(content), new ByteArrayOutputStream(), content.length - 1, null));
        assertThrows(IOException.class, () -> VaultFiles.copy(new ByteArrayInputStream(content), new ByteArrayOutputStream(), content.length + 1, null));
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        VaultFiles.copy(new ByteArrayInputStream(content), output, content.length, null);
        assertArrayEquals(content, output.toByteArray());
    }
}
