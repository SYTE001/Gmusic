# Windows desktop release engineering

## Current status

Phase6A prepares build/CI and **draft-only** release infrastructure. It does not authorize publication. `music-lua` remains open for real desktop performance/runtime certification. Installer creation is not installation, upgrade or audible playback acceptance. No auto-updater or signing trust strategy is enabled.

Application identity stays `com.gmusic.desktop`, product `Gmusic`, version `1.1.0`. npm and its lockfile are aligned to the pre-existing Cargo/Tauri version; no release tag is created by this change. MSI upgrade code is explicitly pinned to the existing Tauri-derived `a3fbb68b-561c-5177-b577-1b65d5af5bbc`. Do not change identity, product name, publisher (`gmusic`, preserving the previous identifier-derived default) or upgrade code casually: identity determines data directories and installer discovery.

## Reproducible inputs and build commands

- `npm ci` uses committed `package-lock.json`; do not use `npm install` to regenerate release inputs.
- `rust-toolchain.toml` pins Rust1.100.0, rustfmt/Clippy and x86_64 MSVC. Cargo commands use `--locked`; do not update dependencies during packaging.
- CI pins Node26.13.1, Ubuntu24.04/web and Windows2022/MSVC jobs, and immutable action SHAs. Runner images, system SDK/WebView2 and bundler downloads still evolve. This is reproducible input resolution, **not a bit-identical installer guarantee** (timestamps/signing/container metadata can differ).
- Tauri CLI2.12.4 is resolved from the npm lockfile; `npm run desktop:build` uses that local CLI.

From the repository root on Windows with MSVC Build Tools and WebView2:

```bash
npm ci
node scripts/validate-desktop-release.mjs
node --test scripts/desktop-release.node-test.mjs
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run typecheck
npm run lint
npm test
npm run build
npm run desktop:build -- --ci --target x86_64-pc-windows-msvc --bundles msi,nsis -- --locked
node scripts/collect-desktop-artifacts.mjs src-tauri/target/x86_64-pc-windows-msvc/release/bundle C:/absolute/new-evidence-folder
```

No `--debug` in production build. Collector requires one correctly versioned installer of each format, non-empty files and a **new** staging directory. It streams SHA-256 and creates `SHA256SUMS.txt` + `artifacts.json` (filenames, byte sizes, hashes). Verify hashes after transfer with `Get-FileHash -Algorithm SHA256` or `sha256sum --strict --check SHA256SUMS.txt`. Checksums detect corruption but do not authenticate the publisher.

Expected filenames:
- `Gmusic_1.1.0_x64_en-US.msi`
- `Gmusic_1.1.0_x64-setup.exe`

## Installer behavior

- **NSIS**: explicitly `currentUser`, English, existing Gmusic ICO for installer/uninstaller; normal current-user install does not require elevation. Stock uninstall offers **Delete application data**; leave unchecked to preserve library. Never enable it during upgrade/QA against real data.
- **MSI**: stock Tauri WiX template installs per-machine, generally requires elevation; no speculative custom per-user template. Stable upgrade code links future MSI versions. Prefer NSIS for per-user distribution. Do not mix installer formats during upgrades without dedicated QA.
- **WebView2**: Evergreen `downloadBootstrapper`, silent mode. Already-installed runtime is reused; a machine without it needs internet/admin policy permitting Microsoft's runtime installation. Offline runtime-free installation is not claimed. Enterprise distributions may preinstall Evergreen; do not disable requirements.
- **Downgrades**: normal MSI and silent/passive NSIS downgrade paths are blocked (`allowDowngrades:false`). Interactive NSIS can permit an uninstall/reinstall sequence; treat that as manual recovery, not schema downgrade support.
- No installer SQL/data-reset hooks are added. SQLite stays under Tauri app data `com.gmusic.desktop/persistence-v1/gmusic.sqlite3`, with WAL/SHM companions. WebView2/IndexedDB, accepted/manual lyrics/prefs, persistent artwork and discovery caches remain under existing app data/cache ownership. The package changes do not relocate these paths.
- Close Gmusic before upgrade. Back up portable metadata and a consistent **closed-process copy** of the whole app data/local-data/cache directories, including database companions and durable artwork. Do not copy a live database file alone. Original audio files remain untouched.

## CI behavior

`.github/workflows/ci.yml`: PRs targeting main and pushes to main, plus reusable invocation from release workflow. No path filters or `continue-on-error`; every failure is visible. PR superseded runs cancel; main runs and release runs do not auto-cancel. Web job: locked npm install/version-helper tests/typecheck/lint/full Vitest/production build. Windows job: pinned toolchain/fmt/Clippy/full Rust tests/Tauri debug compilation including web build. Worker packages are unchanged and have separate scopes.

Permissions are read-only; checkout does not persist credentials. npm download cache and Cargo registry/git/target cache are keyed by lockfile, pinned toolchain, purpose and ref. No cross-ref target restore-prefix, preventing untrusted PR-produced artifacts from being reused in releases. Cache is a build accelerator, never authoritative release evidence. Quality timeout20min/web,60min/Windows; packaging90min, small release control jobs10min.

Before enabling branch protection, require **Web quality** and **Windows native quality** (confirm exact displayed check names after first run). This change does not edit repository rules/settings automatically. Workflow execution on hosted runners must be reported separately from local command success.

## Draft pipeline: disabled until explicit maintainer setup

`.github/workflows/release.yml` listens for `v*` tag pushes, but it **fails closed** unless repository variable `DESKTOP_DRAFT_RELEASE_ENABLED` equals `true`. There is no `workflow_dispatch`, release-publication event, `pull_request_target`, auto-tag creation or update mechanism.

Maintainer setup (human-controlled, not performed by this implementation):
1. Protect `main`, require CI/reviews and restrict who can create/update/delete version tags (GitHub tag rulesets). Prefer immutable annotated/signed tags; never move a shipped tag.
2. Create environment **desktop-release**, require one or more maintainer reviewers, prevent self-review, disable administrator bypass, and allow a single custom deployment policy of type **tag**, name **v***. Workflow explicitly inspects these protections and fails if absent/misconfigured or API permission cannot verify them.
3. Only after protection and QA readiness, set repository variable `DESKTOP_DRAFT_RELEASE_ENABLED=true`.
4. Keep publication a separate manual owner action after [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md), signing/acceptance and `music-lua` certification. The draft workflow never publishes.

To prepare a future version, change npm/Cargo/Tauri versions together using npm tooling for its lockfile, update the Cargo lock package via Cargo, run all gates, merge the version commit to main, then **a maintainer** creates/pushes `v<major>.<minor>.<patch>`. No prerelease/build suffix accepted by the strict MSI version gate; limits255/255/65535. Example sequence for the currently configured version (instructions only, no tag created here):

```bash
node scripts/validate-desktop-release.mjs v1.1.0
git tag -a v1.1.0 <reviewed-main-commit> -m "Gmusic1.1.0"
git push origin v1.1.0
```

Pipeline validates canonical repository, exact tag/version across config/lockfiles, checkout/event/tag commit equality and reachability from main. Reusable quality gates must pass before release-mode installers and checksum staging. Upload/download actions are commit-pinned; draft job receives only same-run artifacts, checks exact filenames/count/hashes and rechecks live tag/main ancestry. Only **draft job** has `contents:write`, after environment approval. It performs no checkout/npm/cargo/repository script execution with the write token. Existing tag releases cause failure; no clobber/edit/publish fallback.

Tag controls/environment are essential: workflow code from an untrusted tag cannot be made trustworthy solely by a script inside that tag. Never allow arbitrary users to push release tags. Before enabling, audit workflow SHAs and protection settings. GitHub-hosted approval/release path remains unexecuted until an approved real release candidate; do not create a dummy public release to test it.

## Signing and secrets

Phase6A builds **unsigned** installers; Windows SmartScreen/Unknown publisher prompts are expected. SHA256 does not replace Authenticode. Publisher metadata is not a verified identity.

No certificate/private key/password is stored in git or npm/frontend variables. Optional Authenticode signing must be added through a separately reviewed protected build job using environment GitHub Secrets (for example `WINDOWS_CERTIFICATE_PFX_BASE64`, `WINDOWS_CERTIFICATE_PASSWORD`, or hardware/cloud signing service credentials), ephemeral certificate import/removal and a trusted RFC3161 timestamp service. Tauri supports certificate thumbprint/timestamp/sign-command configuration; do not expose secrets in logs, artifacts, command-line arguments or web bundles. Verify both installers and embedded executables with `Get-AuthenticodeSignature`/`signtool verify`, **then** generate checksums. Current workflow does not claim signing merely because secrets exist. Updater keys (`TAURI_SIGNING_PRIVATE_KEY`) are a different trust model and are not configured.

## Upgrade, rollback and uninstall QA

Use a disposable Windows VM/user, never install/uninstall over someone's existing library without confirmation. Fresh install should verify shortcut identity, launch, real WebView2, native SQLite authority/init, playable audio import, single-clock pause/seek/transition, artwork and manual lyric/offset restart persistence. Upgrade from a prior MSI/NSIS of the **same format**, preserve data/database/artwork/lyrics/IDs, and verify rollback on installer failure. Same-version rebuilds are not a versioned upgrade test.

Rollback: stop app, preserve diagnostics and closed-process backup; remove/reinstall binaries without deleting app data. Older schema support is not guaranteed—newer `user_version` is rejected, never delete database to bypass it. Restore a compatible backup only with explicit confirmation. If install fails, do not repair by clearing SQLite/IndexedDB. Uninstall must leave original audio intact; explicitly selecting NSIS delete-data is destructive. MSI normally removes installation files, not per-user app storage; verify in VM instead of assuming.

## Evidence and limitations

Executed build hashes, gates and hosted CI outcomes are recorded in the PR and [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md). `music-lua` stays open. Existing npm audit findings (8 moderate/2 critical) are unresolved separate security work; no forced updates. Third-party notices/license review, signing, real installer fresh/upgrade/uninstall acceptance and release approval must be completed before publication. No public GitHub Release is created by Phase6A.
