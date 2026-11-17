package com.cloudvault.app;

import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebView;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;

/** Native bridge, secure file transfer workers and Android lifecycle integration. */
public final class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        SplashScreen.installSplashScreen(this);
        registerPlugin(VaultPlugin.class);
        super.onCreate(savedInstanceState);
        // Migrate away from WebView auth cookies left by earlier native HTTP implementations.
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(false);
        cookies.setAcceptThirdPartyCookies(getBridge().getWebView(), false);
        cookies.removeAllCookies(null);
        cookies.flush();
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
    }
}
