import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import acorn from "next/dist/compiled/acorn/acorn.js";

// Release APKs use the native encrypted device vault. A developer can explicitly
// choose cloud mode for backend integration testing; it is never the default.
const mode = process.env.VAULT_MODE || "device";
if (!["device", "cloud"].includes(mode)) throw new Error("VAULT_MODE must be device or cloud.");
const apiUrl = mode === "cloud" ? process.env.NEXT_PUBLIC_API_URL : "";
if (mode === "cloud") {
  if (!apiUrl) throw new Error("Cloud integration builds require NEXT_PUBLIC_API_URL.");
  const url = new URL(apiUrl);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("NEXT_PUBLIC_API_URL must be a backend origin.");
  }
  if (url.protocol !== "https:" && !(process.env.ANDROID_DEBUG === "true" && url.protocol === "http:" && ["10.0.2.2", "127.0.0.1", "localhost"].includes(url.hostname))) {
    throw new Error("Cloud integration builds require HTTPS, or an explicit local debug origin.");
  }
}
const env = { ...process.env, VAULT_MODE: mode, NEXT_PUBLIC_VAULT_MODE: mode, NEXT_PUBLIC_API_URL: (apiUrl || "").replace(/\/$/, ""), NEXT_TELEMETRY_DISABLED: "1" };

console.log("Building Next.js frontend with static export for Android...");
execSync("npx next build", {
  stdio: "inherit",
  env: { ...env, STATIC_EXPORT: "true" },
});

for (const route of ["index.html", "files/index.html", "login/index.html", "register/index.html", "offline/index.html", "share/index.html"]) {
  if (!existsSync(new URL(`../.next-android/${route}`, import.meta.url))) {
    throw new Error(`The Android static export is missing ${route}.`);
  }
}

// Native tests cannot catch a JavaScript dependency that crashes after login.
// Reject newer syntax in every route chunk, including lazy-loaded dependencies.
const exported = fileURLToPath(new URL("../.next-android", import.meta.url));
for (const asset of readdirSync(exported, { recursive: true }).filter(name => name.endsWith(".js"))) {
  try { acorn.parse(readFileSync(path.join(exported, asset), "utf8"), { ecmaVersion: 2019, sourceType: "module" }); }
  catch (error) { throw new Error(`Android WebView compatibility check failed for ${asset}: ${error.message}`); }
}

console.log("Syncing Capacitor plugins and the static frontend into Android...");
// Capacitor owns this generated directory. Clear legacy root-level bundles as
// well as the previous public/ export before copying the freshly built assets.
rmSync(new URL("../../android-app/app/src/main/assets", import.meta.url), { recursive: true, force: true });
execSync("npx cap sync android", { stdio: "inherit", env });
console.log("Android native project and bundled frontend synchronized.");
