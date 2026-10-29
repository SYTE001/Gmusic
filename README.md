# Local Music

An offline-first, personal music player for the web. Import audio files from this device, build a library with playlists and liked songs, play them with a full queue/shuffle/repeat engine, and follow along with synchronized `.lrc` lyrics — with no account and no network dependency by default.

**Optional cloud mode** adds private audio storage (Cloudflare R2), authenticated metadata sync (Supabase Postgres, RLS-protected), and a single URL-signing Cloudflare Worker — without changing the local-first behavior of the app. Cloud features are invisible unless configured and signed in, and the app remains fully usable without them.

This is an **original, clean-room implementation**. It takes general product-category inspiration from desktop players such as Tryliner's Liner (and the supplied reference video) for visual direction only. No code, assets, branding, shaders, or internals were copied from any reference project. The app uses its own name, icons, and components.

## Privacy in one paragraph

Your audio files, artwork, and library data never leave this device. There is no backend, no analytics, no telemetry, and no API key. The app makes exactly two kinds of network requests: its own app-shell assets (HTML/CSS/JS/icons) when loading or updating, and — if you enable online lyrics — **metadata-only lookups to [lrcmux](https://api.lrcmux.dev)** (song title, artist, album, duration; never audio). Both are cacheable/offline-friendly; everything else works fully offline. Disable *Settings → Lyrics → Find lyrics online automatically* to make the app strictly no-network. With cloud mode enabled and you signed in, audio bytes are uploaded to your private R2 bucket and library metadata to your Supabase project — strictly per-user. See the "Cloud mode (optional)" and "Architecture" sections below.

## Setup

```bash
npm install
npm run dev        # development server (http://localhost:5173)
```

Production build + preview (service worker requires localhost or HTTPS):

```bash
npm run build      # tsc + vite build + service-worker precache injection
npm run preview    # serves dist/ at http://localhost:4173
```

Quality checks:

```bash
npm run typecheck  # TypeScript, strict
npm run lint       # ESLint (typescript-eslint + react-hooks)
npm test           # Vitest unit/component suite (250 tests)
```

The Cloudflare Worker has its own package, config, and test run:

```
cd worker
npm install
npm run typecheck  # Worker TypeScript
npm test           # Miniflare + in-memory R2 (36 tests)
npm run build      # wrangler bundle (dry run)
```

## Supported browsers

- **Chrome / Edge (Chromium)** — best experience: the File System Access API is used to import files and folders with persistent handles, so tracks stay playable across reloads after a one-click permission re-grant.
- **Firefox / Safari** — no persistent file handles; the app falls back to the standard multi-file picker. Enable **Settings → Storage → “Keep copies of audio in this app”** (default on for these browsers) so imported music stays playable after a reload.
- **Codec support is the browser's, not the app's.** MP3, AAC/M4A, FLAC, OGG (Vorbis/Opus), and WAV generally work in current Chromium and Firefox. Every imported file is decode-probed with a real audio element; anything your browser cannot decode is reported in the import summary rather than silently added.

## Where your data lives (and what that means)

Everything is stored in the browser profile's IndexedDB on this device:

| Data | Where | Survives reload? |
| --- | --- | --- |
| Track metadata, likes, play history | IndexedDB | Yes |
| Playlists and their order | IndexedDB | Yes |
| Lyrics + per-song offsets + lrcmux cache | IndexedDB | Yes — cached lyrics play offline |
| Settings and last playback position | IndexedDB | Yes |
| Audio bytes | File handles (Chromium) or stored copies (if enabled) | Handles: yes, after permission re-grant · Copies: yes · Neither: **no** |

Three honest access states are shown throughout the UI: **File access retained** (handle), **Stored in app** (copy in IndexedDB), and **Re-import required** (session-only file; the app keeps the metadata and offers *Locate file* / *Grant access* to relink). Browser storage can still be evicted under disk pressure or cleared with browser data — export a backup for anything you care about.

Removing a track or clearing the library only removes the app's own records. **The original audio files on your computer are never modified or deleted.**

## Cloud mode (optional)

Cloud mode is an additive layer. Nothing about the local library changes when it is off or not configured; signing out (or never signing in) leaves every local record exactly as it was.

**What it does**

- Uploads selected tracks to R2 (Settings → Storage → *Move your library to the cloud*, or *Upload to cloud* on a track's menu). Uploads run with bounded concurrency, show per-file progress, and verify **each object before any metadata is written** — an issued URL is never treated as a successful upload.
- Syncs playlists, liked state, lyrics (with their per-song offsets), and play history to Supabase Postgres so a second signed-in device sees the same library. Syncs are idempotent: repeated runs never duplicate a track, playlist, or membership row, and duplicates are reconciled by the stable fingerprint.
- Falls back to the cloud for playback when no local copy exists. Resolution order is deliberately **local first** (handle → stored copy → session file → cloud), so a track you have locally never pays for a network round trip and keeps playing offline.
- Caches playback links in memory only, refreshes them before they expire, and recovers from a stale link mid-playback by re-resolving and resuming in place.

**What it guarantees**

- **Private audio.** The R2 bucket stays private; the Worker is the only thing with S3 credentials, and it hands out short-lived URLs (default 120 s PUT, 300 s GET) after verifying your Supabase access token's **signature** — never a decoded JWT, never a browser-supplied user id. The token must also declare the HS256 algorithm and carry valid claims (`exp`, `nbf`, `iat`, issuer, optional audience, `role: authenticated`), so the publishable anon key — which is a real JWT signed with the same secret — cannot be used as a user token. Object keys are `users/{userId}/tracks/{trackId}/audio.{ext}`, constructed and validated server-side.
- **No secrets in the browser.** Only `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (the publishable key), and `VITE_WORKER_URL` reach the frontend. The Supabase service-role key, JWT secret, and R2 access keys are Worker secrets set with `wrangler secret put`.
- **Row-level isolation.** Every user-scoped table in Postgres carries `user_id` and explicit RLS policies for SELECT/INSERT/UPDATE/DELETE; a defensive trigger asserts ownership a second time. No presigned URL is ever stored as a database value — only object keys.
- **Uploads are size- and type-limited.** The Worker caps upload size (`MAX_UPLOAD_BYTES`, 500 MB) and requires a real audio/image content type that matches the file's extension; `text/html` or `application/octet-stream` are rejected, and the rule is re-checked before completion. A rejected upload has its unclaimed object cleaned up so R2 never holds audio with no metadata.
- **Deletions never leave orphans.** Cloud deletion removes R2 objects first, then metadata; both halves are idempotent and re-verified. If either half fails, the remaining work is recorded in IndexedDB and retried on every sync, so a half-finished deletion always converges instead of leaving unreachable bytes (or rows pointing at a missing object). Metadata removal only reports success after confirming no row for the track remains.
- **Local data is never collateral damage.** A failed upload, a failed verification, a dead network, or a failed database write changes nothing locally. Migration never deletes your file, your IndexedDB copy, or your file handle. Removing a local copy is a separate explicit action, offered only after the cloud copy and metadata are confirmed. Cloud options appear in the UI only when they perform a real operation.

**Setup** (all dashboard steps, in order)

1. Create a Supabase project; enable Email auth. Copy the project URL and the **anon** public key (Settings → API). Apply the SQL migrations from `supabase/migrations/0001_cloud_library.sql` (SQL editor, or `supabase db push`). Run the policy tests in `supabase/tests/rls_policies.test.sql` with `supabase test db` to verify the RLS policies.
2. Create a Cloudflare R2 bucket (keep it private) and generate an API token with Object Read & Write permissions. Note the account ID, access key ID, secret, and bucket name.
3. Create the Worker from the `worker/` directory: `npm install`, `wrangler login`, set the secrets listed in `worker/wrangler.toml` with `wrangler secret put`, point `ALLOWED_ORIGIN` at your deployed frontend origin, then `npm run deploy`.
4. Copy `.env.example` to `.env` and fill in the three `VITE_*` values (Supabase URL, anon key, Worker origin). Rebuild the frontend.
5. Sign in under Settings → Cloud and start the migration from Settings → Storage.

**Environment variables**

| Variable | Scope | Purpose |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | frontend | Supabase project URL (browser-safe) |
| `VITE_SUPABASE_ANON_KEY` | frontend | Supabase publishable key; RLS enforces access |
| `VITE_WORKER_URL` | frontend | Worker origin issuing presigned URLs |
| `SUPABASE_JWT_SECRET` | Worker secret | verifies Supabase access-token signatures |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Worker secrets | auth-service verification fallback |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Worker secrets | S3-compatible presigning only |
| `ALLOWED_ORIGIN`, `MAX_UPLOAD_BYTES`, `*_TTL_SECONDS` | Worker vars | CORS, size cap, URL lifetimes |

**Offline limitations of cloud mode (deliberate)**

- A cloud track is not cached locally unless you ask: the track menu offers *Keep a local copy*, which downloads the verified object into IndexedDB.
- The service worker never caches remote audio or signed URLs by design. A cloud-only track shows a clear **offline — this song is in the cloud** state in lists and an explicit error on play rather than silently failing.
- Migration requires reachability. Tracks whose handles lost permission, or whose files are gone, are listed with a *Locate file* path and are never silently skipped.

## Backups

Settings → Backup exports a versioned JSON file with all metadata, playlists, liked state, and lyrics. Audio bytes and machine-specific file handles are deliberately excluded. Restoring validates the file fully, shows a summary, and only replaces current data after you confirm. After a restore, re-import or re-link your audio files to make tracks playable again.

## Lyrics

Three sources, clearly labeled in the UI:

1. **lrcmux auto-discovery** (online, optional). When a track starts and no lyrics are cached, the app looks it up on [lrcmux](https://api.lrcmux.dev) using only title/artist/album/duration. The exact endpoint's result is *still validated client-side* (the API's duration matching is loose); searches are ranked by title/artist/album similarity, duration proximity, and sync quality. A high-confidence match attaches automatically; anything ambiguous shows a **candidate chooser** instead of silently attaching possibly-wrong lyrics. Instrumental results, plain (unsynced) lyrics, and word-synced lyrics are each handled and labeled for what they are.
2. **Manual `.lrc` / `.txt` import** — always available, works fully offline.
3. **Cache** — every resolved record is stored in IndexedDB with its record ID, capability, and your per-song offset, so lyrics replay offline and are never re-fetched on every play. Failed lookups are remembered for a week before retrying.

Timing behavior: the audio element's clock is the single source of truth (no independent timers — pausing, seeking, stalls, and background-tab throttling can't cause drift). Line highlighting uses binary search over the timeline; word-level highlighting appears **only** when the source genuinely carries per-word timestamps (lrcmux word sync or enhanced LRC `<mm:ss.xx>` tags) — never fabricated from line-only data. Clicking a timed line seeks; ±0.5 s offset buttons (±10 s range) shift timing per song, persist across reloads, and never modify the original record.

Discovery politeness: requests to lrcmux are sequential with a 300 ms gap, time out after 10 s, retry transient failures a bounded number of times, and respect `429`/`Retry-After`. API failures never affect playback.

## Keyboard shortcuts

`Space` play/pause · `←/→` seek ±5s · `Shift+←/→` previous/next · `↑/↓` volume · `M` mute · `S` shuffle · `R` repeat · `L` like current song · `Q` queue panel · `/` or `Ctrl/Cmd+K` focus search. Shortcuts are suppressed while typing.

## Offline behavior (PWA)

The app ships a manifest and a dependency-free service worker that precaches the exact app shell (HTML, hashed JS/CSS, icons) at build time. After one online visit (or an install), the interface and all saved data load with no network. What the service worker does **not** do: cache your audio files (they live in IndexedDB handles/copies or are read from disk), or guarantee storage permanence — browsers may evict site data under storage pressure (Settings shows usage and offers a persistent-storage request). Installability depends on the browser; an install hint appears only when the browser supports it and the app isn't installed yet.

## Limitations, honestly

- Importing via the fallback file picker on Chromium does not grant persistent access; those tracks need re-import after reload unless stored copies are enabled (the app warns at import time).
- Metadata parsing is deliberately lightweight (ID3v2.3/2.4, MP4 `ilst`, FLAC Vorbis comments/pictures, Ogg Vorbis/Opus comments). Files with unusual or corrupt tags fall back to filename-derived names. WAV has no tags we read.
- Word-level lyric highlighting requires real word-level timestamps. When lrcmux provides word sync, each word highlights as it is sung; otherwise line-level or plain text is shown — the badge always tells you which.
- lrcmux discovery needs internet; offline you get previously cached or manually imported lyrics.
- Folder import needs `showDirectoryPicker` (Chromium); elsewhere use multi-file import.

## License / reuse boundary

This project is MIT-licensed (see `LICENSE`). It is an independent implementation and is not affiliated with or endorsed by Tryliner or the Liner project. The referenced desktop repository is source-available with a **non-commercial license restricting public competing forks, redistribution, trademark use, and extraction of core algorithms or assets** — none of its code, assets, branding, or distinctive implementation details were used here, and nothing from this project should be represented as derived from it. If you fork this app, keep it clearly separate from any reference product.

## Architecture

```
React + Vite + TypeScript (this repo)
  + Supabase Auth (browser SDK, publishable key only)
  + Supabase Postgres  — cloud metadata, RLS-isolated per user
  + Cloudflare Worker  — issues presigned R2 URLs, verifies uploads
  + Cloudflare R2      — private audio + artwork objects
  + IndexedDB          — local cache, offline metadata, optional local audio
                         copies, backward-compatible with pre-cloud libraries
```

Signed URLs never enter IndexedDB, a Track record, or the service worker; the
repository stores object keys only and asks for a URL when playback needs one.

## Project structure

```
src/
  app/          router, root component
  components/   shell, sidebar, mini-player, track row, dialogs, artwork, icons…
  features/     home, library, liked, playlists, recent, player, lyrics, settings
  services/     audio engine · metadata parsers · IndexedDB repository ·
                file access (local + cloud resolution) · lyrics parsing ·
                import · backup · offline · cloud (auth, R2 storage,
                library sync, local-to-cloud migration)
  stores/       Zustand stores: playback, library, settings, toasts, cloud
  types/        persisted entity types (cloud fields are all optional)
supabase/       version-controlled SQL migrations + RLS policy tests
worker/         separate Cloudflare Worker package (own tests + config)
public/         manifest, service worker, icons
scripts/        SW precache injection, icon + test-media generators
test-media/     generated WAV/LRC fixtures for browser verification
```

The playback engine owns exactly one `HTMLAudioElement` (created outside React); the audio element's clock is the timing authority for progress and lyric synchronization.
