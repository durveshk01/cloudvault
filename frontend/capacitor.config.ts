import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.cloudvault.app",
  appName: "CloudVault",
  webDir: ".next-android",
  android: {
    path: "../android-app",
    backgroundColor: "#ffffff",
    allowMixedContent: false,
    minWebViewVersion: 74,
  },
  server: { androidScheme: "https", hostname: "localhost" },
  plugins: {
    Vault: {
      apiUrl: process.env.VAULT_MODE === "cloud" ? process.env.NEXT_PUBLIC_API_URL || "" : "",
    },
    SplashScreen: {
      launchShowDuration: 0,
      launchAutoHide: true,
      backgroundColor: "#4f46e5",
      showSpinner: false,
    },
    CapacitorHttp: { enabled: false },
  },
};

export default config;
