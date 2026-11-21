# Phase 7 production hardening and release-readiness report

## Scope and baseline

Baseline: `b9170ad839bf2952774a4eb63c48841482f98a8d` (`origin/main`, merged PR #12). Branch: `fix/desktop-phase7-hardening`; Beads: `music-rj8`. Measurements were captured on this Windows host on 2026-11-20. The React design, single `HTMLAudioElement` timing authority, web IndexedDB architecture, desktop SQLite authority model, IPC capability set, persisted schema version and dependencies are unchanged.

This increment addresses confirmed defects and measured duplicated work. It is not a substitute for installed-app visual/audible acceptance, a disposable-VM upgrade trial, Authenticode signing, or a one-hour production WebView2 soak.

## Confirmed issues and fixes

### Ordered desktop persistence

Desktop `updateTrack()` previously performed separate read and write IPC operations. Concurrent patches to the same track could read the same old row and let the final writer erase fields changed by the other operation. Pending cloud-deletion and metadata-sync queues had the same read/modify/write race.

Repository mutations are now serialized by stable track or preference key. Unrelated records remain concurrent; IndexedDB keeps its existing atomic transaction path. Regressions deliberately delay reads and prove concurrent title/availability patches and queue inserts both survive.

### Playback session and teardown reliability

Playback position was persisted on start, queue edits, seek, pause and `pagehide`, but uninterrupted playback had no durable checkpoint. `pagehide` starts asynchronous storage work that process termination need not finish. Session writes are now ordered and active playback checkpoints the authoritative audio clock every 15 seconds. Pause/seek/queue/pagehide paths remain and cannot overtake one another.

Deleting the active track now uses one complete playback-runtime reset: pending loads/play promises/resume seeks are invalidated, the shared engine pauses and clears its source, active/preloaded object URLs are released, media-session state is cleared, queue/context/time/duration/errors reset, and the saved session is removed.

Cloud network errors preserve the pre-error play intent and engine position. Recovery tries one fresh signed URL per track start, honors a pause during refresh, discards late refreshes after a newer start, and surfaces a second failure.

### Startup and bulk-import work

Healthy desktop path-backed tracks previously performed an unnecessary per-track SQLite audio-blob read during startup. Availability revalidation also returned every status and rewrote the complete library even when nothing changed. The batched native path result is now decisive for healthy paths; fallback blobs are read only for unavailable paths, and only changed statuses are persisted.

Import duplicate reconciliation previously scanned the full and growing track array for exact fingerprint, tail hash, name/size and metadata candidates. One per-import index now preserves existing level-1/2/3 priority, duration/version guards and stable first-match ordering while updating incrementally after add/relink.

### Native cache and atomic filesystem behavior

Artwork cache index paths are now accepted only when they resolve to bounded, non-symlink, direct children of canonical `artwork-v1/blobs`. Every path returned to asset authorization is sanitized. Warm hits continue to check byte bounds, SHA-256 and image header/dimensions; full pixel decode remains mandatory at ingestion and thumbnail generation but is no longer repeated on every cache read.

Persistence-owned artwork writes now defer disposable-cache pruning until the SQLite transaction commits. A failed audio/artwork atomic import removes newly unreferenced files; a failed replacement restores the previous track cache mapping and shared artwork.

Corrupt or oversized native lyrics cache files are evicted after the first failed read, allowing a clean later recovery instead of reparsing the same bad file forever. A newer SQLite `user_version` refusal regression proves the database rows and version remain untouched.

## Reproducible benchmark evidence

Host and toolchain for the local runs were Windows x64 build 26200, Intel Core i5-6300U, Node 26.13.1, and Rust 1.100.0. The opt-in `GMUSIC_BENCH=1` harnesses report nearest-rank percentiles and retain the first sample. Each run writes a new output file. Raw measurements follow.

- [phase7-import-before.json](benchmarks/phase7-import-before.json)
- [phase7-import-after.json](benchmarks/phase7-import-after.json)
- [phase7-native-before.json](benchmarks/phase7-native-before.json)
- [phase7-native-after.json](benchmarks/phase7-native-after.json)
- [phase7-navigation.json](benchmarks/phase7-navigation.json)
- [phase7-playback-stress.json](benchmarks/phase7-playback-stress.json)

### Duplicate matching

100 late exact-fingerprint matches per sample, Node/Vitest algorithm only (no file parsing/hash/IPC/storage/UI):

| Library | Before p50 / p95 | After p50 / p95 | Fingerprint reads before → after |
|---:|---:|---:|---:|
| 1,000 | 20.339 / 49.737 ms | 2.192 / 4.192 ms | 200,100 → 100 |
| 10,000 | 356.477 / 485.464 ms | 1.792 / 12.042 ms | 2,000,100 → 100 |

The deterministic work reduction is the strongest evidence. The after p95 includes one 12 ms outlier; no end-to-end import latency claim is made.

### Native warm artwork cache

Exact Phase 5 synthetic 1600×1200 RGBA PNG fixture (2,164,075 encoded bytes), unoptimized Rust test profile:

| Workload | Before p50 / p95 | After p50 / p95 |
|---|---:|---:|
| Warm cache read/hash/header validation | 800.963 / 1009.661 ms | 311.623 / 321.619 ms |

Warm p50 fell about 61.1%. Cold artwork store p50 went from 2600.850 to 3181.841 ms. The cause of the cold-store increase is unresolved.

### SQLite controls

The same debug harness measured SQLite listing and reopening with synthetic records. These operations measured higher after the changes. The runs do not establish the cause of the difference.

| Workload | Tracks | Before p50 / p95 | After p50 / p95 |
|---|---:|---:|---:|
| List tracks | 1,000 | 7.247 / 9.066 ms | 7.970 / 12.608 ms |
| List tracks | 10,000 | 78.420 / 87.852 ms | 102.883 / 117.594 ms |
| Reopen, inspect status and list tracks | 10,000 | 133.554 / 150.565 ms | 174.259 / 226.912 ms |

The desktop adapter regression verifies that a healthy path issues zero fallback audio-blob reads and returns no status update when availability is unchanged. A failed path check leaves availability unchanged. This covers operation counts only. Full desktop startup and end-to-end bulk imports were not timed.

### Playlist and playback controls

Existing optimized playlist parent-route workload remained linear:

| Fixture | p50 / p95 | Track-ID reads |
|---|---:|---:|
| 1,000 tracks, 20×50 memberships | 6.176 / 17.465 ms | 1,020 |
| 10,000 tracks, 40×100 memberships | 29.388 / 32.551 ms | 10,040 |

This is jsdom parent mount/computation, not WebView paint.

Accelerated playback stress executed 10 runs × 100 stored-copy starts with repeated seeks: p50 88.587 ms, p95 179.392 ms. Object URLs ended at 1 active, 1,000 created and 999 revoked; no second audio element existed in the test DOM. This proves bounded source ownership under the synthetic workload, not audible playback, codec behavior, a one-hour duration, or WebView2 process memory.

## Recovery and parity coverage

Existing plus Phase 7 regressions cover:

- failed/quota-like atomic imports and failed native artwork/audio transactions;
- corrupt artwork and lyrics cache entries;
- transactional SQLite migration failures, interrupted migration, forced-reimport rollback, integrity failure and newer-schema refusal;
- offline positive-cache reuse and zero-network offline misses;
- handle permission changes, moved/deleted local files and stored-copy fallback;
- queue/session restoration, periodic position checkpoints and active-track removal;
- rapid track switching, repeated seeking, stale source/refresh races, shuffle/repeat/ended transitions and object-URL balance;
- web runtime zero-Tauri-IPC guards and desktop adapter response validation.

## Network and security boundary

No capability, endpoint or dependency was added. Intentional network surfaces remain metadata-only lyrics providers, MusicBrainz/CAA/iTunes artwork lookup, optional configured Supabase Auth/library sync, and authenticated Worker/R2 operations. Local audio playback does not require network; offline guards prevent provider requests; cloud initialization returns immediately when publishable configuration is absent. Native response limits, timeouts, redirect blocking and artwork-host allowlisting remain enforced. Absolute desktop paths stay local and are stripped from portable backups/cloud payloads. Signed URLs remain ephemeral.

Tracked-source secret scanning, release helper validation, dependency audit and build results are recorded in the final PR/checklist. Local `.env.local` and `.zcode/` were not read, changed or committed.

## Reproduction

```bash
# Matching benchmark: choose new output names
GMUSIC_BENCH=1 GMUSIC_BENCH_OUTPUT='C:/absolute/import.json' npm test -- src/services/library/importService.performance.test.ts

# Playlist control
GMUSIC_BENCH=1 GMUSIC_BENCH_OUTPUT='C:/absolute/navigation.json' npm test -- src/features/playlists/PlaylistsPage.performance.test.tsx

# Accelerated playback source/seek stress
GMUSIC_BENCH=1 GMUSIC_BENCH_OUTPUT='C:/absolute/playback.json' npm test -- src/stores/playbackStore.test.ts

# Native workload
GMUSIC_BENCH=1 GMUSIC_BENCH_OUTPUT='C:/absolute/native.json' cargo test --locked --manifest-path src-tauri/Cargo.toml performance_tests::desktop_performance_workloads -- --exact --test-threads=1
```

## Executed validation

- Frontend: `npm run typecheck`, `npm run lint`, full `npm test` (**976 tests / 78 files**), `npm run build`, release version validation and 3 Node release-helper tests — **PASS**. The checkpoint regression also passed independently after its assertion was tightened to require a write without manual flushing.
- Native: Rust fmt check, Clippy all targets with `-D warnings`, **71 Rust tests**, Windows x64 debug no-bundle build — **PASS**.
- Production packaging: locked optimized x64 MSI and NSIS builds with cloud configuration disabled — **PASS**. Node and PowerShell SHA-256 results agree. The MSI, NSIS and application executable are **NotSigned**. MSVC `dumpbin /dependents` reported Windows system libraries and Universal CRT API sets. WebView2 is a separate runtime prerequisite.
- Web runtime: production preview rendered the empty-library shell with exactly one audio element, active service-worker control and no Tauri marker. With the task-owned origin server stopped, reload still rendered the cached shell — **PASS** for app-shell offline behavior. Browser-host file import/audible playback was unavailable.
- Dependency audit: 8 moderate and 2 critical findings remained at runtime commit `05ebc80`; resolved on 2026-11-21 — see "Dependency security audit remediation" below.
- Windows Sandbox build 26100 with networking disabled returned MSI exit 1603 and NSIS exit 2. The MSI log identified `DownloadAndInvokeBootstrapper` as the failing action. A clean machine without WebView2 needs the runtime preinstalled or network access for the Evergreen bootstrapper. The online retry exited during MSI setup, and a separate offline retry exited during prerequisite setup with Microsoft’s signature-verified standalone installer. Neither retry recorded an exit code. Successful install and launch, versioned upgrade, uninstall data preservation, audible playback, and a one-hour process-tree soak remain unverified.

## Dependency security audit remediation (2026-11-21)

A fresh `npm audit` on `7bf1a6c` reported 8 moderate and 2 critical findings. Every flagged package is dev-only lint/test tooling resolved from `devDependencies`; none is imported by application code or bundled into the shipped web or desktop runtime.

| Cluster | Severity | Root cause | Advisories | Patched by |
|---|---|---|---|---|
| `minimatch` 10.2.6 under `@typescript-eslint/typescript-estree` (7 audit entries: the eslint plugin/parser/type-utils/utils/estree chain and direct `typescript-eslint`) | 8 moderate | globparts amplification denial of service | GHSA-g3hv-75wg-m249 | `minimatch` ≥ 11.0.1 |
| `tinypool` 1.1.1 under `vitest` 3.2.7 | 2 critical | prototype-pollution gadgets in worker options and `run()` options leading to RCE in test-worker contexts | GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr | `tinypool` ≥ 2.1.2; vitest 4 removed the dependency entirely |
| `@vitest/mocker` 3.2.7 | 1 moderate | redirect-mock path traversal and manual-mock registration injection in test contexts | GHSA-82fw-gwwq-j7x9, GHSA-qxg6-89mg-rqv8 | vitest ≥ 4.1.12 |

Production exposure: none — lint and test tooling only. Residual practical risk was limited to running first-party tests/lint in this repository.

Fix (smallest sufficient versions, no forced upgrades):

- `typescript-eslint` `^8.33.0` → `^8.73.0` (same major; `typescript-estree` now depends on patched `minimatch` `^11.0.1`).
- `vitest` `^3.2.0` → `^4.1.12`. npm's suggested fix was vitest 5.1.1, but 4.1.12 is the smallest release that both patches `@vitest/mocker` and drops the unpatchable `tinypool` chain (no vitest 3.x can use patched tinypool 2.x; a forced override would pair incompatible pool APIs). The nested `vitest` 4.1.12 already present under `@applemusic-like-lyrics/core` deduped into the single top-level copy.

Vitest 3 → 4 test adaptations (no production code changed):

- `tsconfig.app.json`: vitest 4's `vitest/globals` no longer transitively exposes Node types, so `"node"` joined `types`, restoring checkpoint state for `node:fs` / `node:perf_hooks` / `node:crypto` / `node:buffer` imports and the `process` global used by benchmark harnesses.
- Vitest 4 no longer infers concrete signatures from a bare `vi.fn()`; `DynamicIslandNotification.test.tsx` and `mediaSession.test.ts` now declare and implement their store-action mocks against the real signatures.
- Vitest 4's `vi.restoreAllMocks()` only restores `vi.spyOn` mocks, so `artworkService.test.ts` uses `vi.resetAllMocks()` in `beforeEach`; persistent `mockResolvedValue` implementations and queued once-values can no longer leak across tests.

Validation on this tree: `npm audit` reports **0 vulnerabilities** (raw output: [phase7-npm-audit-after.json](benchmarks/phase7-npm-audit-after.json)); `npm run typecheck`, `npm run lint`, full `npm test` (**976 tests / 78 files**), `npm run build`, 3 Node release-helper tests, Rust fmt check, Clippy `-D warnings` and **71 Rust tests** — all **PASS**. No capability, endpoint, runtime dependency or bundled artifact changed.

## Remaining manual acceptance

Use a disposable Windows VM/user and production installer hash. For one hour, play representative MP3 plus FLAC/M4A/WAV where supported; record app + WebView2 process-tree private/working-set/CPU every 5 seconds; seek repeatedly, rapid-switch, pause/resume, navigate playlists/lyrics, disable/re-enable network, move/revoke one file, close/restart at checkpoints, and verify perceived lyric sync. Compare start/15/30/45/60-minute memory and require no monotonic unbounded growth, duplicate audio element, accumulating handles/object URLs, playback reset on navigation, or missing checkpoint beyond the 15-second bound. This installed/audible soak, fresh install, older-version same-format upgrade, rollback, uninstall preservation and signing trust must be reported `NOT RUN` unless actually executed.
