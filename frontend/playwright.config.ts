import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure" },
  // Full Chromium includes the built-in PDF viewer; headless-shell cannot
  // verify whether a PDF actually opens in its iframe.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel: "chromium" } }],
  webServer: {
    command: "node .next/standalone/server.js",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    env: { PORT: "3100", HOSTNAME: "127.0.0.1" },
    timeout: 60_000,
  },
});
