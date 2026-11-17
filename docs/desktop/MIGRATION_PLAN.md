# Migration Plan — Gmusic Web to Windows Desktop

## 1. Phase 0 Quality Baseline (Recorded 2026-11-17 on `main`)

| Scope | Command | Result | Details |
|---|---|---|---|
| Frontend TypeScript | `npm run typecheck` | PASS | `tsc -b --noEmit` exited `0` |
| Frontend ESLint | `npm run lint` | PASS | `eslint src scripts` exited `0` |
| Frontend Tests | `npm test` | PASS | Vitest `3.2.7`: `66` test files passed, `884` tests passed (`366.34s`) |
| Frontend Production Build | `npm run build` | PASS | `467` modules transformed; `dist/` + `service-worker.js` updated (`26` precached URLs) |
| Worker TypeScript & Build | `cd worker && npm run typecheck && npm run build` | PASS | `tsc --noEmit` and `wrangler deploy --dry-run --outdir dist` exited `0` |
| Worker Tests | `cd worker && npm test` | PARTIAL / TIMEOUT | `test/keys.test.ts` (`6` tests) passed; `auth.test.ts`, `musicbrainz.test.ts`, `r2Api.test.ts` timed out in `beforeAll` (`startWorker()` > 10000ms hook timeout on Windows under concurrent load) |
| Desktop Toolchain | `npx tauri info` | INITIAL GAP → RESOLVED | Windows `10.0.26200` x64, WebView2 `154.0.4258.62`, MSVC Build Tools 2022 present; Rust (`rustc`/`cargo`/`rustup`) was missing and installed via `Rustlang.Rustup` |

## 2. Technical Debt & Migration Risks

1. **Monolithic store & service files**: `playbackStore.ts` (~980 lines), `artworkCache.ts` (1723 lines), `artworkService.ts` (1552 lines), and `lyricsService.ts` (1239 lines) carry dense orchestration and retry state. Migration must isolate platform adapters cleanly rather than duplicating these files.
2. **Runtime cross-store coupling**: `bindPlaybackHelpers` and `bindLyricsTrackLookup` wire store dependencies at runtime; refactoring import order carelessly risks initialization cycles.
3. **Browser-only assumptions in `FileAccessService` & `importService`**:
   - Currently tracks default to `"session-only"` or `"stored-copy"` when `showOpenFilePicker` is absent. In Tauri WebView2 on Windows, native dialogs return filesystem paths (`string[]`) rather than `FileSystemFileHandle` objects, so desktop needs a native path-backed resolution path (`"desktop-path"` or `desktopPath` on `Track`) to avoid duplicating audio files into IndexedDB or losing access on restart.
4. **Portable backups & cloud sync leak risk**: `backupService.ts` and `cloudMetadataSyncService.ts` serialize `Track` fields. Any desktop-local path field (`desktopPath`) MUST be stripped before backup export and cloud upload (preserving PRD §9 and security rules).
5. **Service Worker in Tauri WebView**: `offlineService.ts` registers `/service-worker.js` in production builds (`import.meta.env.PROD`). Inside Tauri (`tauri://localhost` or `http://tauri.localhost`), SW registration is unnecessary and can fail or cache stale shells; it must be skipped on desktop while remaining enabled for web builds.
6. **External network tests & Worker Miniflare timeouts**: In `lyricsSearchMetadataMapping.test.ts`, unmocked fallback calls to `lyricsdb`/`lrclib` produced transient network diagnostics, and `worker/` Miniflare `beforeAll` hooks timed out at 10s under load. CI workflows should separate unit tests from slow/environment-sensitive Miniflare startup or configure adequate timeouts.
7. **Dual-window / SPA routing**: `BrowserRouter` relies on fallback to `index.html`; Tauri serves `frontendDist` (`dist/`) with SPA fallback cleanly, which must be verified during desktop bundle tests.

## 3. Phased Rollout

| Phase | Milestone | Branch Pattern | Key Deliverables |
|---|---|---|---|
| **0** | Audit & Planning | `feat/desktop-phase1-foundation` | `docs/desktop/*.md`, Beads tasks, baseline verification |
| **1** | Desktop Foundation | `feat/desktop-phase1-foundation` | `src-tauri/` Tauri 2 app, `@tauri-apps/api`, `tauri-plugin-dialog`, platform adapter for native file/folder pick, path-backed playback & relink, SW bypass on desktop, web regression intact |
| **2** | Native Lyrics | `feat/desktop-phase2-lyrics` | Rust concurrent provider client (`lrcmux`/`lrclib`/`lyricsdb`), LRC/enhanced-LRC/lyricsfile parser, capability/scoring parity, persistent cache |
| **3** | Native Artwork | `feat/desktop-phase3-artwork` | Rust embedded art extraction, MusicBrainz/CAA/iTunes matching, thumbnail resizing, disk cache & invalidation |
| **4** | Desktop SQLite | `feat/desktop-phase4-sqlite` | Versioned SQLite schema, transactional migrations, integrity checks, backup import/export parity, IDB compatibility |
| **5** | Perf & Reliability | `feat/desktop-phase5-perf` | Measured profiling of library scan, lyric scroll, artwork decode, memory footprint |
| **6** | Production & CI/CD | `feat/desktop-phase6-cicd` | GitHub Actions (`cargo fmt/clippy/test`, frontend CI, Windows `.msi`/`.exe` bundle), release docs |

## 4. Compatibility & Rollback Rules

- Every phase lands on a dedicated feature branch via PR; `main` is never pushed to directly without human approval.
- Web builds (`npm run build`) must pass after every desktop change; Tauri imports must be dynamically loaded or runtime-guarded so browsers never execute `window.__TAURI_INTERNALS__` calls.
- User data compatibility: Phase 1 keeps IndexedDB in WebView2 so no user data is lost; Phase 4 introduces explicit one-time migration/import with validation before switching desktop storage authority.

## 5. Phase 2 Implementation Verification (2026-11-18)

- Started from latest `origin/main` `dad9d75` on `feat/desktop-phase2-lyrics`; `main` was not modified.
- Baseline: `npm ci`, typecheck, lint, full frontend suite (67 files / 892 tests), web build, Rust baseline tests (4) and format check passed. `npm ci` reports the existing 10 audit findings (8 moderate / 2 critical); no forced dependency remediation was applied.
- Implemented native parser, fixed-provider async transport, normalized metadata ranking, ambiguity, versioned atomic per-track disk discovery cache and runtime-guarded integration. IndexedDB accepted/manual lyrics and user offsets remain the authority; no SQLite or artwork migration.
- Rust: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `cargo test` passed (23 tests). Frontend typecheck/lint/build and focused adapter, integration, clock/renderer, and manual-editor regressions passed. Final `npm test`: 70 files, 917 tests passed.
- Windows executable build passed: `npx tauri build --debug --no-bundle --target x86_64-pc-windows-msvc`. Available packaging targets are `msi` and `nsis`; only x64 MSVC is installed. Installers/signing and other architectures were not verified.
- Browser smoke could not run: the host returned `browser guest not attached (webview not ready)` twice. A Vite `EBUSY` watcher error on Rust build executables was fixed by ignoring `src-tauri` in frontend watching; the dev server then started cleanly. Real WebView2 playback/seek/pause/lyrics/offline acceptance remains tracked by Beads `music-82d` before approval.
- Rollback: the native cache is disposable discovery data; removing/disabling the adapter restores the existing web service path without migrating or deleting accepted lyrics, manual edits or offsets. Phase 3 must wait for human approval of Phase 2.
