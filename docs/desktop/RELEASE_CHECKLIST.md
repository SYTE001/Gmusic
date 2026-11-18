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
| Final local Rust/frontend quality gates | Pending completion; report executed outcomes before delivery |
| Production MSI and NSIS build | Pending completion; release mode, x64 MSVC, locked Cargo |
| Actual installer names/byte sizes/SHA256 | Record after generated files exist; no placeholder hashes |
| Hosted PR CI | Record actual workflow runs after push/PR; local execution is not hosted evidence |
| Public release/tag publication | NOT EXECUTED; not authorized |

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
