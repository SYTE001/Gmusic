import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { collectInstallers } from "./collect-desktop-artifacts.mjs";
import { validateReleaseGit, validateVersions } from "./validate-desktop-release.mjs";

function fixture(version = "1.1.0") {
  const dir = mkdtempSync(join(tmpdir(), "gmusic-release-test-"));
  mkdirSync(join(dir, "src-tauri"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ version, packages: { "": { version } } }));
  writeFileSync(join(dir, "src-tauri/tauri.conf.json"), JSON.stringify({ version, productName: "Gmusic", identifier: "com.gmusic.desktop" }));
  writeFileSync(join(dir, "src-tauri/Cargo.toml"), `[package]\nname = "gmusic"\nversion = "${version}"\n`);
  writeFileSync(join(dir, "src-tauri/Cargo.lock"), `[[package]]\nname = "gmusic"\nversion = "${version}"\n`);
  return { dir, root: pathToFileURL(`${dir}/`) };
}

test("release versions reject mismatch, malformed tag and MSI overflow", () => {
  const { dir, root } = fixture();
  try {
    assert.equal(validateVersions(root, "v1.1.0"), "1.1.0");
    for (const tag of ["v1.0.0", "v1.1.0-beta", "1.1.0", "v1.1.0; echo unsafe"]) assert.throws(() => validateVersions(root, tag));
    writeFileSync(join(dir, "package.json"), '{"version":"1.0.0"}');
    assert.throws(() => validateVersions(root));
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const overflow = fixture("256.1.0");
  try { assert.throws(() => validateVersions(overflow.root)); }
  finally { rmSync(overflow.dir, { recursive: true, force: true }); }
});

test("release git checks reject untrusted repository, moved tag and off-main commit", () => {
  const { dir, root } = fixture();
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git("init", "--initial-branch=main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("add", ".");
    git("commit", "-m", "fixture");
    const sha = git("rev-parse", "HEAD");
    git("tag", "v1.1.0");
    git("update-ref", "refs/remotes/origin/main", sha);
    validateReleaseGit(root, "v1.1.0", sha, "SYTE001/Gmusic");
    assert.throws(() => validateReleaseGit(root, "v1.1.0", sha, "other/fork"));
    git("switch", "-c", "untrusted");
    writeFileSync(join(dir, "untrusted"), "fixture");
    git("add", ".");
    git("commit", "-m", "off-main");
    const offMain = git("rev-parse", "HEAD");
    git("tag", "-f", "v1.1.0");
    assert.throws(() => validateReleaseGit(root, "v1.1.0", offMain, "SYTE001/Gmusic"));
    assert.throws(() => validateReleaseGit(root, "v1.1.0", sha, "SYTE001/Gmusic"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("installer staging requires exact formats and checksums without overwriting evidence", async () => {
  const { dir } = fixture();
  try {
    const bundle = join(dir, "bundle");
    for (const folder of ["msi", "nsis"]) mkdirSync(join(bundle, folder), { recursive: true });
    writeFileSync(join(bundle, "msi/Gmusic_1.1.0_x64_en-US.msi"), "synthetic MSI bytes");
    writeFileSync(join(bundle, "nsis/Gmusic_1.1.0_x64-setup.exe"), "synthetic NSIS bytes");
    const output = join(dir, "output");
    const artifacts = await collectInstallers(bundle, output, "1.1.0");
    assert.equal(artifacts.length, 2);
    assert.match(artifacts[0].sha256, /^[0-9a-f]{64}$/);
    assert.ok(readFileSync(join(output, "SHA256SUMS.txt"), "utf8").includes(artifacts[0].sha256));
    await assert.rejects(collectInstallers(bundle, output, "1.1.0"));
    writeFileSync(join(bundle, "msi/stale.msi"), "old");
    await assert.rejects(collectInstallers(bundle, join(dir, "stale-output"), "1.1.0"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
