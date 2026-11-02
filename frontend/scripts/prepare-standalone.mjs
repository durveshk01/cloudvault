import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const standalone = join(root, ".next", "standalone");

if (!existsSync(join(standalone, "server.js"))) {
  throw new Error("Next.js standalone server was not produced by the build.");
}

for (const directory of ["static", "server"]) {
  const source = join(root, ".next", directory);
  if (existsSync(source)) {
    const destination = join(standalone, ".next", directory);
    mkdirSync(destination, { recursive: true });
    cpSync(source, destination, { recursive: true, force: true });
  }
}

const publicDir = join(root, "public");
if (existsSync(publicDir)) {
  cpSync(publicDir, join(standalone, "public"), { recursive: true, force: true });
}

console.log("Copied Next.js static assets into the standalone runtime.");
