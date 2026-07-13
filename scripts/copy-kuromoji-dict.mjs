// Copy the kuromoji dictionary into public/kuromoji-dict so kuroshiro can load
// it via the app asset scope (dev and production build alike). Runs from
// predev/prebuild. Skips work if the dict is already present.
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "node_modules/kuromoji/dict");
const dest = resolve(root, "public/kuromoji-dict");

async function main() {
  if (!existsSync(src)) {
    console.warn(`[copy-dict] kuromoji dict not found at ${src}; skipping.`);
    return;
  }
  if (existsSync(dest)) {
    const files = await readdir(dest);
    if (files.some((f) => f.endsWith(".dat.gz"))) {
      const s = await stat(dest);
      console.log(`[copy-dict] dict already present (${files.length} files, ${s.mtime.toISOString()}).`);
      return;
    }
  }
  await mkdir(dest, { recursive: true });
  await cp(src, dest, { recursive: true });
  console.log(`[copy-dict] copied kuromoji dict -> ${dest}`);
}

main().catch((e) => {
  console.error("[copy-dict] failed:", e);
  process.exit(1);
});
