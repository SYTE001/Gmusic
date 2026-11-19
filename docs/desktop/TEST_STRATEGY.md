# Test Strategy — Gmusic Web & Windows Desktop

## 1. Objectives

Verify that additive Tauri 2 desktop support preserves 100% of existing web behavior, playback correctness, lyric synchronization invariants, and local data safety while validating new Rust and IPC boundaries.

## 2. Verification Scopes

### 2.1 Shared Frontend (Web & Desktop UI/Stores/Services)
- **Type safety**: `npm run typecheck` (`tsc -b --noEmit`)
- **Linting**: `npm run lint` (`eslint src scripts`)
- **Unit & component tests**: `npm test` (`vitest run` — jsdom + `fake-indexeddb`)
  - Platform adapter unit tests mocking Tauri IPC (`isTauriRuntime`, native file/folder import, desktop path resolution, backup sanitization stripping `desktopPath`, SW skip on desktop).
  - Existing regression suite (884+ tests covering playback queue, `HtmlAudioElement` engine, LRC/word timestamps, artwork cache/recovery, backup atomicity, cloud isolation).
- **Web production bundle**: `npm run build` (must continue generating `dist/` and `public/service-worker.js` manifest cleanly).

### 2.2 Rust & Tauri Backend (`src-tauri/`)
- **Formatting**: `cargo fmt --check`
- **Linting**: `cargo clippy --all-targets -- -D warnings`
- **Rust unit & integration tests**: `cargo test`
  - Phase 1: Path validation/scoping, audio extension filtering, folder traversal safety, file metadata/read helpers.
  - Phase 2: LRC/enhanced-LRC/lyricsfile parser parity, integer ms invariants, matching & ranking parity, cache TTLs.
  - Phase 3: Embedded cover extraction, image resize bounds, cache key/invalidation invariants.
  - Phase 4: SQLite migrations, transactional rollback on error, corruption recovery, backup import/export parity.
- **Desktop build & packaging smoke check**: `npx tauri build` (or `cargo check` + `npx tauri build --debug` / `--no-bundle` during intermediate checks).

### 2.3 Cloudflare Workers (Isolated Scope)
- Only required when Worker files are modified: `cd worker && npm run typecheck && npm test && npm run build`.
- Note: On Windows under heavy load, Miniflare `beforeAll` hooks may exceed the default 10s Vitest hook timeout; run Worker tests isolated from full frontend suites.

## 3. Non-Negotiable Test Invariants

1. **No fake mocks in production**: Platform detection checks real runtime globals (`__TAURI_INTERNALS__`); tests inject doubles only in `*.test.ts(x)`.
2. **Single audio engine**: Tests must assert no second `<audio>` element or separate lyric clock is created on desktop.
3. **Zero path leaks**: Backup export and cloud sync tests must verify `desktopPath` (and any machine-specific path) is never serialized into portable JSON backups or cloud payloads.
4. **Honest availability states**: Tests must verify that missing/moved desktop files surface as `"missing"` / recoverable relink states rather than silent failures or corrupted library records.
5. **No disabled tests**: Never skip or weaken existing tests to make a build green.

## 4. Phase 2 Deterministic Coverage

- Rust unit tests: exact/wrong/missing artist, metadata normalization, duration/version guards, duplicate candidates, ambiguous recordings and conflicting cross-provider payloads; malformed/empty LRC, decimal/comma timestamps, stable duplicate timestamps, genuine enhanced word times, embedded offsets, lyricsfile word timing and plain fallback.
- Rust HTTP tests use local TCP servers only: timeout, HTTP failure, malformed JSON, missing result, `Retry-After` cooldown and established provider mapping. Native integration tests cover duplicate request coalescing, offline positive-cache reuse, offline misses, invalid provider rejection, confirmed-negative cache hits and metadata invalidation. No test depends on a live paid or external lyrics service.
- `src/services/platform/lyrics.test.ts`: runtime guard, metadata-only command payload, offline dispatch, typed failures, invalid IPC response rejection, cancellation, native parser validation and web fallback.
- `src/services/lyrics/lyricsService.native.test.ts`: shared IndexedDB attachment, manual preservation (including an import during discovery), latest user offset preservation, chooser ambiguity, no negative cache for failures, metadata invalidation, offline disk recovery, aborted/late lookup handling and web fallback.
- Existing `syncEngine.test.ts` and `LyricsView.test.tsx` cover real-clock semantics: seeking forward/backward, pause/resume, track changes, equal timestamps, per-track offsets, word highlighting and the actual renderer DOM. Rust does not run a timer or receive per-frame clock calls.

Run frontend gates from the repository root; run `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `cargo test` from `src-tauri`. Windows build verification uses the installed `x86_64-pc-windows-msvc` target and `npx tauri build --debug --no-bundle --target x86_64-pc-windows-msvc`. MSI/NSIS packaging and other architectures remain separate release validation. The Vite watcher excludes native sources/artifacts to avoid MSVC executable locks during `desktop:dev`.

### Manual smoke scope

Check the shared web shell, navigation and lyrics screen in a browser, then desktop import/play/seek/pause/resume with a local audio track and genuine LRC/enhanced-LRC fixture. Disable connectivity and verify saved lyrics remain usable; retry a missing result online. Do not report a browser/runtime smoke test as passed if the host cannot attach the browser or the desktop window was only built, not exercised.

The PR #7 final verification results, actual Tauri runtime observations, installer-build results and remaining human acceptance blockers are recorded in [PHASE2_VERIFICATION.md](PHASE2_VERIFICATION.md). That report distinguishes read-only runtime evidence from visual/audible acceptance and records the initial full-suite failure as well as the passing rerun.

## 5. Phase 3 Deterministic Coverage

- Rust unit & integration tests (`src-tauri/src/artwork/`):
  - `extract::tests`: embedded cover extraction across MP3 (`ID3v2.3` `APIC` and `ID3v2.4` unsynchronized `APIC`), FLAC (`PICTURE` with `>1KB` description), M4A (`covr` atom), and OGG/Opus (`METADATA_BLOCK_PICTURE`); safe handling of missing, undersized, compressed/encrypted, and overflowing `u32::MAX`/`u64::MAX` headers.
  - `process::tests`: full image decode validation, rejection of HTML/JSON/corrupted payloads, aspect-ratio-preserving `500px` and `256px` thumbnail generation, and no-upscale preservation for smaller images.
  - `matching::tests`: YouTube/promoter noise cleaning, artist extraction, MusicBrainz Release Group confidence scoring (rejecting wrong artists and compilations), and iTunes candidate ranking (rejecting mismatched artists and durations).
  - `providers::tests`: trusted artwork host validation/HTTPS upgrade (`coverartarchive.org`, `archive.org`, `mzstatic.com`), untrusted redirect blocking, transient `503` image retry, `429 Retry-After` rate-limit handling, and local mock TCP server verification of MusicBrainz → CAA → iTunes fallback.
  - `cache::tests` & `artwork::tests`: SHA-256 content-addressed deduplication across tracks/albums, corruption detection and automatic eviction, strict `max_bytes` budget enforcement across shared content-addressed blobs, genuine `last_accessed_at` LRU eviction (with backward compatibility for legacy index records), `query_fingerprint` metadata-change invalidation, shared album cache preservation on single-track invalidation, strict `artwork-v1/blobs` path containment, and end-to-end online-to-offline disk cache serving.
- Frontend platform & integration tests:
  - `src/services/platform/artwork.test.ts`: web runtime no-op guard, IPC payload validation, typed `Blob` materialization, malformed IPC rejection, and cache invalidation forwarding.
  - `src/services/artwork/artworkService.native.test.ts`: desktop native resolution and IndexedDB persistence, offline disk-cache recovery without web calls, native embedded artwork extraction fallback during desktop audio import, and album-preserving single-track invalidation.

## 6. Phase 4 Deterministic Coverage

- Rust unit & integration tests (`src-tauri/src/persistence/tests.rs`):
  - `fresh_database_initialization_sets_pragmas_and_schema_v1`: verifies `PRAGMA user_version = 1`, `PRAGMA foreign_keys = 1`, initial `indexeddb` authority state, and clean integrity check.
  - `schema_upgrade_and_transactional_rollback_on_failure`: verifies multi-step schema upgrades and proves a failing SQL statement rolls back the entire migration transaction and leaves `user_version` unchanged.
  - `track_playlist_lyrics_prefs_and_artwork_crud_preserves_ordering_and_relationships`: verifies track CRUD, playlist track ordering and reordering, accepted/manual word-synced lyrics and user offsets, content-addressed artwork deduplication with Phase 3 `artwork-v1` disk cache, and cascade cleanup (including `pending-metadata-sync`) on track deletion.
  - `idb_migration_verifies_counts_and_checksum_and_is_idempotent`: verifies bounded batch migration, record count and deterministic SHA-256 checksum verification, transition to `sqlite` authority, and idempotent repeat migration calls.
  - `interrupted_or_failed_migration_falls_back_to_recovery_required_and_recovers_cleanly`: simulates an interrupted migration on connection reopen (`authority == 'migrating'` → `'recovery-required'`) as well as count/checksum mismatch rollback, then verifies clean recovery on retry.
  - `large_library_migration_and_backup_replace_library_preserve_surviving_links`: migrates 1,200 tracks across bounded batches and verifies `replace_library` preserves surviving audio blobs while dropping removed tracks' blobs.
  - `detects_database_corruption_and_transitions_to_recovery_required`: verifies foreign-key violation detection via `PRAGMA foreign_key_check` and automatic transition to `recovery-required`.
  - `persistence_engine_handles_concurrent_access_without_blocking_runtime`: verifies concurrent async writes through `PersistenceEngine::with_conn`.
  - `rejects_duplicate_ids_and_malformed_records_and_preserves_missing_availability`: verifies strict payload validation, duplicate track ID rejection during backup replacement, and `"missing"` availability state preservation.
  - `protects_authoritative_sqlite_data_from_stale_idb_snapshots_unless_force_reimport_is_set`: proves that once SQLite is authoritative and modified on desktop, automatic migration calls with a stale IndexedDB checksum never overwrite or wipe SQLite data unless `force_reimport` is explicitly set.
  - `persistent_artwork_survives_disposable_cache_pruning_and_cleans_up_only_when_unreferenced`: proves SQLite-owned artwork in `persistent-artwork-v1/blobs/` survives 0-byte LRU pruning and full clearing of Phase 3's disposable `artwork-v1` cache, preserves shared content-addressed blobs when one referencing track is deleted, and removes the file on disk once the last referencing track is deleted.
  - `verifies_binary_sha256_on_migration_batches_and_rejects_missing_malformed_or_mismatched_digests`: proves missing, malformed (non-64-char hex), or mismatched SHA-256 digests on artwork and audio migration batch entries are rejected and transition cleanly to `recovery-required`.
  - `never_deletes_authoritative_sqlite_data_when_integrity_checks_fail`: proves that when an authoritative `sqlite` database fails integrity checks, it enters a non-destructive `recovery-required` state and neither `get_status`, `begin_idb_migration`, nor `mark_migration_failed` deletes or resets existing SQLite records.
  - `force_reimport_restores_authoritative_sqlite_database_if_migration_fails_or_is_interrupted`: proves that if an explicit `force_reimport: true` fails during finalization or is interrupted by a process crash before completion, the previous authoritative SQLite library (including tracks and artwork) is atomically restored from `_reimport_bak_*` with `authority == 'sqlite'`.
- Frontend platform & repository integration tests:
  - `src/services/platform/persistence.test.ts`: verifies web runtime zero-IPC guarantee, status validation, deterministic SHA-256 snapshot checksum ordering invariance, lossless `Blob` ↔ byte array conversion, rejection of unreadable non-empty blobs without fabricating bytes, mandatory 64-char hex SHA-256 digest validation on artwork/audio migration batches, and pending cloud deletion / metadata sync queues.
  - `src/services/indexeddb/LibraryRepository.sqlite.test.ts`: verifies automatic IndexedDB → SQLite migration on desktop, non-destructive IndexedDB preservation, protection of modified authoritative SQLite data against stale IndexedDB snapshots, non-destructive preservation of authoritative SQLite data when integrity checks fail, transactional rollback to authoritative SQLite state when `forceReimport: true` fails midway, concurrent binary content modification detection on IndexedDB artwork and audio records even when record counts and keys are unchanged, rejection of empty/unreadable artwork or audio blobs without fabricating synthetic bytes, memory-bounded paginated blob migration batches with SHA-256 verification, idempotent repeat migration, bounded batching for large libraries (450+ tracks), malformed record rejection, and portable backup export/restore round-trip preserving surviving `desktopPath` links without leaking paths into exported JSON.

## 7. Phase 5 Performance and Reliability Coverage

- Test-only native opt-in `performance_tests::desktop_performance_workloads`: synthetic100/1k/10k SQLite inserts, listing, updates, JSON serialization, playlist reads, reopen/status/integrity, exact query plans;1600×1200 PNG extraction/decode/thumbnail/cache controls; folder enumeration and enhanced-lyrics parsing. Raw nearest-rank p50/p95 samples are documented in [PHASE5_BENCHMARKS.md](PHASE5_BENCHMARKS.md). Ordinary tests do not execute profiling workloads without `GMUSIC_BENCH=1`.
- `cached_track_upsert_rolls_back_sql_failure_and_remains_reusable`: SQL-trigger failure rolls back an entire batch and cached statement remains usable after schema change.
- `persistence_connection_work_does_not_block_async_progress`: channel handshake on a current-thread async runtime demonstrates progress while the connection worker is blocked, without a timing assertion.
- `thumbnail_pair_decodes_once_and_matches_individual_results`: one-decode work budget, byte equality, valid output and zero-decode no-upscale path. Existing corruption/path/LRU tests stay enabled.
- `PlaylistDetailPage.performance.test.tsx`: counted linear ID lookup budget, one shared context array, duplicate/missing membership order and no parent work on100 playback-clock updates. Opt-in Node/jsdom timings mock row/artwork rendering; they do not prove real desktop navigation or10k DOM performance.
- Final Rust/frontend/build gates are run serially. Native benchmarks are isolated from builds and frontend profiling. Work-count assertions, not fragile milliseconds, guard regressions.
- Outstanding human/runtime QA: actual cold/warm desktop startup; full100/1k/10k audio import; combined background artwork/lyrics load; WebView2 lyric scrolling; rapid-switch/play/pause/seek latency and audible accuracy; offline/restart recovery; full playlist drag/reorder; app-plus-WebView memory in idle/playback/import and hour-long playback soak. Native reopen is not application restart and metadata inserts are not audio imports. No release extrapolation.

## 8. Phase 6A CI and Installer Validation

- `.github/workflows/ci.yml` runs full frontend gates plus Node release-helper tests, and fmt/Clippy `-D warnings`/full Rust tests/Windows Tauri compilation, using lockfile inputs and pinned tools/actions. Failing tests remain failures; no path-based skipping or continue-on-error.
- `node --test scripts/desktop-release.node-test.mjs`: version/tag/MSI-limit mismatch rejection; canonical-repo/main-ancestry/moved-tag checks with an isolated fixture git repository; exact MSI+NSIS naming/non-empty/stale-output/checksum staging without overwrites.
- Release workflow requires opt-in and verified protected-reviewer environment, reuses quality CI, then production build and same-run checksum validation before a draft-only write job. No public release/tag is created for testing this workflow.
- Production packaging command: `npm run desktop:build -- --ci --target x86_64-pc-windows-msvc --bundles msi,nsis -- --locked`. Artifact byte sizes/names/SHA256 are measured only after success. Packaging is not installation acceptance; unsigned Authenticode state must be explicit.
- [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) separates executed local/hosted build evidence from manual fresh install, real WebView2/SQLite/audio/artwork/lyrics, same-format older-version upgrade, rollback and uninstall preservation. Use disposable Windows environments; no user profile overwrite. `music-lua` remains open.

## 9. Runtime Defect and Navigation Follow-up Coverage

- `src/components/SeekBar.test.tsx`: paused mount and pause-between-`timeupdate` synchronization read the authoritative shared audio element; keyboard seeking anchors to the real clock. Existing playback/media/router/player tests retain drag, route, rapid play/pause, stale promise and source-generation coverage.
- TypeScript and Rust matching fixtures reject the three generalized cross-field candidates for `Ain't In LA` by `ADÉLA`, while covering Unicode accents, missing metadata, compound/collaborating artists, close-duration covers, recording-version guards and multiple providers. Native cached/IPC candidates are revalidated at the TypeScript boundary and the native cache schema is bumped.
- `TrackRow.test.tsx` verifies the three-bar CSS-only state contract. Animation exists only for active playback; pause and reduced motion use the static transform without React frame updates.
- `PlaylistsPage.performance.test.tsx` asserts linear track-ID work, duplicate/missing membership behavior and opt-in identical-workload p50/p95 output. `router.test.tsx` asserts primary route changes do not rerender persistent `AppShell`/`MiniPlayer` or reset playback. These are jsdom/component measurements, not WebView2 acceptance.
- Installed NSIS launch, audible progress accuracy, CSS animation perception, real provider behavior, SQLite restart persistence and Windows WebView2 frame-time/long-task/GC acceptance remain manual QA. Report them as **NOT RUN** whenever an isolated Windows runtime is unavailable.
