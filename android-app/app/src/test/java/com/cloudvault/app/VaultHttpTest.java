package com.cloudvault.app;

import static org.junit.Assert.*;

import java.io.IOException;
import java.net.CookieHandler;
import java.net.URI;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import okhttp3.Response;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import org.junit.Test;

public final class VaultHttpTest {
    @Test public void neitherReadsNorWritesTheGlobalCookieHandler() throws Exception {
        CookieHandler previous = CookieHandler.getDefault();
        AtomicInteger accesses = new AtomicInteger();
        CookieHandler handler = new CookieHandler() {
            @Override public Map<String, List<String>> get(URI uri, Map<String, List<String>> headers) {
                accesses.incrementAndGet();
                return Collections.singletonMap("Cookie", Collections.singletonList("refresh_token=webview-secret"));
            }
            @Override public void put(URI uri, Map<String, List<String>> headers) { accesses.incrementAndGet(); }
        };
        CookieHandler.setDefault(handler);
        try (MockWebServer server = new MockWebServer()) {
            server.start();
            server.enqueue(new MockResponse().setBody("{}").addHeader("Set-Cookie", "access_token=native-secret; HttpOnly")
                .addHeader("Set-Cookie", "refresh_token=native-refresh; HttpOnly"));
            server.enqueue(new MockResponse().setBody("{}"));
            VaultHttp http = new VaultHttp(server.url("/").toString(), true);
            try (Response response = http.call(http.request("/api/auth/login", "POST", null, null)).execute()) { assertEquals(200, response.code()); }
            try (Response response = http.call(http.request("/api/auth/me", "GET", null, "native-secret")).execute()) { assertEquals(200, response.code()); }
            assertNull(server.takeRequest(5, TimeUnit.SECONDS).getHeader("Cookie"));
            assertNull(server.takeRequest(5, TimeUnit.SECONDS).getHeader("Cookie"));
            assertEquals(0, accesses.get());
            assertSame(handler, CookieHandler.getDefault());
        } finally { CookieHandler.setDefault(previous); }
    }

    @Test public void redirectsNeverReplayBearerTokensOrLoginBodies() throws Exception {
        try (MockWebServer server = new MockWebServer(); MockWebServer other = new MockWebServer()) {
            server.start(); other.start();
            server.enqueue(new MockResponse().setResponseCode(307).addHeader("Location", other.url("/api/stolen")));
            VaultHttp http = new VaultHttp(server.url("/").toString(), true);
            try (Response response = http.call(http.request("/api/files", "POST", VaultHttp.json("{\"password\":\"secret\"}"), "bearer-secret")).execute()) {
                assertEquals(307, response.code());
            }
            assertEquals(1, server.getRequestCount());
            assertEquals(0, other.getRequestCount());
        }
    }

    @Test public void releaseOriginsRejectCleartextAndUrlComponents() throws Exception {
        for (String origin : new String[]{"", "http://localhost:8000", "https://user:password@api.example", "https://api.example/api", "https://api.example?token=secret", "https://api.example#fragment"}) {
            assertThrows(origin, IOException.class, () -> new VaultHttp(origin, false));
        }
        assertEquals("https://api.example", new VaultHttp("https://api.example/", false).apiUrl);
        assertThrows(IOException.class, () -> new VaultHttp("http://untrusted.example", true));
    }

    @Test public void encodedOrAmbiguousRoutesCannotBypassNativeAuthInterception() throws Exception {
        for (String endpoint : new String[]{"https://untrusted.example/api/files", "//untrusted.example/api/files", "/api/auth/%6cogin", "/api/auth/login/", "/api/auth//login", "/api/files/../auth/login", "/api/files%2f..%2fauth%2flogin", "/api/files#fragment", "/api/files\r\nCookie: secret"}) {
            assertThrows(endpoint, IOException.class, () -> VaultHttp.path(endpoint));
        }
        assertEquals("/api/auth/login", VaultHttp.path("/api/auth/login?attempt=one"));
        assertEquals("/api/files", VaultHttp.path("/api/files?search=hello%20world&page=2"));
    }
}
