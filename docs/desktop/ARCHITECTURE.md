# Architecture — Gmusic Desktop & Shared Web Platform

## 1. Baseline Audit Summary (2026-11-17)

### 1.1 Current Repository State
- **Frontend**: React `19.1.0`, TypeScript `~5.8.3`, Vite `6.3.5`, Tailwind CSS `4.1.8`, React Router `7.6.0`, Zustand `5.0.5`, `@applemusic-like-lyrics/core` `0.6.0`, `@supabase/supabase-js` `^2.118.0`.
- **Existing Tauri footprint**: Only `@tauri-apps/cli` (`^2.12.4`) in root `devDependencies` (added in commit `c8d996b`). No `src-tauri/` directory, no `@tauri-apps/api`, and no Tauri runtime branching exist on `main`.
- **Separate Worker packages**: `worker/` (R2 presigning + MusicBrainz proxy), `lyrics-lrclib-worker/`, and `lyrics-lyricsdb-worker/`. Each has its own `package.json`, `tsconfig.json`, and Vitest suite, excluded from root Vite/Vitest via `vite.config.ts`.

### 1.2 Browser-Specific APIs & Persistence Dependencies
Audit of `src/` identified the following browser-coupled surfaces:

| Surface | Current Files | Web Behavior | Desktop Strategy |
|---|---|---|---|
| File & folder pickers | `src/services/library/importService.ts`, `src/features/library/ImportMusic.tsx`, `src/features/library/useTrackActions.tsx` | `showOpenFilePicker` / `showDirectoryPicker` with `<input type="file">` fallback | Phase 1: Tauri native file/folder dialog returning filesystem paths + file bytes/metadata |
| Track source resolution | `src/services/file-access/FileAccessService.ts` | Session `File` → IDB `audio` blob → `FileSystemFileHandle` (`queryPermission`/`requestPermission`) → Cloud R2 URL | Phase 1: Native path-backed resolution (`desktopPath` / scoped asset URL or Rust file read) bypassing browser permission prompts |
| Local persistence | `src/services/indexeddb/db.ts`, `LibraryRepository.ts` | IndexedDB `local-music` v2 (8 stores: `tracks`, `artwork`, `audio`, `handles`, `playlists`, `lyrics`, `lyricsMeta`, `prefs`) | Phase 1: Keep IDB operational in WebView2; Phase 4: SQLite adapter behind `LibraryRepository` boundary |
| Service Worker & storage quota | `src/services/offline/offlineService.ts`, `src/features/settings/SettingsPage.tsx`, `src/components/AppShell.tsx` | Registers `/service-worker.js` in `PROD`, calls `navigator.storage.persist()` & `estimate()`, shows PWA install hint | Phase 1: Skip SW registration and PWA install hint when running inside Tauri desktop |
| Small UI caches | `index.html`, `settingsStore.ts`, `AppShell.tsx`, `src/features/lyrics/palette/cache.ts` | `localStorage` (`lm-theme`, `lm-motion`, `lm-sidebar-collapsed`, `lm-install-hint-dismissed`, palette cache) | Compatible in WebView2; keep small non-critical UI caches in `localStorage` |
| Audio engine & Media Session | `src/services/audio/engine.ts`, `src/services/audio/mediaSession.ts` | Single `HTMLAudioElement` mounted in `document.body`, WakeLock, `navigator.mediaSession` | Retain single `HTMLAudioElement` engine across web and desktop (Phase 1 requirement) |
| Metadata & duration probe | `src/services/metadata/index.ts`, `id3.ts`, `mp4.ts`, `flac.ts`, `ogg.ts` | `File.slice().arrayBuffer()`, WebCrypto SHA-256 partial hash, throwaway `new Audio()` decode probe | Phase 1: Works on `File`/bytes read from disk; Phase 2/3/5: Rust-native tag/hash/probe acceleration |
| Lyrics discovery & sync | `src/services/lyrics/lyricsService.ts`, `lrcmuxClient.ts`, `lrclibClient.ts`, `lyricsdbClient.ts`, `matching.ts`, `lyricsfile.ts`, `AmllLyricPlayer.tsx` | Concurrent `fetch()` across 3 providers, capability gating, weighted ranking, IDB cache, `translate3d` DOM renderer | Phase 1: Unchanged; Phase 2: Rust concurrent provider client + parser + cache behind service boundary |
| Artwork discovery & cache | `src/services/artwork/artworkService.ts`, `artworkCache.ts`, `coverArtClient.ts`, `itunesClient.ts`, `musicbrainzClient.ts` | IDB blob store + 500-entry `urlCache` LRU + `Image()` probe + `fetch()` | Phase 1: Unchanged; Phase 3: Rust embedded extraction, resizing/thumbnails, disk cache |
| Backup export/import | `src/services/backup/backupService.ts` | JSON download via `<a download>` and `<input type="file">` | Phase 1: Keep working; Phase 1/4: Native save/open dialog optional; never export desktop absolute paths |

## 2. Target Architecture

```text
React 19 UI (src/components/, src/features/)
  -> Zustand Stores (playback, library, lyrics, settings, cloud, toast, dynamicIsland)
    -> Shared Domain Services (src/services/*)
      -> Platform Runtime Boundary (src/services/platform/)
           |-- Web Runtime: File System Access API / <input>, IndexedDB, Service Worker
           '-- Desktop Runtime (Tauri 2): @tauri-apps/api + invoke()
                 -> Rust Backend (src-tauri/src/)
                      |-- Phase 1: Native file/folder dialog, scoped FS read/metadata, asset serving
                      |-- Phase 2: Native lyrics providers, LRC/enhanced-LRC parser, cache
                      |-- Phase 3: Native artwork extraction, resize/thumbnails, disk cache
                      '-- Phase 4: SQLite library/playlists/lyrics/prefs repository + migrations
```

## 3. Phase 1 Boundary Design

1. **Runtime detection (`isTauriRuntime()`)**: Checks Tauri v2 global (`"__TAURI_INTERNALS__" in window`) cleanly without importing Tauri-only globals into web-only code paths synchronously.
2. **Track identity & desktop file paths**:
   - Add an optional `desktopPath?: string | null` field to `Track` (or a desktop-local path store, never exported in `backupService.ts` or synced to Supabase).
   - Keeping `desktopPath` optional on `Track` (stripped during `buildBackup()` and cloud sync) avoids breaking existing web records and keeps `Track` backward compatible.
3. **Desktop audio playback**:
   - `HtmlAudioEngine` stays the single playback engine.
   - For desktop path-backed tracks, `FileAccessService.resolveTrackSource` converts the validated local path to a playable URL via Tauri's `convertFileSrc` (with `assetProtocol` enabled and scoped) or reads bytes into a managed `Blob` URL as fallback. Using Tauri's `asset:` protocol avoids duplicating large audio files in memory.
4. **Security boundaries (Tauri 2)**:
   - Explicit capability file (`src-tauri/capabilities/default.json`) with least-privilege permissions.
   - `assetProtocol` enabled strictly for user-selected/imported audio files (or explicit Rust scope extension on pick/import).
   - Never expose secrets or service keys in `src-tauri/` or `VITE_*`.

## 4. Phase 2 Native Lyrics Boundary

- `src/services/platform/lyrics.ts` guards Tauri commands and validates their responses. Web builds use the existing TypeScript provider/parser path and do not execute Rust commands. If a native command is unavailable, the adapter warns and falls back; typed provider failures do not trigger duplicate web requests.
- `src-tauri/src/lyrics/providers.rs` calls the established lrcmux, LRCLIB and LyricsDB HTTPS APIs directly. Provider requests run concurrently, but each provider has a shared sequential gate (300 ms spacing; LyricsDB 200 ms). Requests have 10-second timeouts, one bounded transient retry, a 14-second per-provider discovery budget, 2 MiB response limits, no arbitrary endpoint IPC, and no redirects. `Retry-After` seconds/HTTP dates set a shared cooldown.
- `parser.rs` processes plain text, LRC, enhanced LRC, and the established bounded YAML-like `lyricsfile` subset. Integer timestamps are stably sorted. Embedded file offsets apply consistently to line and genuine word times; user offsets remain separate. Invalid word timing falls back to line-level presentation, never invented word timing.
- `matching.rs` verifies title/artist/album/duration and recording version, ranks capability from parsed payloads, collapses duplicate copies, and leaves ambiguous identities to the existing chooser. Desktop auto-attachment requires artist identity and duration alignment within five seconds when both durations are known.
- The native disk cache lives under Tauri's app cache directory in `lyrics-v1/`. One SHA-256 filename per stable track ID stores a versioned discovery result and metadata/provider fingerprint. Positive discovery expires after 24 hours; verified missing results after one hour. Metadata/provider changes invalidate entries. Writes use same-directory flushed atomic replacement. Corrupt/unwritable caches report warnings without losing existing accepted lyrics. Offline can reuse stale positive entries, never stale negative entries.
- IndexedDB remains authoritative for accepted lyrics, manual overrides and offsets; no SQLite migration is introduced. Shared resolution re-reads lyrics after native discovery so intervening imports/edits/offset changes win. A cancelled IPC caller cannot attach late results; native completion may only warm its discovery cache.
- `parseLyricFileForPlatform` makes one native parse per import/edit and retains the web fallback. Quick edits become manual records. No native command participates in rendering frames: `HTMLAudioElement.currentTime`, local binary lookup and the unchanged `AmllLyricPlayer.tsx` remain the playback/synchronization/rendering owners.

## 5. Phase 3 Native Artwork Boundary

- `src/services/platform/artwork.ts` guards Tauri artwork commands (`extract_desktop_embedded_artwork`, `resolve_desktop_artwork`, `cache_desktop_remote_artwork`, `read_desktop_cached_artwork_bytes`, `invalidate_desktop_artwork_cache`) and validates their responses. Web builds use the existing TypeScript metadata/artwork path and never execute Rust commands.
- `src-tauri/src/artwork/extract.rs` extracts embedded pictures from MP3 (`ID3v2.2` `PIC`, `ID3v2.3`/`2.4` `APIC` with tag/frame de-unsynchronization and compressed/encrypted frame rejection), FLAC (`PICTURE` block type 6), M4A/MP4 (`moov/udta/meta/ilst/covr/data` atom), and OGG/Opus (`METADATA_BLOCK_PICTURE` and `COVERART` across multi-page Ogg packets). Prefers Front Cover (`picture_type == 3`), verifies magic bytes (`JPEG`, `PNG`, `WebP`, `GIF`, `BMP`), uses checked offset arithmetic and bounded `Read::take` allocations, and enforces `[64B..16MiB]` bounds.
- `src-tauri/src/artwork/process.rs` decodes images with bounded memory (`8192x8192` max dimensions, `48MP` max pixels, `192MiB` allocator cap) and generates aspect-ratio-preserving thumbnails (`500px` and `256px` max edge) without upscaling smaller originals.
- `src-tauri/src/artwork/matching.rs` and `providers.rs` implement metadata-aware normalization (stripping YouTube/channel/remaster noise while preserving compound band names and recording versions), MusicBrainz Release Group and Release scoring, Cover Art Archive lookup, and iTunes Search API fallback with per-provider sequential rate gates (`1000ms` MusicBrainz, `150ms` CAA, `350ms` iTunes), `Retry-After` handling, bounded transient retry, and strict host allowlisting (`coverartarchive.org`, `archive.org`, `mzstatic.com`).
- `src-tauri/src/artwork/cache.rs` maintains a content-addressed SHA-256 disk cache in `artwork-v1/` (`blobs/` + `index/`) with deduplicated original and thumbnail files, atomic temp-file writes, 30-day positive TTL, 24-hour negative TTL, `query_fingerprint` metadata-change invalidation, album-shared invalidation guards (`include_album`), offline stale-positive reuse (never returning negative entries offline), automatic corruption detection/eviction, and genuine `last_accessed_at` LRU pruning strictly enforcing the `256MiB` budget across shared content-addressed blobs.
- Native artwork IPC enforces symlink rejection (`symlink_metadata`), `asset_protocol_scope()` authorization on audio file paths, and strict `artwork-v1/blobs` canonical parent containment with bounded `16MiB` reads on `read_desktop_cached_artwork_bytes`.
