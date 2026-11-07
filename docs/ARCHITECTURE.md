# Gmusic Architecture

This document describes how Gmusic is actually built — the layers, the data flows, the persistence schema, and the invariants that keep local data safe. For running and deploying the system, see [DEVELOPMENT.md](DEVELOPMENT.md) and [DEPLOYMENT.md](DEPLOYMENT.md).

## Design principles

1. **Local-first** — the app is fully useful with no account, no cloud configuration, and no network after the shell loads. IndexedDB is the source of truth for the library; the cloud layer is additive.
2. **One playback engine** — exactly one shared `HTMLAudioElement` (created outside React) owns playback time. No component, store, or page maintains an independent clock or timer.
3. **Honest state** — availability, upload success, and lyric capability are shown only when verified. The UI never claims a file is cached, uploaded, or playable before the implementation has proven it.
4. **Recoverability** — missing files, revoked permissions, quota failures, and network errors are classified, surfaced, and recoverable. Transient failures never permanently mark a track broken.
5. **Ownership boundaries** — UI calls stores; stores coordinate services; services own IndexedDB, browser APIs, and network clients. Components never touch IndexedDB or construct signed URLs directly.

## Layer map

```
src/
  app/        App.tsx (bootstrap, init sequence), router.tsx (lazy routes), error boundary
  components/ shared presentation: AppShell, Sidebar, TopBar, TrackRow, TrackListSection,
              MiniPlayer, QueuePanel, SeekBar, Menu, Modal, ConfirmDialog,
              DynamicIslandNotification, Artwork, Icons (original inline SVG set)
  features/   page-level orchestration:
              home · library (import + track actions) · liked · playlists · recent ·
              player (NowPlayingPage, queue helpers) · lyrics (renderer, editor, matcher) ·
              broken (triage) · settings (incl. cloud sections)
  stores/     Zustand: playback, library, lyrics, settings, cloud, toast, dynamicIsland
  services/   audio/ (engine) · indexeddb/ (db, repository) · file-access/ ·
              library/ (import, playback session) · metadata/ (tag parsers) ·
              lyrics/ (parsing, providers, matching) · artwork/ · backup/ ·
              offline/ (service worker registration) · cloud/ (auth, sync, R2, migration) ·
              errors/ (playback error classification)
  types/      persisted entity types (all cloud fields optional)
```

### Bootstrap sequence (`src/app/App.tsx`)

1. `main.tsx` mounts `<App/>` inside `StrictMode` and a top-level error boundary.
2. `settingsStore.init()` loads preferences, applies `data-theme` / `data-motion` to `<html>`.
3. Persisted volume/shuffle/repeat are applied to `playbackStore`; `playbackStore.init()` starts the audio engine wiring.
4. `cloudStore.init()` runs non-blocking (syncs immediately if already authenticated); `libraryStore.init()` loads the library.
5. `registerServiceWorker()` registers the production-only PWA service worker.
6. A StrictMode-safe effect starts lyrics prefetch, installs visibility/focus resync, a 1-second clock-drift watchdog, and a `pagehide` session flush.

Routes are lazy-loaded (`src/app/router.tsx`); `AppShell` + MiniPlayer stay in the entry chunk so route changes never restart playback. `/now-playing` is an overlay route outside the shell; `/lyrics` redirects to it.

### Stores

| Store | Responsibility |
|---|---|
| `playbackStore` | Single global playback state; owns the engine; error classification; broken-track marking; dynamic island dispatch |
| `libraryStore` | Tracks/playlists/stats via the repository; import orchestration; availability revalidation; session persistence |
| `lyricsStore` | Discovery state machine (idle/checking/ready/needs-selection/not-found/offline/error); per-track resolution guard; prefetch |
| `settingsStore` | Preferences; theme/motion application; persistence |
| `cloudStore` | Supabase session; idempotent sync; migration; failures never mutate local data |
| `toastStore` | Auto-dismissing toast stack |
| `dynamicIslandStore` | Transient notification queue with animation stages |

Cross-store wiring uses explicit `bind*` registration functions (e.g. `bindPlaybackHelpers`) to avoid circular imports.

## Playback flow

```
UI control -> playbackStore action -> queue transition (features/player/queue.ts, pure)
  -> HtmlAudioEngine.setSource(url) + play()
     <- media events (timeupdate, ended, error, ...) -> store sync
       -> MiniPlayer / SeekBar / NowPlaying / lyrics (all read the same clock)
```

Race protection is layered: a `loadToken` invalidates in-flight track loads on every new start; `sourceGeneration` matches engine sources to store expectations so stale media errors are dropped; `MEDIA_ERR_ABORTED` during a source swap is treated as a transition, not an error; rapid next-track presses are debounced and coalesced. Seek drift is corrected against the element on `seeked` (>750 ms) and by a watchdog while playing. Position persistence happens at sensible intervals and lifecycle transitions (not per frame) via the `playback` row in the `prefs` store.

### Track source resolution (`src/services/file-access/FileAccessService.ts`)

Resolution order is deliberately local-first; a failed or ungranted source never masks a cheaper fallback:

| Order | Source | Notes |
|---|---|---|
| 1 | Session file | In-memory `File` from the current page session |
| 2 | Stored copy | Audio blob from IndexedDB (`audio` store) |
| 3 | File handle | `handle.getFile()`; stale handles fall through; ungranted handles trigger a permission re-grant inside the play gesture |
| 4 | Cloud | Only when no local bytes exist and `objectKey` is set; per-request signed URL, retried once with a fresh URL on network-class errors |

Availability states: `available`, `missing`, `permission-required`, `offline`, plus broken categories (`corrupted`, `unsupported`, `unreadable`, `decoding`, `missing`). Permission loss and network failures are **never** permanent; only a confirmed missing file with no fallback marks the track broken (with retry counter). Startup runs `revalidateAccess()` which honestly re-proves granted handles by opening the file once.

Object URLs are strictly managed: one active + one preloaded, revoked on switch and dispose. Next-track preload happens after 3 s of playback (local sources only).

## Local persistence

IndexedDB database **`local-music`**, version **2** (`src/services/indexeddb/db.ts`, `src/types/index.ts`):

| Store | Key | Contents |
|---|---|---|
| `tracks` | `id` (+ `addedAt` index) | Track records — no blobs, library queries stay light |
| `artwork` | `trackId` | Embedded cover-art blobs |
| `audio` | `trackId` | Optional stored-copy audio blobs |
| `handles` | `trackId` | `FileSystemFileHandle` per track |
| `playlists` | `id` | Playlist records |
| `lyrics` | `trackId` | Lyric documents (lines, origin, offsetMs, provider cache fields) |
| `lyricsMeta` | `trackId` | Lookup bookkeeping (accepted / not-found / needs-selection, timestamps) |
| `prefs` | `name` | `"app"` preferences, `"playback"` saved session, pending cloud-deletion / metadata-sync queues |

The repository wraps all access in `withTransaction()` mapping IDB errors to typed `DBError` kinds (`unavailable | quota | corrupt | unknown`). Multi-store operations are atomic: `putTrackWithFiles` writes track + artwork + audio/handle in one transaction; `replaceLibrary` swaps the whole library in one transaction for backup restore. An `onversionchange` handler closes stale connections when another tab upgrades the schema.

### Import pipeline (`src/services/library/importService.ts`)

pick files/folders → audio-extension gate → `probeAudioFile()` (real decode probe via a throwaway audio element, 15 s timeout) → fingerprint (size + SHA-256 of first/last 32 KB) → tag parsing (ID3v1/v2, MP4 `ilst`, FLAC Vorbis + picture, Ogg/Opus comments; mojibake repair and corruption detection built in) → filename fallback → duplicate match → atomic persist.

Duplicate detection has three levels: exact fingerprint; strong audio identity (tail hash + duration ≤1.5 s, or identical size+filename+duration); metadata-assisted (title+artist + duration + size window, version-qualifier aware). Matches heal metadata in place (never overwriting non-empty values with empty) and re-link broken tracks instead of skipping them; ambiguous near-matches land in a needs-review list.

### Backup (`src/services/backup/backupService.ts`)

Metadata-only JSON (`app`, `schemaVersion`, `tracks[]`, `playlists[]`, `lyrics[]`, `preferences?`) — no audio bytes, no handles, no absolute paths. Restore validates fully (schema, per-entry shape, duplicate IDs) before any mutation, sanitizes preferences, filters playlist/lyric references to existing tracks, preserves surviving handles/copies on the same device, and replaces the library atomically. Failure leaves the previous library untouched.

## Lyrics subsystem

```
providers (lrcmux, LRCLIB, LyricsDB) — queried concurrently via clients
  -> payload validation + capability detection (none < instrumental < plain < line < word)
  -> cross-provider dedupe (highest capability wins)
  -> ranked matching (title 40% / artist 35% / duration 15% / album 10%, Levenshtein,
     version-qualifier penalty; auto-accept >=90, else candidate chooser)
  -> attach; persist document + meta in IndexedDB
```

- Parsing handles single/multiple timestamps per line, `[offset:]` tags, and enhanced-LRC `<mm:ss.xx>` word tags; all timestamps are integer milliseconds.
- **Quality invariants:** word timings are never fabricated from line data; manual imports (`origin.kind: "manual"`) are never replaced by network results; force refresh must reach ≥ current quality; plain text only ever fills in when no synced candidate exists; failures keep existing lyrics.
- Caching: `not-found` retried after 1 h; line/plain caches get bounded upgrade lookups (24 h backoff); in-flight resolutions deduplicate per track.
- Rendering: `AmllLyricPlayer.tsx` builds line DOM into one `translate3d` GPU track with measured geometry caches (no per-frame layout reads); AMLL's internal observers are disposed; the background is a single solid album-adaptive color from `src/features/lyrics/palette/` (`--bg`, `--lyric-active`, `--lyric-inactive`, `--accent`, contrast-enforced).
- Per-track `offsetMs` (±10 s) persists separately and never rewrites stored lines. Clicking a timed line seeks the shared engine.

## Cloud layer (optional)

```
Frontend (publishable config only: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_WORKER_URL)
  -> Supabase Auth (email+password) / direct Postgres sync via RLS
  -> Worker (verifies access-token SIGNATURE; constructs object keys server-side)
     -> private R2 via short-lived presigned PUT/GET (120 s / 300 s defaults)
```

### Main Worker endpoints (`worker/src/index.ts`)

| Method + path | Auth | Purpose |
|---|---|---|
| `GET /api/health` | none | Smoke check |
| `GET /api/musicbrainz/*` | none (rate-limited 1 req/s, cached) | Read-only MusicBrainz WS/2 proxy |
| `POST /api/audio/upload-url` | Bearer JWT | Validates size/MIME, presigns PUT, issues signed upload intent |
| `POST /api/audio/complete` | Bearer JWT | HEADs the object; verifies size + content-type against the intent; deletes mismatches |
| `POST /api/audio/play-url` | Bearer JWT | Ownership check; existence check; presigned GET |
| `POST /api/audio/delete` | Bearer JWT | Paginated prefix delete + post-delete verification |

Auth strategies (`worker/src/auth.ts`): asymmetric tokens verified against Supabase JWKS (issuer-pinned, algorithm-pinned); HS256 verified locally when `SUPABASE_JWT_SECRET` is set; otherwise a Supabase auth-service verification fallback. Claims require `role: authenticated`, non-anonymous, mandatory `iat`. The authenticated `sub` scopes every object key: `users/{userId}/tracks/{trackId}/{audio|artwork}.{ext}` — keys are parsed and authorized server-side, cross-user keys are rejected with 403.

### Supabase schema (`supabase/migrations/`)

Tables `tracks`, `playlists`, `playlist_tracks`, `track_lyrics`, `track_playback` — all `user_id`-scoped with full RLS (select/insert/update/delete own), composite foreign keys preventing cross-user playlist membership, `touch_updated_at` triggers, and a defensive `assert_owning_user()` trigger that blocks `user_id` changes even if RLS were bypassed. Only R2 **object keys** are stored; presigned URLs are never persisted (the policy tests assert this). Sync is idempotent by design: client-generated stable IDs are primary keys, upserts converge, and duplicates reconcile by fingerprint.

### Failure containment

A failed sync, upload, verification, or deletion never mutates local data. Pending cloud deletions and metadata changes queue in IndexedDB and retry on every sync. Migration verifies an existing cloud object before skipping re-upload, uploads with fresh intents per attempt, and writes metadata only after object verification. Signed URLs live in memory only (module map, cleared on sign-out).

## PWA / offline

`public/service-worker.js` + `scripts/build-sw.mjs`: the build injects the hashed asset list into a build-hash-versioned cache (`local-music-shell-v<hash>`). Navigations are network-first with cache fallback; same-origin assets are cache-first. The worker **never** touches cross-origin requests or `blob:` URLs — audio is never cached by the service worker. Registration is production-only and secure-context-only; `navigator.storage.persist()` is requested once per session to protect the library from eviction.

## Known architecture risks (for maintainers)

- `playbackStore` (~980 lines) concentrates playback, error classification, broken-marking, and notification dispatch — the highest regression surface in the codebase.
- Cross-store `bind*` coupling is runtime-wired and traceable only by search.
- Vercel SPA rewrite (`vercel.json`) must stay deployed or deep links will 404.
- The lyrics workers are public, stateless proxies with no rate limiting of their own; they only pass through upstream 429s.
- The Worker `INTENT_SECRET` currently falls back through credential secrets to a public constant when unset (see [SECURITY.md](SECURITY.md) findings).
