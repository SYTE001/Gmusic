# PRD — Gmusic Windows Desktop (Tauri 2 + Rust)

## 1. Product Summary

Extend **Gmusic** (`local-music`, v1.1.0), an offline-first personal music player for the web, into a native **Windows desktop application** powered by **Tauri 2** and **Rust**.

This is an **additive migration**, not a rewrite:
- The existing web application (PWA, IndexedDB, File System Access API, optional Supabase/R2 cloud mode) remains fully functional.
- Both web and desktop share the existing React 19 + TypeScript + Tailwind CSS 4 frontend and Zustand stores.
- Desktop progressively adopts Rust-powered native capabilities across milestones (file dialogs & path-backed access in Phase 1, native lyrics in Phase 2, native artwork in Phase 3, SQLite persistence in Phase 4, performance profiling in Phase 5, CI/CD & installer packaging in Phase 6).

## 2. Core Principles & Non-Negotiable Invariants

1. **Local-first & Privacy-first**: Personal audio, artwork, lyrics, and library metadata stay on-device unless the user explicitly enables optional cloud sync. Never upload local audio automatically.
2. **Non-destructive file handling**: Gmusic never modifies or deletes the user's original audio files. Removing a track removes only the app's library reference.
3. **Single playback engine & clock**: One shared `HtmlAudioElement` (`src/services/audio/engine.ts`) remains the sole playback and lyric-synchronization authority across web and desktop. No parallel audio element or independent timer may be introduced.
4. **Honest state**: Never claim a file is available, cached, synced, or word-synchronized unless verified. Word-level lyric highlighting is allowed only when actual word timestamps exist.
5. **Portable backups**: JSON exports (`src/services/backup/backupService.ts`) must never contain machine-specific filesystem paths or browser handles.
6. **Additive compatibility**: Cloud fields, desktop path metadata, and SQLite migrations must preserve existing local-first records without silent data loss.

## 3. Non-Goals

- No streaming-service integrations, catalog scraping, DRM circumvention, or protected-stream extraction.
- No analytics, telemetry, ads, or mandatory accounts/API keys.
- No frontend rewrite or replacement of React, Vite, Tailwind, Zustand, React Router, or `AmllLyricPlayer`.
- No desktop bundling coupled to Vercel or Cloudflare Worker deployment pipelines.

## 4. Target Milestones & Acceptance Criteria

### Phase 0 — Repository Audit & Planning
- Audit existing web architecture, browser-only APIs, lyrics/artwork pipelines, and `@tauri-apps/cli` baseline.
- Record baseline test, typecheck, lint, and build results.
- Produce `docs/desktop/{PRD,ARCHITECTURE,MIGRATION_PLAN,TEST_STRATEGY}.md` and organize tasks in Beads (`bd`).

### Phase 1 — Desktop Foundation (Windows Tauri 2)
- Scaffold `src-tauri/` (Tauri 2 crate, config, capabilities, Windows icons from `public/icons/`).
- Add `@tauri-apps/api` and a minimal runtime platform boundary (`src/services/platform/`) that leaves web behavior unchanged.
- Functional Windows desktop window rendering the shared React UI and navigation without breaking web builds.
- Working audio playback through the existing single `HtmlAudioElement`.
- Native Windows file and folder selection (via `tauri-plugin-dialog` or native file commands) feeding the existing import & relink flows without browser `FileSystemFileHandle` permission loss across reloads.
- Skip PWA Service Worker registration inside the Tauri WebView runtime.
- Both `npm run build` (web) and `cargo check` / `cargo test` / `tauri build --no-bundle` (or full desktop bundle) verified.

### Phase 2 — Native Lyrics Services
- Move/mirror concurrent provider discovery (`lrcmux`, `lrclib`, `lyricsdb`), metadata-aware ranking, duration tolerance, LRC/enhanced-LRC/lyricsfile parsing, and persistent caching into Rust commands while preserving exact timestamp and capability invariants.
- Keep `HtmlAudioElement` playback position as sync authority and preserve `AmllLyricPlayer.tsx`.

### Phase 3 — Native Artwork Services
- Rust-backed embedded cover extraction, external MusicBrainz/CAA/iTunes lookup with strict track-matching guards, thumbnail generation/resizing, persistent disk cache, and cache invalidation/fallback.

### Phase 4 — Desktop Persistence (SQLite)
- Versioned SQLite schema in `src-tauri/` with transactional migrations, integrity checks, rollback/recovery, and browser-backup import compatibility.
- Keep IndexedDB (`src/services/indexeddb/`) operational for web builds.

### Phase 5 — Performance & Reliability
- Profile library scanning, artwork loading, lyric scrolling, and playback stability before optimizing.

### Phase 6 — Production & CI/CD
- Separate GitHub Actions workflows for web vs. Windows desktop (`cargo fmt`, `cargo clippy`, `cargo test`, frontend checks, Tauri Windows installer generation, and release documentation).
