# Phase 5 performance and reliability report

## Scope and baseline

Baseline: `096d1cf35865861d989a4d3f02e2348d531dc29e` (`origin/main`, merged PR #9). Branch: `feat/desktop-phase5-perf`; Beads: `music-6h4`. Measurements were executed on this Windows host on 2026-11-19 local time. No user library, audio, SQLite database or account was used. No UI design, audio clock, lyrics renderer, database schema, IPC permissions or dependency changes.

**This is a measured native/Node profiling increment, not complete desktop performance certification.** Real WebView2 application startup, full audio import, audible playback, long-duration soak and production-release measurements remain unverified. Do not interpret metadata insert timings as end-to-end audio import timings.

## Hardware and methodology

- Intel Core i5-6300U @ 2.40 GHz, 2 cores / 4 logical processors.
- 8,260,544 KiB visible RAM; SanDisk SD9TB8W256G1001 disk.
- Windows 11 Pro, version 10.0.26200; x86_64-pc-windows-msvc.
- Rust 1.100.0 / Cargo 1.100.0; Node 26.13.1 / npm 11.9.0; Vitest 3.2.7.
- Rust test **unoptimized debug** profile with debug symbols. No release extrapolation or estimate is claimed.
- Native benchmark runs used the same harness, one test thread and new `tempfile` roots, without concurrent compilation or frontend benchmarks. Raw sample order retained; no warm-up excluded. First-use samples are retained in percentiles. p50/p95 use nearest rank, 9 samples for insert/cold/image/scan workloads and 25 for read/update/parse workloads. Small-sample p95 (9 samples) is the maximum, not a reliable population tail estimate.
- Synthetic tracks include title, artist, album, duration, file information, fingerprint and desktop access mode. Inserts use existing public `put_tracks` in 200-row transactions. Each sample empties only its own fixture table; it includes that DELETE in the timed region. Listing, serialization, 100-record updates, 20-playlist listing/switching, checks and reopen use populated fixture databases.
- Artwork fixture: deterministically generated 1600×1200 RGBA PNG, 2,164,075 encoded bytes. Cold storage uses a new directory per sample. Shared-content storage adds keys against the same content; first sample is cold. Warm reads still hash, decode and update LRU, intentionally preserving corruption detection. FLAC extraction uses a real PICTURE block but the fixture is **not playable audio**.
- Folder scans enumerate 100/1,000/10,000 synthetic file entries, not full audio imports. Files contain placeholder bytes. Enhanced lyric parser uses 100/1,000 lines with real line/word timestamps; this does not measure providers or scrolling.
- Frontend parent mount uses React in Node/jsdom, with TrackRow, artwork, sticky header and actions provider mocked. Remaining reorder wrappers/buttons/icons are real. Track ID getters count actual algorithm work and modestly add instrumentation overhead. 9 samples per size; setup/mount included, unmount excluded. 10k computation-only benchmark consumes context lengths without retaining the baseline 100M-element prop graph; no 10k DOM claim. Baseline/optimized computation sections reflect the exact respective algorithms, not a shared browser integration benchmark. Timings are noisy; deterministic counts are stronger evidence.

Raw evidence: [native before](benchmarks/phase5-native-before.json), [native after](benchmarks/phase5-native-after.json), [frontend before](benchmarks/phase5-frontend-before.json), [frontend after](benchmarks/phase5-frontend-after.json).

## Confirmed bottlenecks and targeted changes

### SQLite repeated statement compilation

`upsert_track_tx` previously called `Transaction::execute` for the same 27-column INSERT/ON CONFLICT statement on every row. It now uses rusqlite's existing bounded per-connection `prepare_cached` facility. Validation, parameters, transaction boundaries, migration state and rollback are unchanged. No new pool, connection, pragma or index.

| Workload | Size | Before p50 / p95 ms | After p50 / p95 ms |
|---|---:|---:|---:|
| Batch metadata inserts, 200/transaction | 100 | 13.686 / 15.098 | 5.980 / 7.120 |
| Batch metadata inserts, 200/transaction | 1,000 | 132.063 / 254.443 | 50.320 / 86.900 |
| Batch metadata inserts, 200/transaction | 10,000 | 1,537.672 / 2,081.874 | 607.210 / 673.370 |
| Update 100 records in 10k library | 100 | 14.738 / 35.361 | 6.330 / 34.440 |

Rounded values above are for readability; raw JSON is authoritative. 10k insert p50 fell approximately 60.5%. The 100-row update p95 remains variable; no tail-latency guarantee.

### Artwork duplicate thumbnail decode

Cache storage called `generate_thumbnail` twice, decoding the same original twice after initial validation. `generate_thumbnails` shares one bounded decode for both 500px/256px outputs. Each resize still uses the original, with the same Triangle filter, alpha-preserving PNG path or JPEG quality 86. Individual thumbnail API remains supported. No validation is skipped and no indefinitely retained decoded-image cache is added.

| 1600×1200 PNG workload | Before p50 / p95 ms | After p50 / p95 ms |
|---|---:|---:|
| Cold artwork store | 2,917.972 / 3,374.437 | 2,424.490 / 3,066.370 |
| Shared-content artwork store | 2,840.216 / 3,730.965 | 2,394.990 / 2,935.290 |
| Warm validated cache read (unchanged) | 729.599 / 808.000 | 730.910 / 775.290 |

Cold store p50 fell approximately 16.9%. `artwork_thumbnail_pair` in the raw harness intentionally still calls the individual API twice, so it is a control, **not** evidence for shared decoding. Test counters assert one decode in the new paired path and exact output equality.

### Playlist quadratic lookup and context allocations

Playlist detail did `tracks.find` for every membership and `available.map(id)` inside every row. It now creates a lookup map and one memoized shared context array. Duplicate membership positions, missing rows, exact playback ordering and drag/keyboard controls remain unchanged; no virtualization or design change.

| Parent mount | Before ID reads / context arrays | After ID reads / context arrays | Before p50 / p95 ms | After p50 / p95 ms |
|---|---:|---:|---:|---:|
| 100 tracks | 15,251 / 100 | 401 / 1 | 99.593 / 179.028 | 133.181 / 270.952 |
| 1,000 tracks | 1,502,501 / 1,000 | 4,001 / 1 | 805.813 / 1,123.582 | 664.360 / 726.602 |
| 10k algorithms only | quadratic / 10,000 | linear / 1 | 11,481.057 / 15,315.939 | 4.860 / 7.837 |

The 100-track mount was slower in the after run; no small-playlist timing win is claimed. The after run also included the small existing playlist test file, introducing possible setup contention; timing improvement claims are limited. Allocation/work-count improvement is deterministic. The full playlist DOM is still unbounded; 10k navigation/rendering and drag behavior require real-runtime profiling before introducing virtualization.

## Other measured baselines (not optimized)

| Native workload | Size | Before p50 / p95 ms | After p50 / p95 ms |
|---|---:|---:|---:|
| List SQLite tracks | 100 | 0.803 / 1.081 | 0.800 / 1.080 |
| List SQLite tracks | 1,000 | 7.118 / 8.734 | 7.150 / 8.310 |
| List SQLite tracks | 10,000 | 69.411 / 72.123 | 71.060 / 76.930 |
| Serialize Track DTOs to JSON | 10,000 | 326.914 / 401.468 | 325.200 / 341.430 |
| List 20 playlists | 10k library | 8.373 / 8.932 | 8.670 / 9.530 |
| Get all 20 playlists sequentially | 10k library | 9.305 / 9.760 | 9.670 / 11.360 |
| Integrity checks | 10k library | 23.680 / 25.731 | 23.460 / 24.470 |
| Reopen + status + tracks + playlists | 10k library | 117.920 / 131.631 | 118.000 / 136.480 |
| New empty database initialization | 10k fixture group | 19.396 / 23.993 | 35.490 / 42.810 |
| Validate/decode artwork | 2,164,075 bytes | 463.587 / 511.154 | 472.020 / 479.840 |
| Extract embedded FLAC picture | same | 4.040 / 5.687 | 3.980 / 6.570 |
| Folder enumeration | 100 | 18.927 / 19.676 | 18.840 / 20.980 |
| Folder enumeration | 1,000 | 210.791 / 224.792 | 193.370 / 202.780 |
| Folder enumeration | 10,000 | 2,026.124 / 2,324.430 | 1,909.130 / 2,254.560 |
| Enhanced lyrics parse | 100 lines | 4.301 / 7.624 | 4.270 / 4.730 |
| Enhanced lyrics parse | 1,000 lines | 45.143 / 53.773 | 43.430 / 51.120 |

Empty database initialization regressed in this run, despite no change to initialization; filesystem scheduling/cache noise is unresolved. No initialization improvement claimed. Full-list scans are expected when returning every row; plans use the existing track primary-key and playlist-position indexes for keyed reads, with no temporary ORDER BY tree. **No index was added.** The raw report contains `EXPLAIN QUERY PLAN` details for each library size. JSON serialization is a notable debug startup cost, but production IPC and release profiling are needed before changing repository contracts or paging.

## CPU and memory evidence

PowerShell sampled **only the Rust test process**, every 100ms. This includes fixture generation and all workloads, not just imports. It excludes WebView2 and production Gmusic. Polling can miss brief peaks. These are not idle/playback/import desktop memory budgets.

- Before: wall 177.63s; final sampled cumulative CPU 167.92s (lower bound); maximum sampled working set 42,192,896 bytes (40.24 MiB); private bytes 36,163,584 (34.49 MiB).
- After: wall 156.68s; process CPU 148.22s; maximum sampled working set 42,246,144 bytes (40.29 MiB); private bytes 36,143,104 (34.47 MiB).
- No memory reduction claim. Aggregate CPU/wall includes unrelated fixtures and control workloads; do not attribute all differences to optimizations.
- Initial wrapper lost the exited process handle, returning null ExitCode/CPU/peak and incorrectly reporting failure; native test itself completed 1/1 successfully and raw timings are valid. The wrapper now retains the handle; after run exits 0. OS peak working set still unavailable, so only observed sampled maxima are used.

## Reliability coverage and limitations

Added deterministic regressions for cached-upsert SQL-trigger failure with complete rollback and subsequent reuse; async runtime progress while the connection worker is blocked; paired thumbnail one-decode budget, byte parity, valid outputs and zero-decode no-upscale; playlist linear ID-read budget, one context array, duplicate/missing membership ordering and no parent work during 100 playback-clock updates.

Existing automated suites cover rapid skips/stale resolutions/Blob revocation, pause/seek and real-engine clock ownership, unavailable-file recovery, manual lyric precedence/offsets, cache corruption/offline recovery, bounded provider retries/coalescing, concurrent SQLite writes and interrupted/forced migrations. They do not establish audible playback, real-runtime tail latency or a long-duration leak soak.

Unverified workloads: cold/warm **desktop application** startup p50/p95; complete 100/1k/10k audio imports (probe/tag/hash/IPC/UI); native network discovery latency/concurrent artwork+lyrics real-runtime load; WebView2 lyric scroll frame/CPU costs; full playlist loading/switching/drag; track-switch/play/pause/seek latency/accuracy in real desktop; offline desktop startup and repeated application restart; idle/playback/large-import application+WebView process memory; hour-long playback and perceptual sync. SQLite reopen is not application restart; folder enumeration/metadata writes are not audio import; jsdom is not WebView rendering.

A baseline and final production web preview successfully rendered the empty-library shell and reported exactly one audio element, non-Tauri runtime, and a single baseline navigation DCL observation of433.2ms. This is **one observation**, not cold/warm startup percentiles. Browser file upload is unsupported by the host. Native runtime/human listening remains manual QA; no real user data was seeded or overwritten.

## Reproduction

```bash
# Ordinary regression (benchmark exits immediately without opt-in)
cargo test --manifest-path src-tauri/Cargo.toml
npm test -- src/features/playlists/PlaylistDetailPage.performance.test.tsx

# Native raw timings, choose a NEW output filename
GMUSIC_BENCH=1 GMUSIC_BENCH_OUTPUT='C:/absolute/new-native.json' cargo test --manifest-path src-tauri/Cargo.toml performance_tests::desktop_performance_workloads -- --exact --test-threads=1

# Frontend profiling, choose a NEW output filename
GMUSIC_BENCH=1 GMUSIC_BENCH_OUTPUT='C:/absolute/new-frontend.json' npm test -- src/features/playlists/PlaylistDetailPage.performance.test.tsx
```

Compile first, then run the Rust test executable directly through `scripts/measure-desktop-process.ps1` to exclude compilation from resource measurements. Set the same `GMUSIC_BENCH`/`GMUSIC_BENCH_OUTPUT` environment and pass the test executable path plus `-Arguments 'performance_tests::desktop_performance_workloads --exact --test-threads=1'`, `-Output`, `-Log`. The sampler refuses existing outputs. For true before reproduction, apply only the profiling harness and `#[cfg(test)] mod performance_tests;` to `096d1cf`; the frontend 10k computation section must reflect that baseline's original algorithms. Raw recorded results remain available without reproducing either branch.

## Executed validation

Baseline: Rust fmt, Clippy all targets `-D warnings`, 57 tests; frontend typecheck, lint, 943 tests/74 files, web build and Windows debug no-bundle x64 build passed. A concurrent in-progress new test edit caused the first Windows before-build command to fail TS1005; rerun excluded that untracked scaffold and passed on unchanged production sources.

Profiling harness failures retained: first frontend run completed samples but blocked Vitest RPC (`onTaskUpdate` timeout); cooperative yields between 10k samples fixed the harness and baseline rerun passed. First optimized test budget expected ≤4000 reads but measured4001 due to header artwork; corrected deterministic budget4100 passed8/8. No existing assertion/test was weakened or skipped. New benchmark opt-in is not a disabled correctness test.

Final gates: `cargo fmt --manifest-path src-tauri/Cargo.toml --check`, `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`, `cargo test --manifest-path src-tauri/Cargo.toml` **PASS** (61 tests); `npm run typecheck`, `npm run lint`, `npm test` **PASS** (75 files /947 tests). `npm run build` and `npx tauri build --debug --no-bundle --target x86_64-pc-windows-msvc` **PASS**. Outstanding actual-runtime certification is tracked by Beads `music-lua`. Worker code is unchanged and was not revalidated. Installer installation/signing and other architectures are Phase6 scope. No automatic merge.
