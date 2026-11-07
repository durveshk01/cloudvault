import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const outDir = join(root, "out");
const targetDir = join(root, "..", "android-app", "app", "src", "main", "assets");

console.log("Building Next.js frontend with static export for Android...");
execSync("npx next build", {
  stdio: "inherit",
  env: {
    ...process.env,
    STATIC_EXPORT: "true",
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || "https://cloudvault-backend-wg5r.onrender.com",
  },
});

console.log(`Copying static export from ${outDir} into Android assets ${targetDir}...`);
if (existsSync(targetDir)) {
  rmSync(targetDir, { recursive: true, force: true });
}
mkdirSync(targetDir, { recursive: true });
cpSync(outDir, targetDir, { recursive: true });

console.log("Android assets successfully bundled into Android app!");
