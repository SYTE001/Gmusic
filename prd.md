# PRD — Offline Personal Music Player Web

## 1. Product Summary

Build a local-first, offline-capable music player web app for one person. Use the supplied Liner desktop repository and video as product and visual references only. The result must be an original implementation, not a rebranded copy of Liner.

The app plays audio files that the user owns or has permission to use, manages a local library and playlists, supports synced lyrics, and stores personal data on the current device. It must remain useful without an account, remote API, cloud database, or network connection after the app has been loaded and installed/cached.

**Scope amendment — optional cloud mode.** An additive, opt-in cloud layer may be layered on top of the local-first product (this amendment): private audio object storage in Cloudflare R2, cloud metadata in Supabase Postgres protected by Row Level Security, authentication via Supabase Auth, and a Cloudflare Worker that issues short-lived presigned URLs. Every clause of this PRD continues to apply to the local product; the cloud layer additionally follows section 16 below. When the cloud layer is unconfigured or unsigned-in, the application must be indistinguishable from the local-only product.

**Working name:** Local Music (keep the name configurable; do not use Liner branding, logos, or proprietary assets).

## 2. Goals

1. Play locally selected audio files without uploading them.
2. Keep the music library, playlists, liked songs, queue, playback position, and preferences on the user's device.
3. Support `.lrc` timed lyrics and plain `.txt` lyrics, including syllable/word highlighting only when timestamps exist at that granularity.
4. Match the visual direction of the supplied video: immersive album-art surfaces, dark blue/black interface, soft artwork-derived background color, minimal controls, readable typography, and a dedicated lyrics mode.
5. Work offline after the app shell has been cached/installed, with honest explanations of browser storage limitations.
6. Be lightweight and responsive on mid-range devices.

## 3. Non-Goals

- No Spotify, Apple Music, YouTube Music, Deezer, or other streaming-service integration.
- No third-party streaming catalog, login, subscription, ads, analytics, tracking, or cloud sync.
- No scraping, DRM circumvention, or importing protected streams.
- No server-side upload or processing of audio.
- No promise of true desktop-style filesystem access in every browser. Use supported file pickers and explicitly handle browser limitations.
- No automatic lyric generation, speech recognition, forced alignment, or external AI API in the MVP.
- No copying of Liner's source code, assets, branding, distinctive design files, private APIs, signing logic, shaders, or core implementation. Recreate the general product category with original code and assets.

## 4. Target User and Primary Workflow

**User:** One person maintaining a personal music collection on one device.

**Primary workflow:**
1. Open the app.
2. Import local audio files or a folder where the browser supports it.
3. See the tracks in Library and Home.
4. Play a track; use queue, shuffle, repeat, seek, volume, previous/next.
5. Like tracks and organize songs into playlists.
6. Import an accompanying `.lrc` or `.txt` file, or edit basic metadata/lyrics where supported.
7. Switch to lyrics mode; current line follows playback time.
8. Close/reopen the app and recover saved library metadata and preferences, while understanding that the browser may require the audio files to be selected again if persistent access is unavailable.

## 5. Platform and Technical Constraints

- Build a responsive web application, not an Electron desktop application.
- Prefer the repository's existing stack only if the user is developing inside a permitted personal local copy and the license allows the intended use. Otherwise start a clean project and use an independently chosen stack.
- Recommended baseline for a clean implementation: React, TypeScript, Vite, Tailwind CSS, React Router, and a small state store such as Zustand. Avoid adding libraries without a demonstrated need.
- Use HTML audio APIs for decoding and playback. Do not implement a custom codec layer.
- Use IndexedDB for persistent metadata, playlists, lyric data, settings, and optionally File System Access handles where supported. Use localStorage only for small non-critical preferences.
- Use a Service Worker and web app manifest for app-shell caching. Do not cache arbitrary audio files into Cache Storage by default.
- Use progressive enhancement for File System Access API; provide `<input type="file" multiple>` fallback.
- All key screens must function at 1280×800, 1440×900, tablet widths, and mobile widths down to 360px.
- Avoid hard dependencies on external fonts, image CDNs, remote icon services, or network-loaded scripts. Bundle assets locally.
- The app must not require an API key, backend, database server, authentication, or network after initial app-shell installation.

## 6. Information Architecture and Routes

Use client-side routes with persistent global playback state.

- `/` — Home
- `/library` — All imported tracks
- `/liked` — Liked Songs
- `/playlists` — Playlist index
- `/playlist/:id` — Playlist detail
- `/recent` — Recently Played
- `/now-playing` — Fullscreen/immersive player
- `/lyrics` — Dedicated lyrics view, or a mode within Now Playing if route complexity is unnecessary
- `/settings` — Storage, import, playback, appearance, and data management

The mini-player must remain mounted across route changes. Playback must not restart when navigating between screens.

## 7. Detailed Functional Requirements

### 7.1 Import and Local Library

**MVP**
- Provide an obvious “Import music” action in the sidebar and in the empty-library state.
- Accept multiple local audio files using the browser file picker. Support common browser-decodable formats: MP3, M4A/AAC, WAV, OGG, and FLAC where the browser supports them. Do not claim universal codec support; detect unsupported formats and explain the limitation.
- Allow importing a folder when directory selection is available. If unavailable, retain multi-file import.
- Read basic metadata when feasible: title, artist, album, track number, duration, embedded cover art. Use filename-derived fallbacks when metadata is absent.
- Never upload selected audio, cover art, or lyrics.
- Display import progress for large selections, skipped duplicates, unsupported files, and errors.
- Detect duplicates using a stable combination of file metadata and size; where practical, add a local fingerprint. Do not hash entire large files synchronously on the UI thread.
- Provide a library empty state with clear import instructions and a short privacy note.
- Show the actual storage/access mode: “Stored metadata”, “File access retained”, or “Re-import required” rather than implying files are permanently stored if they are not.

**Persistent file access**
- Feature-detect the File System Access API. If available and permission is granted, store handles in IndexedDB and revalidate permission when the app reopens.
- If handles are unsupported or permission is revoked, preserve track metadata and show “Locate file” / “Re-import files”.
- Do not silently convert a transient `File` object into a supposed permanent path.
- Never store absolute local file paths unless the browser explicitly exposes a supported handle model.

### 7.2 Home

Recreate the visual hierarchy shown in the supplied video, using original UI assets and components.

- Greeting/header near the top with a subtle time-of-day variation only if appropriate.
- “Liked Songs” feature tile with a distinct heart treatment and saved track count.
- “Recently Played” and “Your Playlists” sections.
- “Continue Listening” or “Recently Added” section based on actual local data.
- Responsive artwork cards with title, subtitle, and hover/focus actions.
- Empty states must remain useful and not show fake music statistics.
- Use local demo data only in an explicitly labeled preview/development mode. Production must not seed fake songs into the user's real library.

### 7.3 Library

- Table/list view with columns: cover, title, artist, album, duration, date added, and an overflow actions menu.
- Sort by title, artist, album, date added, duration, and recently played.
- Search tracks by title, artist, album, and filename.
- Filter liked songs and recently added tracks where useful.
- Virtualize the list if track count becomes large; do not render thousands of expensive artwork components at once.
- Row click plays the selected track; controls and menus must not accidentally trigger row playback.
- Include play next, add to queue, add/remove from liked songs, add to playlist, and remove from library.
- Confirm destructive actions and distinguish removing library metadata from deleting the source file. Never delete the user's original file.

### 7.4 Playlists

- Create, rename, and delete a playlist.
- Add/remove tracks and reorder tracks using drag-and-drop with an accessible keyboard alternative.
- Store playlist IDs and track references in IndexedDB.
- Show track count, total duration, optional user-defined cover collage, and playlist actions.
- Support empty playlist states.
- Deleting a playlist must not delete the tracks from the library.
- If a referenced track is missing, show it as unavailable and offer relinking/removal.

### 7.5 Liked Songs

- Toggle liked state from cards, rows, mini-player, and now-playing view.
- Persist liked state in IndexedDB.
- Liked Songs page must update immediately and consistently without a refresh.
- Sort and search liked songs using the same conventions as Library.

### 7.6 Playback Engine

Use one shared audio element or a single playback service as the source of truth.

Required controls:
- Play/pause
- Previous/next
- Seek timeline with current and total time
- Volume and mute
- Shuffle
- Repeat off / repeat all / repeat one
- Add/remove queue item
- Clear queue
- Queue reordering
- Play selected track and continue through the active context (library, playlist, or search results)
- Show loading, buffering, unsupported source, missing file, and ended states
- Resume the last track and position when technically possible, without claiming reliability if file access is missing
- Prevent duplicate audio elements from playing simultaneously
- Avoid abrupt state races when a user rapidly switches tracks
- Handle browser autoplay restrictions: only start audio following an explicit user gesture and show a clear prompt when blocked

**Playback state model**
Maintain a single global state containing at least:
- `currentTrackId`
- `currentTime`
- `duration`
- `isPlaying`
- `volume`
- `isMuted`
- `shuffleEnabled`
- `repeatMode`
- `queueTrackIds`
- `queueIndex`
- `activeCollectionId` or equivalent playback context
- `lastPlayedAt` per track

Do not store continuously changing `currentTime` in IndexedDB on every animation frame. Persist position at sensible intervals and on pause/track changes.

### 7.7 Lyrics

**Supported input**
- Timed `.lrc` lyric files, including multiple timestamps per line when practical.
- Plain `.txt` lyrics, displayed as static text with no pretend synchronization.
- Optional embedded lyrics only if metadata parsing can be implemented reliably without bloating the app.

**Matching and import**
- Let the user associate a lyric file with the currently selected track.
- Match sidecar files by filename only as a suggestion; always allow manual correction.
- Store parsed lyric entries in IndexedDB, keyed to a stable local track ID.
- Validate malformed timestamps and report lines that could not be parsed.
- Support a global lyric offset adjustment (at least -10s to +10s) in the lyrics view or settings. Persist the offset per track.
- Provide a simple lyric editor for correcting text/timestamps only if it can be done without compromising the MVP playback flow.

**Synchronization**
- Compute the active lyric line from the audio element's current playback time; do not use a separate timer as the timing authority.
- Update the active lyric on `timeupdate` and use `requestAnimationFrame` only for visual interpolation where necessary.
- Auto-scroll the lyrics container so the active line stays visible; avoid aggressive scrolling on every frame.
- Clicking a timed lyric line seeks playback to its timestamp.
- Keep previous/current/next lines visible, with the current line emphasized.
- For LRC line timestamps, highlight entire active lines. Only render word/syllable-level highlighting when actual word/syllable timestamps exist; never fabricate precision from line-level LRC data.
- Provide clear states: synced lyrics, static lyrics, no lyrics, and unsupported/malformed lyric file.

### 7.8 Now Playing and Lyrics Mode

Use the video as visual direction:
- Artwork is the primary visual anchor.
- Derive a low-saturation background tint from the current cover when practical, with a safe dark fallback.
- Use a dark translucent overlay/gradient for text contrast.
- Display current track title, artist, cover, transport controls, progress, and favorite action.
- Lyrics mode uses a spacious vertical lyric layout with centered or left-aligned lines based on viewport; current line is bright, surrounding lines are muted.
- Support keyboard navigation and an explicit back/close action.
- Optional fullscreen presentation must use the browser Fullscreen API only after user interaction and gracefully fall back if denied.
- Do not autoplay transitions or add elaborate animations that distract from reading lyrics.
- Respect `prefers-reduced-motion`.

### 7.9 Mini-Player and Queue

- Persistent bottom player across all primary routes.
- Desktop layout: artwork and track metadata on the left, playback controls centrally, progress/volume and queue/lyrics actions on the right.
- Mobile layout: compact player with essential play/pause and track info; expanded player provides full controls.
- Keep touch targets usable at mobile sizes.
- Queue panel can open from the player, supports reordering/removal, and clearly distinguishes the current track.
- Current playback must continue while the queue panel or route changes.

### 7.10 Search

- Search only the user's indexed local library and playlists.
- Search should feel instantaneous for a collection of 5,000 tracks on a typical mid-range laptop.
- Keyboard shortcut `/` or `Ctrl/Cmd+K` may focus search if it does not conflict with native controls.
- Show results grouped by tracks and playlists.
- Never issue network requests for searches.

### 7.11 Persistence, Backup, and Reset

Persist:
- Track metadata and local identifiers
- Playlists and their ordered track IDs
- Liked states
- Recently played history
- Lyrics and per-track lyric offsets
- Preferences and last playback state

Provide:
- Export library metadata/playlists/likes/lyrics as a versioned JSON backup.
- Import and validate that backup without overwriting current data until the user confirms.
- Clear library metadata with confirmation.
- Explain that clearing the library database does not delete original audio files.
- Show approximate database/storage use where supported.
- Handle IndexedDB failures, quota errors, migration failures, and corrupted backups without losing the only copy of data silently.

### 7.12 Offline and PWA Behavior

- Include a web app manifest and service worker.
- Cache the app shell, local styles/scripts, icons, and essential UI assets.
- Display offline/online status only when it helps explain behavior.
- The core UI and saved metadata must load offline after successful installation/caching.
- Local audio playback must not need a network request.
- Do not imply that service workers can guarantee permanent storage of user-selected audio files.
- Never make app startup depend on fonts, images, scripts, or API responses from a CDN.
- Add a visible install hint only when the browser supports PWA installation and the app is not already installed.
- Test offline loading in a production build served over HTTPS or localhost, because service workers do not work in every insecure context.

### 7.13 Settings

Include:
- Theme: Dark (default), Light, System. Dark is the priority visual reference.
- Appearance intensity: subtle artwork tint on/off.
- Reduced motion: follow system preference plus optional manual override.
- Default playback behavior: autoplay next, shuffle, repeat.
- Lyrics: font size, alignment, line spacing, lyric offset reset.
- Storage and file-access status.
- Export/import backup.
- Clear local data and restore defaults.
- Supported file formats and browser limitations.
- App version and privacy statement.

## 8. Visual Design System

### 8.1 Design Direction
- Premium, calm, music-focused, editorial dark interface.
- Follow the supplied video’s broad composition: compact navigation, artwork-led home, subtle blue/teal/pink color notes, dark backgrounds, and immersive lyrics.
- Do not copy exact Liner layout pixel-for-pixel or reuse Liner's trademarks, logo, custom assets, or distinctive protected design assets.
- No generic neon gradients, glowing borders, excessive glassmorphism, random decorative shapes, or AI-dashboard aesthetics.

### 8.2 Color Tokens
Use CSS custom properties, not scattered hard-coded colors.

Suggested dark tokens:
- `--bg`: `#090B12`
- `--surface`: `#111522`
- `--surface-raised`: `#191F2D`
- `--surface-hover`: `#232B3D`
- `--text-primary`: `#F4F6FB`
- `--text-secondary`: `#A4ACBD`
- `--text-muted`: `#70798D`
- `--border-subtle`: `rgba(255,255,255,0.08)`
- `--accent`: `#8DA8FF`
- `--accent-strong`: `#6285FF`
- `--success`: `#74D6B0`
- `--danger`: `#FF737D`

Artwork tints are dynamic accents only. Maintain minimum text contrast and never let album colors dictate the whole UI.

### 8.3 Typography
- Prefer a locally bundled, legible sans-serif such as Inter or a system font stack.
- Main page headings: 24–32px desktop, scaled responsively.
- Track title: 13–15px in dense lists, 16–22px in featured areas.
- Secondary metadata: 12–14px.
- Lyrics: 28–48px on large screens, 20–30px on mobile; use `clamp()` and avoid clipping long lines.
- Keep type weights restrained. Avoid too many font families or ultra-thin text.

### 8.4 Layout
- Desktop sidebar width approximately 220–250px.
- Main content padding approximately 28–40px at desktop and 16–20px on mobile.
- Persistent player height approximately 76–92px on desktop.
- Use a consistent spacing scale based on 4px or 8px increments.
- Rounded corners should be restrained: 8–16px for most surfaces; larger only for featured artwork.
- Use consistent icon sizes (16, 18, 20, 24px) and align icons with labels.
- Avoid excessive cards when a simpler list or editorial section is more appropriate.
- On narrow screens, collapse the sidebar into a navigation drawer/bottom navigation and prevent horizontal overflow.

### 8.5 Interaction and Motion
- Use 120–220ms for small transitions; keep transitions purposeful.
- Album art can softly scale or shift on play-state changes; no constant spinning unless explicitly enabled.
- Hover effects must have keyboard-focus equivalents.
- Always include visible focus states.
- Follow `prefers-reduced-motion`.
- Never use animation to communicate essential state without a textual or structural equivalent.

## 9. Data Model

Use TypeScript types and versioned IndexedDB schema.

With the optional cloud layer (section 17), `Track` gains **optional** fields so every pre-cloud record stays valid: `objectKey`, `artworkObjectKey`, `storageProvider`, `cloudStatus` (`"local" | "uploading" | "ready" | "failed"`), and `lastSyncedAt`. `availability` may additionally be `"offline"` (a cloud track with no local copy while the device is offline) and `accessMode` may be `"cloud"`. Only object keys are persisted — never a presigned URL.

```ts
type Track = {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number | null;
  fileName: string;
  fileSize: number;
  mimeType: string;
  addedAt: number;
  lastPlayedAt: number | null;
  playCount: number;
  isLiked: boolean;
  artworkBlob?: Blob;
  fileHandle?: FileSystemFileHandle;
  availability: "available" | "permission-required" | "missing" | "unsupported";
  fingerprint?: string;
};

type Playlist = {
  id: string;
  name: string;
  description?: string;
  trackIds: string[];
  createdAt: number;
  updatedAt: number;
};

type LyricLine = {
  timeMs: number | null;
  text: string;
  words?: Array<{ text: string; startMs: number; endMs?: number }>;
};

type TrackLyrics = {
  trackId: string;
  format: "lrc" | "txt";
  lines: LyricLine[];
  offsetMs: number;
  updatedAt: number;
};

type AppPreferences = {
  theme: "dark" | "light" | "system";
  volume: number;
  shuffle: boolean;
  repeatMode: "off" | "all" | "one";
  reducedMotion: "system" | "on" | "off";
  artworkTint: boolean;
  lastTrackId?: string;
  lastPositionMs?: number;
  schemaVersion: number;
};
```

Adjust types to match real browser support. Do not serialize File System Access handles into JSON backups. A JSON backup should contain metadata and lyrics, not audio bytes or machine-specific file paths.

## 10. Architecture Guidelines

Keep code organized by feature and separate UI from persistence and playback logic.

Suggested structure:

```text
src/
  app/
    router.tsx
    providers.tsx
  components/
    AppShell.tsx
    Sidebar.tsx
    MiniPlayer.tsx
    TrackRow.tsx
    Artwork.tsx
    EmptyState.tsx
    ConfirmDialog.tsx
  features/
    library/
    playlists/
    liked/
    search/
    player/
    lyrics/
    settings/
    backup/
  services/
    audio/
    metadata/
    indexeddb/
    file-access/
    offline/
  stores/
  styles/
  types/
  utils/
public/
  icons/
  manifest.webmanifest
  service-worker.js
```

Treat this as a guide, not a reason to force needless abstractions.

Responsibilities:
- `AudioService`: owns the single audio element and media event handling.
- `LibraryRepository`: IndexedDB CRUD and schema upgrades.
- `FileAccessService`: import, permission checks, relinking, and missing-file states.
- `LyricsService`: parse LRC/TXT, apply offsets, and calculate active lines.
- `PlaybackStore`: global playback, queue, and active context.
- `OfflineService`: service worker registration and offline status.
- UI components: render state and dispatch actions; do not directly manipulate IndexedDB.

## 11. Accessibility

- Semantic landmarks and headings.
- Keyboard-accessible navigation, dialogs, menus, player, queue, and lyrics.
- Proper accessible names for icon-only controls.
- At least 44×44px touch targets for primary mobile controls where layout allows.
- Visible focus ring and logical tab order.
- Announce track changes and important playback errors through a restrained `aria-live` region.
- Do not announce every time update to screen readers.
- Maintain contrast in dynamic artwork backgrounds.
- Respect reduced motion and user zoom.

## 12. Performance and Reliability Targets

Treat these as acceptance targets on a mid-range laptop, not claims to make without measurement:
- Initial cached app shell should be usable within 2 seconds on a local/fast connection.
- Search within 5,000 indexed tracks should return within 150ms for common queries after indexing.
- Playback controls should respond without perceptible delay, typically under 100ms excluding file loading.
- Avoid persistent animation loops when the player or lyrics are not visible.
- Keep artwork dimensions bounded and use thumbnail variants where practical.
- Revoke object URLs when no longer needed.
- Debounce persistence writes and batch database operations.
- Run large metadata/fingerprint tasks away from the main UI thread where practical.
- No unhandled promise rejections during import, permission prompts, or playback transitions.
- No accidental audio playback from multiple elements.

## 13. Error and Empty States

Provide explicit recoverable messages for:
- Empty library
- Unsupported file format
- Missing or permission-denied audio file
- File handle no longer available
- Malformed LRC
- Lyrics not found
- Storage quota exceeded
- Database unavailable
- Invalid backup file
- Autoplay blocked
- Playback decoding error
- Offline app shell not yet cached

Each error must say what happened and provide a concrete next action. Never display fake success messages.

## 14. Delivery Phases

### Phase 0 — Repository and License Audit
- Inspect existing project files, dependencies, and license before changing anything.
- Confirm whether the work is a clean-room implementation or a permitted local modification.
- Do not repurpose Liner branding/assets or copy prohibited implementation details.
- Write a short architecture note before adding dependencies.

### Phase 1 — App Shell and Design System
- Responsive navigation and route layout
- Design tokens, typography, icons, reusable surfaces
- Home, Library, Liked Songs, Playlists, Now Playing, Settings screens with honest empty states
- Mini-player layout and state model

### Phase 2 — Local Audio Playback
- Audio import and metadata extraction
- Shared playback service
- Queue, shuffle, repeat, seek, volume, keyboard controls
- Missing/unsupported file states

### Phase 3 — Local Persistence and Organization
- IndexedDB repository and migrations
- Liked Songs, playlist CRUD, recently played
- Resume behavior and import duplicate handling
- Backup export/import

### Phase 4 — Lyrics
- LRC/TXT import and parsing
- Active line synchronization and click-to-seek
- Offset control, lyric view, malformed file handling

### Phase 5 — Offline and Polish
- Service worker and manifest
- Offline validation
- Accessibility, responsive testing, performance fixes
- Error boundary and regression tests

Build in vertical slices. Each phase must leave the app runnable.

## 15. Acceptance Criteria

The app is considered MVP-complete only when all applicable tests pass:

1. A user can import at least 20 local tracks and see correct fallback metadata for files without tags.
2. Selecting a track starts playback after a user gesture and shows correct elapsed/total time.
3. Play/pause, seeking, previous/next, volume, shuffle, repeat-one, repeat-all, and queue operations work.
4. Navigating between Home, Library, Liked Songs, Playlist, and Settings does not reset active playback.
5. Liked state persists after reload.
6. A created playlist, its order, and its tracks persist after reload.
7. A valid `.lrc` file shows the correct active line based on the audio time; clicking a line seeks to its timestamp.
8. A `.txt` lyric is rendered as static text and is not falsely presented as synchronized.
9. Lyric offset visibly changes active-line timing and persists per track.
10. If audio access is lost, the track remains represented with a clear relink/re-import action.
11. Export then import of a backup restores playlists, liked state, and lyrics without audio upload.
12. After the app shell has been installed/cached, the UI loads without network connectivity.
13. No audio, lyrics, or metadata are transmitted to any remote endpoint.
14. No cloud auth, remote database, analytics SDK, or mandatory API key exists.
15. The app remains usable at 360px width without horizontal page overflow.
16. Keyboard navigation, visible focus, reduced-motion preference, and accessible names are verified.
17. Production build, lint, type checking, and automated tests pass.
18. The README explains setup, supported browsers, offline limits, backup behavior, and the license/reuse boundary.

## 16. Final Implementation Notes

- Inspect the current repository before modifying files; do not assume it is empty or that its existing architecture matches this document.
- Build real working interactions, not static mockups.
- Never fabricate local audio files, cover art, playlists, counts, or “recently played” activity in production.
- Where browser capabilities differ, prefer graceful degradation and a clear UI over a broken flow.
- If a requirement is blocked by browser security or codec support, document the limitation and implement the best supported alternative rather than faking it.

## 17. Optional Cloud Mode (amendment)

This section governs the opt-in cloud layer only. It never weakens sections 1–15.

### 16.1 Architecture

- React + Vite application (unchanged) talks to three external systems: Supabase Auth, Supabase Postgres, and a Cloudflare Worker.
- Cloudflare R2 holds private audio and artwork objects. The bucket is never public.
- IndexedDB remains the local cache, offline metadata store, optional offline audio copy store, and must stay backward compatible with pre-cloud libraries.
- The Worker is a **separate project** with its own package, config, and tests. It does not change the frontend's package manager or build.

### 16.2 Security requirements (hard)

- A valid Supabase access token is required for every protected operation. The token signature is verified — or the token is verified against the Supabase Auth service. A decoded but unverified JWT and any browser-supplied user id are forbidden.
- Object keys are `users/{userId}/tracks/{trackId}/audio.{ext}` style, constructed and validated on the server, scoped to the authenticated user.
- R2 credentials, the Supabase service-role key, and JWT secrets are Worker secrets only. They must never appear in `VITE_*` variables, source, or browser storage.
- Playback URLs are short-lived presigned URLs generated on demand. No presigned URL is stored as a permanent database or IndexedDB value, and they are never cached in the service worker.
- Issuing an upload URL proves nothing: the object's existence, size, and metadata are verified before the upload is marked complete.
- Upload validation, restrictive CORS, meaningful HTTP status codes, and actionable error bodies are required.

### 16.3 Cloud database

- Version-controlled SQL migrations only. Schema supports tracks and their object keys, playlists with membership ordering, liked state, playback metadata, lyrics with timing and per-track sync offsets, ownership (`user_id`), and timestamps.
- Row Level Security is enabled with explicit SELECT/INSERT/UPDATE/DELETE policies per table. Cross-user access must be impossible at the database layer.
- Sync is idempotent: retries never create duplicate tracks, playlists, or membership rows. Existing stable track ids are reused.

### 16.4 Frontend behavior

- Tracks carry optional, backward-compatible cloud fields: `objectKey`, `artworkObjectKey`, `storageProvider`, `cloudStatus` (`local` | `uploading` | `ready` | `failed`), `lastSyncedAt`.
- The supported flows are: local import (unchanged), authenticated upload, cloud metadata written only after verification, cloud library fetch on sign-in, playback of local **or** cloud sources through the existing engine, refresh of expired playback URLs with recovery from transient network failures, and sync of playlists, likes, lyrics, and metadata across devices.
- Cloud network calls live in services, never inside UI components. Stores and repositories are adapted, not bypassed.

### 16.5 Local library migration

- A migration interface exists in Settings → Storage (or an equally discoverable place).
- It detects tracks with audio in IndexedDB, in a usable File System Access handle, or in the current session; it requests file access only following an appropriate user action; it shows tracks that cannot currently be accessed with a manual relink option.
- It reports upload progress, total files, the current file, success count, failures, and retry actions. It skips or reconciles duplicates using the existing fingerprint and stable track id. It uploads with bounded concurrency. It preserves lyrics, playlists, liked state, play history, and existing track ids. It verifies each cloud object before updating cloud metadata.
- It **never** deletes the original file or the local audio copy automatically. Local records are preserved when authentication, network, upload, or database writes fail. Removing a local copy is a separate, explicit user action available only after the cloud copy and metadata are verified.

### 16.6 Playback and offline

- The existing shared audio engine and its clock are used unchanged for cloud sources; metadata loading, seeking, pausing, resuming, track switching, queue operations, and synchronized lyrics must work without timing drift.
- Local-file playback is preserved. A cloud track that is not cached locally and is offline must show a clear unavailable/offline state rather than fail silently.
- The service worker must not cache large remote audio files by default; local caching of cloud audio is an explicit, documented option.
- Existing import, lyric discovery, artwork, playlist, and metadata parsing features must continue to work.

### 16.7 Acceptance criteria

- Local and cloud import; duplicate detection and repeated uploads; upload success, failure, cancellation, and retry; invalid or expired authorization; cross-user access denial; object size and metadata verification; missing or revoked local file access; playback switching and seeking with cloud audio; signed URL expiration and refresh; playlist/lyrics/liked synchronization; IndexedDB backward compatibility and offline fallback; and a failed cloud sync must never lose local data — each covered by a test.
- The Worker has equivalent tests, and the SQL authorization policies are tested where a database instance is feasible.
