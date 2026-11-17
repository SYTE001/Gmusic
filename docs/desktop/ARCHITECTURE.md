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
