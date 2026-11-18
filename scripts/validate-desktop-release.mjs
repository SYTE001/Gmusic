import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function validateVersions(root, tag) {
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8"));
  const config = JSON.parse(readFileSync(new URL("src-tauri/tauri.conf.json", root), "utf8"));
  const cargo = readFileSync(new URL("src-tauri/Cargo.toml", root), "utf8");
  const cargoLock = readFileSync(new URL("src-tauri/Cargo.lock", root), "utf8");
  const packageSection = cargo.match(/\[package\]([\s\S]*?)(?=\n\[|$)/)?.[1];
  const cargoVersion = packageSection?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const lockedVersion = cargoLock.match(/\[\[package\]\]\s*name = "gmusic"\s*version = "([^"]+)"/)?.[1];
  const version = config.version;
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Use a stable three-part installer version");
  const [major, minor, patch] = version.split(".").map(Number);
  assert.ok(major <= 255 && minor <= 255 && patch <= 65535, "Version exceeds MSI limits");
  for (const value of [pkg.version, lock.version, lock.packages[""].version, cargoVersion, lockedVersion]) {
    assert.equal(value, version, "npm, lockfiles, Cargo and Tauri versions must agree");
  }
  assert.equal(config.identifier, "com.gmusic.desktop", "Changing identity moves user data");
  assert.equal(config.productName, "Gmusic");
  if (tag !== undefined) assert.equal(tag, `v${version}`, "Tag must match the installer version exactly");
  return version;
}

export function validateReleaseGit(root, tag, expectedSha, repository) {
  assert.equal(repository, "SYTE001/Gmusic", "Release workflow is restricted to the canonical repository");
  assert.match(tag, /^v\d+\.\d+\.\d+$/);
  assert.match(expectedSha, /^[0-9a-f]{40}$/);
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: fileURLToPath(root), encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr || `git ${args[0]} failed`);
    return result.stdout.trim();
  };
  assert.equal(git(["rev-parse", "HEAD"]), expectedSha, "Checkout must match the triggering commit");
  assert.equal(git(["rev-parse", `refs/tags/${tag}^{commit}`]), expectedSha, "Tag moved after the event");
  git(["merge-base", "--is-ancestor", expectedSha, "refs/remotes/origin/main"]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL("../", import.meta.url);
  const tag = process.argv[2];
  const version = validateVersions(root, tag);
  if (process.env.GMUSIC_RELEASE_VERIFY_GIT === "1") {
    validateReleaseGit(root, tag, process.env.GITHUB_SHA, process.env.GITHUB_REPOSITORY);
  }
  console.log(`Validated Gmusic ${version}${tag ? ` (${tag})` : ""}`);
}
