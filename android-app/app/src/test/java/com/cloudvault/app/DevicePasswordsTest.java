package com.cloudvault.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.nio.charset.StandardCharsets;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;
import org.junit.Test;

public final class DevicePasswordsTest {
    @Test public void androidSevenFallbackMatchesPublishedPbkdf2Sha256Vectors() throws Exception {
        byte[] salt = "salt".getBytes(StandardCharsets.UTF_8);
        assertEquals("120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b", VaultFiles.hex(DevicePasswords.portableDerive("password", salt, 1)));
        assertEquals("ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43", VaultFiles.hex(DevicePasswords.portableDerive("password", salt, 2)));
        assertEquals("c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a", VaultFiles.hex(DevicePasswords.portableDerive("password", salt, 4096)));
    }

    @Test public void unicodePasswordsAreCompatibleWithTheNativeFactory() throws Exception {
        String password = "A secure pässword🔒123";
        byte[] salt = "a sufficiently long random test salt".getBytes(StandardCharsets.UTF_8);
        PBEKeySpec spec = new PBEKeySpec(password.toCharArray(), salt, 4096, 256);
        try {
            assertArrayEquals(SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded(), DevicePasswords.portableDerive(password, salt, 4096));
        } finally { spec.clearPassword(); }
    }

    @Test public void invalidPasswordsAndMismatchedConfirmationAreRejected() {
        assertThrows(DeviceVault.Failure.class, () -> DevicePasswords.validate("weak", "weak"));
        assertThrows(DeviceVault.Failure.class, () -> DevicePasswords.validate("StrongPassword123", "different"));
        assertThrows(IllegalArgumentException.class, () -> DevicePasswords.portableDerive("password", new byte[32], 0));
    }
}
