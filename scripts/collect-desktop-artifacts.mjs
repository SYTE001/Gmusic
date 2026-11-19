import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateVersions } from "./validate-desktop-release.mjs";

export async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function collectInstallers(bundleRoot, output, version) {
  // Create a fresh staging directory; never mix old/rebuilt artifacts silently.
  await mkdir(output);
  const artifacts = [];
  for (const [format, suffix] of [["msi", "_x64_en-US.msi"], ["nsis", "_x64-setup.exe"]]) {
    const expectedName = `Gmusic_${version}${suffix}`;
    const folder = join(bundleRoot, format);
    const installers = (await readdir(folder)).filter((name) => name.endsWith(format === "msi" ? ".msi" : ".exe"));
    assert.deepEqual(installers, [expectedName], `Expected exactly one current ${format} installer`);
    const source = join(folder, expectedName);
    const info = await stat(source);
    assert.ok(info.isFile() && info.size > 0, "Installer is empty or not a file");
    const target = join(output, expectedName);
    await copyFile(source, target);
    artifacts.push({ file: basename(target), bytes: info.size, sha256: await hashFile(target) });
  }
  await writeFile(join(output, "SHA256SUMS.txt"), artifacts.map((artifact) => `${artifact.sha256}  ${artifact.file}\n`).join(""), { flag: "wx" });
  await writeFile(join(output, "artifacts.json"), JSON.stringify({ version, target: "x86_64-pc-windows-msvc", artifacts }, null, 2) + "\n", { flag: "wx" });
  return artifacts;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = validateVersions(new URL("../", import.meta.url));
  const bundleRoot = resolve(process.argv[2] ?? "src-tauri/target/x86_64-pc-windows-msvc/release/bundle");
  assert.ok(process.argv[3], "Provide a new output directory");
  console.log(JSON.stringify(await collectInstallers(bundleRoot, resolve(process.argv[3]), version), null, 2));
}
