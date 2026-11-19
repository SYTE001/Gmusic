# Windows release acceptance checklist

This is a release gate, not task tracking. Phase6A does **not** publish a release. Keep Beads `music-lua` open until actual desktop runtime certification is complete. A generated installer or green unit suite alone is not release acceptance.

## Build/CI gates

| Gate | Phase6A evidence/status |
|---|---|
| Latest baseline includes merged PR#10 | Verified `origin/main`9fe8936 |
| Baseline lockfile install | First `npm ci` failed EPERM on preview-held native DLL; after stopping task-owned preview processes, rerun PASS |
| Baseline Rust fmt/Clippy/tests | PASS,61 tests |
| Baseline frontend typecheck/lint/tests/build | PASS,947 tests/75 files |
| Version/identity/lockfile/tag helper regressions | PASS,3 Node tests; mismatch/off-main/moved tag/stale artifact rejection |
| Final local Rust/frontend quality gates | PASS: fmt, Clippy `-D warnings`,61Rust tests, typecheck/lint/947Vitest tests75files/webbuild;3Node helper tests. Initial Node-test autodiscovery failure recorded below |
| Production MSI and NSIS build | PASS, optimized release mode x64 MSVC with locked Cargo; release compilation20m55s on this host |
| Actual installer names/byte sizes/SHA256 | Verified below; streaming Node hashes match independent PowerShell Get-FileHash |
| Hosted PR CI | [44389353322](https://github.com/SYTE001/Gmusic/actions/runs/44389353322) SUCCESS, Web quality + Windows native quality incl Tauri compilation; implementation commitf27f020 |
| Public release/tag publication | NOT EXECUTED; not authorized |

## Production artifact evidence (2026-11-19 local)

Windows11 10.0.26200 x64, i5-6300U/8GB, Rust1.100.0 MSVC, Node26.13.1, locked Tauri CLI2.12.4. Built from implementationf27f020 (same runtime sources as main9fe8936). Exact command: `npm run desktop:build -- --ci --target x86_64-pc-windows-msvc --bundles msi,nsis -- --locked`; exited0, `Finished release profile [optimized]`, two bundles. No debug substitute.

| Artifact | Bytes | SHA-256 | Authenticode |
|---|---:|---|---|
| `Gmusic_1.1.0_x64_en-US.msi` |7,798,784|`01f60cd4199fd8efa07c41fb711bce05d86fdaee9e07d26c930c062fb4f9355d`|NotSigned|
| `Gmusic_1.1.0_x64-setup.exe` |5,615,076|`e0ed420e49dc1d333e5aa524c941bec3141fd1be88a4d9e1ad2253850810fcbf`|NotSigned|

Raw manifest: [phase6a-artifacts.json](benchmarks/phase6a-artifacts.json). Generated WXS/NSIS inspection confirms preserved manufacturer `gmusic`, MSI upgrade GUID, MSI perMachine/NSIS currentUser, Evergreen downloadBootstrapper and no added data-reset hooks. This is configuration/build evidence, not a successful upgrade/uninstall trial.

Development failures retained: first baseline npmci EPERM due task-owned preview DLL lock; after stopping only those owned processes npmci passed (existing10audit findings). First final Vitest run reported No test suite found for new Node-runner `.test.mjs`, while947frontend tests passed. Renamed `.node-test.mjs` with explicit Node invocation; full rerun947/947 and3Node tests passed. No test disabled/excluded/assertion weakened. actionlint1.7.12 passed both workflows; shellcheck/pyflakes unavailable and not claimed. No disposable WindowsSandbox/VirtualBox command found; fresh-install/runtime/upgrade/uninstall not attempted on the user's live profile.

No release tag, GitHub Release, signing secret, environment protection or updater was created/enabled. `music-lua` remains open.

## Required human gates before public publication

| Acceptance gate | Status |
|---|---|
| Configure main/tag rulesets and restrict tag creation/mutation | Not changed by this implementation |
| Protect `desktop-release` with non-self reviewers/no admin bypass/single `v*` tag policy | Not configured; pipeline fails closed |
| Explicitly enable `DESKTOP_DRAFT_RELEASE_ENABLED` | Not enabled |
| Review exact tag/version/main commit and successful quality jobs | Required for every candidate |
| Authenticode signing and timestamp validation (MSI, NSIS, app EXE) | Unverified; Phase6A installers unsigned |
| Verify SHA256 against exact signed artifacts and downloaded copies | Required; checksums are not signatures |
| Third-party redistribution notices/license review | Required before publication |
| Resolve/triage existing dependency audit findings | Existing8 moderate/2 critical, separate security work |
| Fresh MSI install in disposable Windows environment | Unverified |
| Fresh per-user NSIS install | Unverified |
| Launch/real WebView2/native SQLite init/authority | Unverified for installed production packages |
| Audio import/play/pause/seek/track transitions | Unverified for installed production packages |
| Artwork/manual lyrics/offset/settings persistence after restart | Unverified for installed production packages |
| Same-format upgrade from an older version preserves SQLite/IDs/artwork/lyrics/audio links | Unverified; same-version rebuild is not an upgrade test |
| Interrupted install/upgrade rollback and newer-schema refusal | Installer path unverified; existing native transaction tests pass |
| Uninstall preserves user data by default and never removes original audio | Unverified; NSIS explicit Delete application data is destructive |
| Runtime/performance/long playback certification | `music-lua` OPEN |
| Maintainer approves draft contents and manually publishes | Not executed; workflow never publishes |

## Manual test protocol

Use a disposable Windows VM/user with a recorded pre-test snapshot. Record OS/MSVC/WebView2 version, installer hash, format, version and test date. Do not overwrite an existing user's profile. Check [RELEASE.md](RELEASE.md) for data paths and consistent closed-process backup requirements.

For each format separately: install fresh, launch, import representative playable MP3 plus another supported format, persist artwork/manual timed lyrics and offset, create/reorder playlist, pause/seek/skip, close/restart offline, confirm SQLite authority and data retention. Upgrade from an earlier version in the same format; preserve library counts/IDs/settings/local paths/manual lyrics/persistent artwork. Uninstall without selecting NSIS delete-data and verify remaining local app data plus untouched original audio. Record pass/fail and actual logs/screenshots; do not infer runtime success from packaging.

Rollback tests need an older compatible schema/backup and explicit confirmation before restore. Never clear SQLite/IndexedDB as a shortcut. Certificate signing and release approval cannot be substituted by SHA256 hashes or publisher text.
