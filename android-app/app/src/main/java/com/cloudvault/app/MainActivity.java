package com.cloudvault.app;

import android.app.Activity;
import android.app.DownloadManager;
import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

public final class MainActivity extends Activity {
    private static final String START_URL = "https://cloudvault-frontend-tnwe.onrender.com/";
    private static final String APP_HOST = "cloudvault-frontend-tnwe.onrender.com";
    private static final int FILE_PICKER_REQUEST = 4102;
    private static final int DOWNLOAD_PERMISSION_REQUEST = 4103;

    private WebView webView;
    private ValueCallback<Uri[]> filePickerCallback;
    private Uri pendingDownloadUri;
    private String pendingDownloadName;
    private String pendingDownloadMime;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(0xFF050B1D);
        getWindow().setNavigationBarColor(0xFF050B1D);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, false);

        webView.addJavascriptInterface(new AndroidDownloads(), "CloudVaultAndroid");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("https".equals(uri.getScheme()) && (APP_HOST.equals(uri.getHost()) || (uri.getHost() != null && uri.getHost().endsWith(".onrender.com")))) return false;
                openExternal(uri);
                return true;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filePickerCallback != null) filePickerCallback.onReceiveValue(null);
                filePickerCallback = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(intent, FILE_PICKER_REQUEST);
                    return true;
                } catch (ActivityNotFoundException exception) {
                    filePickerCallback = null;
                    callback.onReceiveValue(null);
                    Toast.makeText(MainActivity.this, "No file picker is available on this device.", Toast.LENGTH_LONG).show();
                    return false;
                }
            }
        });
        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimeType, long contentLength) {
                Uri uri = Uri.parse(url);
                if (!"https".equals(uri.getScheme()) || !(APP_HOST.equals(uri.getHost()) || (uri.getHost() != null && uri.getHost().endsWith(".onrender.com")))) {
                    openExternal(uri);
                    return;
                }
                enqueueDownload(uri, URLUtil.guessFileName(url, contentDisposition, mimeType), mimeType);
            }
        });

        if (savedInstanceState == null) webView.loadUrl(START_URL);
        else webView.restoreState(savedInstanceState);
    }

    private void openExternal(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException exception) {
            Toast.makeText(this, "No app can open this link.", Toast.LENGTH_LONG).show();
        }
    }

    private void enqueueDownload(Uri uri, String filename, String mimeType) {
        filename = sanitizeFilename(filename);
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P
                && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            pendingDownloadUri = uri;
            pendingDownloadName = filename;
            pendingDownloadMime = mimeType;
            requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, DOWNLOAD_PERMISSION_REQUEST);
            return;
        }
        CookieManager.getInstance().flush();
        String cookie = CookieManager.getInstance().getCookie(uri.toString());
        DownloadManager.Request request = new DownloadManager.Request(uri)
                .setTitle(filename)
                .setDescription("Downloading from CloudVault")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setAllowedOverMetered(true)
                .setAllowedOverRoaming(false);
        if (cookie != null) request.addRequestHeader("Cookie", cookie);
        if (mimeType != null) request.setMimeType(mimeType);
        request.setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS, "CloudVault/" + filename);
        try {
            ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(request);
            Toast.makeText(this, "Download started. Check your notifications.", Toast.LENGTH_SHORT).show();
        } catch (RuntimeException exception) {
            Toast.makeText(this, "Could not start the download. Please try again.", Toast.LENGTH_LONG).show();
        }
    }

    private String sanitizeFilename(String filename) {
        if (filename == null) return "download";
        String safe = filename.replaceAll("[/\\\\\\r\\n]", "_").trim();
        return safe.isEmpty() ? "download" : safe;
    }

    private final class AndroidDownloads {
        @JavascriptInterface
        public boolean downloadFile(String fileId, String filename) {
            return downloadFileWithToken(fileId, filename, null);
        }

        @JavascriptInterface
        public boolean downloadFileWithToken(String fileId, String filename, String token) {
            if (fileId == null || !fileId.matches("[0-9a-fA-F-]{36}")) return false;
            Uri.Builder builder = Uri.parse(START_URL).buildUpon()
                    .appendPath("api")
                    .appendPath("files")
                    .appendPath(fileId)
                    .appendPath("download")
                    .appendQueryParameter("direct", "true");
            if (token != null && !token.isEmpty()) {
                builder.appendQueryParameter("token", token);
            }
            Uri uri = builder.build();
            runOnUiThread(() -> enqueueDownload(uri, filename == null ? "download" : filename, null));
            return true;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_PICKER_REQUEST || filePickerCallback == null) return;
        Uri[] results = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                results = new Uri[count];
                for (int i = 0; i < count; i++) results[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) results = new Uri[]{data.getData()};
        }
        filePickerCallback.onReceiveValue(results);
        filePickerCallback = null;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != DOWNLOAD_PERMISSION_REQUEST || pendingDownloadUri == null) return;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            enqueueDownload(pendingDownloadUri, pendingDownloadName, pendingDownloadMime);
        } else {
            Toast.makeText(this, "Storage permission is needed to save the download.", Toast.LENGTH_LONG).show();
        }
        pendingDownloadUri = null;
        pendingDownloadName = null;
        pendingDownloadMime = null;
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        if (webView != null) webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (filePickerCallback != null) filePickerCallback.onReceiveValue(null);
        if (webView != null) {
            webView.removeJavascriptInterface("CloudVaultAndroid");
            webView.destroy();
        }
        super.onDestroy();
    }
}
