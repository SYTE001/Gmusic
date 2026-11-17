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
