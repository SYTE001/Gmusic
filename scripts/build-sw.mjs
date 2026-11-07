/**
 * Post-build step: injects the hashed asset list into dist/service-worker.js
 * so the worker precaches the exact app shell. Keeps the SW dependency-free.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const distDir = path.resolve("dist");

async function collectPrecacheUrls() {
  const urls = ["/manifest.webmanifest"];
  const assetsDir = path.join(distDir, "assets");
  for (const entry of await readdir(assetsDir)) {
    urls.push(`/assets/${entry}`);
  }
  const iconsDir = path.join(distDir, "icons");
  for (const entry of await readdir(iconsDir)) {
    urls.push(`/icons/${entry}`);
  }
  return urls;
}

const swPath = path.join(distDir, "service-worker.js");
let swSource = await readFile(swPath, "utf8");

const urls = await collectPrecacheUrls();
const manifest = JSON.stringify(urls, null, 2);
const buildHash = createHash("sha256")
  .update(swSource + manifest)
  .digest("hex")
  .slice(0, 10);

swSource = swSource.replace("[]; // @precache-inject@", `${manifest};`);
swSource = swSource.replace("__BUILD_HASH__", buildHash);

await writeFile(swPath, swSource, "utf8");
console.log(`service-worker.js updated: ${urls.length} precached URLs, cache v${buildHash}`);
