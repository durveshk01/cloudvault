package com.cloudvault.app;

import java.io.IOException;
import java.net.URI;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.CookieJar;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;

/** Isolated transport: never consults the process/WebView CookieHandler or follows redirects. */
final class VaultHttp {
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private final OkHttpClient client;
    final String apiUrl;

    VaultHttp(String origin, boolean debug) throws IOException {
        apiUrl = origin == null ? "" : origin.replaceAll("/+$", "");
        try {
            URI base = URI.create(apiUrl);
            boolean local = debug && "http".equals(base.getScheme()) &&
                ("10.0.2.2".equals(base.getHost()) || "127.0.0.1".equals(base.getHost()) || "localhost".equals(base.getHost()));
            if ((!"https".equals(base.getScheme()) && !local) || base.getHost() == null || base.getUserInfo() != null ||
                base.getQuery() != null || base.getFragment() != null || (base.getPath() != null && !base.getPath().isEmpty())) {
                throw new IllegalArgumentException();
            }
        } catch (IllegalArgumentException exception) {
            throw new IOException("This Android build needs a valid HTTPS backend URL.");
        }
        client = new OkHttpClient.Builder().cookieJar(CookieJar.NO_COOKIES)
            .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
            .connectTimeout(15, TimeUnit.SECONDS).readTimeout(90, TimeUnit.SECONDS)
            .writeTimeout(90, TimeUnit.SECONDS).callTimeout(15, TimeUnit.MINUTES).build();
    }

    static String path(String endpoint) throws IOException {
        try {
            URI uri = URI.create(endpoint);
            String path = uri.getRawPath();
            // Route segments never need escaping; rejecting aliases prevents bypassing auth interception.
            if (endpoint.length() > 16_384 || uri.isAbsolute() || uri.getRawAuthority() != null || uri.getRawFragment() != null ||
                path == null || !path.matches("/api/[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*")) throw new IllegalArgumentException();
            return path;
        } catch (IllegalArgumentException | NullPointerException exception) {
            throw new IOException("Invalid API path.");
        }
    }

    static RequestBody json(Object body) {
        return body == null || body == org.json.JSONObject.NULL ? null : RequestBody.create(body.toString(), JSON);
    }

    Request.Builder request(String endpoint, String method, RequestBody body, String token) throws IOException {
        path(endpoint);
        if (method == null || !method.matches("GET|POST|PATCH|DELETE")) throw new IOException("Unsupported HTTP method.");
        if (body == null && (method.equals("POST") || method.equals("PATCH"))) body = RequestBody.create(new byte[0], null);
        Request.Builder request = new Request.Builder().url(apiUrl + endpoint).method(method, body)
            .header("Accept", "application/json").header("Origin", "https://localhost");
        if (token != null) request.header("Authorization", "Bearer " + token);
        return request;
    }

    Call call(Request.Builder request) { return client.newCall(request.build()); }
}
