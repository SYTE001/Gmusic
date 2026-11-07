# Gmusic

An offline-first, personal music player for the web. Import audio files from this device, build a library with playlists and liked songs, play them with a full queue/shuffle/repeat engine, and follow along with synchronized lyrics — with no account and no network dependency by default.

**Optional cloud mode** adds private audio storage (Cloudflare R2), authenticated metadata sync (Supabase Postgres, RLS-protected), and a Cloudflare Worker that issues short-lived signed URLs — without changing the local-first behavior of the app. Cloud features are invisible unless configured and signed in, and the app remains fully usable without them.

This is an **original, clean-room implementation**. It takes general product-category inspiration from desktop players such as Tryliner's Liner for visual direction only. No code, assets, branding, shaders, or internals were copied from any reference project. The app uses its own name, icons, and components.

## Features

- **Local library import** — pick files or folders (File System Access API on Chromium, standard picker elsewhere). Metadata is parsed with built-in tag readers (ID3v1/v2, MP4/M4A, FLAC, Ogg/Opus) with filename fallbacks, mojibake repair, and duplicate detection that heals metadata in place instead of skipping useful re-imports.
- **Full playback engine** — one shared audio element is the single timing authority. Queue with drag + keyboard reordering, shuffle (pinned current track), repeat off/all/one, play next, previous-within-3s restart, and session restore (queue + position survive reloads).
- **Lyrics** — multi-provider auto-discovery (lrcmux, LRCLIB, LyricsDB) plus manual `.lrc` / `.txt` import. Plain, line-synced, and word-by-word lyrics are distinguished by payload-verified capability; word highlighting is never fabricated from line-only data. Per-track offset control, candidate chooser for ambiguous matches, and an Apple Music–style renderer.
- **Honest availability states** — every track reports how it plays: file access retained (handle), stored in app (copy), re-import required (session-only), or cloud. Broken tracks get a dedicated triage page with restore/relink/re-import paths; permission loss is recoverable in one click, never silently downgraded.
- **Local-first persistence** — IndexedDB holds metadata, playlists, lyrics, settings, and optional audio copies. Metadata-only JSON backup/restore with full validation and atomic replace.
- **PWA** — installable; the service worker precaches the app shell only (never your audio), so the interface and your local library work fully offline.
- **Optional cloud** — private R2 audio + artwork storage, per-user Supabase metadata sync (idempotent, fingerprint-reconciled), local-to-cloud migration, and per-request signed URLs that are never persisted anywhere.

## Screenshots

> Placeholders — replace with genuine screenshots of the shipped app.

| | |
|---|---|
| ![Library view](docs/images/screenshot-library.png) | ![Now playing with lyrics](docs/images/screenshot-lyrics.png) |
| *Library* | *Now Playing with word-synced lyrics* |
| ![Broken tracks triage](docs/images/screenshot-broken.png) | ![Settings](docs/images/screenshot-settings.png) |
| *Broken tracks triage* | *Settings / storage* |

## Technology stack

| Layer | Technology |
|---|---|
| UI | React 19, React Router 7, Tailwind CSS 4 |
| State | Zustand 5 |
| Build | TypeScript 5.8 (strict), Vite 6 |
| Local persistence | IndexedDB (custom repository layer) |
| Audio | Single shared `HTMLAudioElement` engine (browser codecs) |
| Lyrics rendering | `@applemusic-like-lyrics/core` + custom GPU-scroll controller |
| Tests | Vitest, Testing Library, jsdom, fake-indexeddb, Miniflare (Worker) |
| Cloud (optional) | Supabase Auth + Postgres (RLS), Cloudflare R2, 3 Cloudflare Workers |
| Hosting | Vercel (frontend), Cloudflare Workers |

## Architecture overview

```
UI (features/pages, shared components)
  -> Zustand stores (playback, library, lyrics, settings, cloud, toasts)
    -> Domain services (audio engine, file access, import, lyrics,
       artwork, backup, offline, indexeddb repository, cloud)
      -> IndexedDB / File System Access / optional network clients
```

Playback never routes through React state for timing: one `HTMLAudioElement`, owned by `src/services/audio/engine.ts`, is the clock for progress, queue transitions, and lyric synchronization. Local-first source resolution order is **session file → stored copy → file handle → cloud**, so a local track never pays a network round trip.

Cloud requests only ever carry publishable configuration; all secrets live in Worker environment bindings. Signed URLs exist per-request in memory with short TTLs and are never stored in IndexedDB, Postgres, track records, or the service worker.

Full details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Installation

Requirements: Node.js 20+ and npm.

```bash
git clone https://github.com/SYTE001/Gmusic.git
cd Gmusic
npm install
```

## Local development

```bash
npm run dev        # Vite dev server (http://localhost:5173)
npm run build      # tsc -b && vite build && service-worker precache injection
npm run preview    # serve dist/ at http://localhost:4173
```

Quality checks:

```bash
npm run typecheck  # TypeScript, strict
npm run lint       # ESLint (typescript-eslint + react-hooks)
npm test           # Vitest unit/component suite
```

The three Cloudflare Workers are separate packages with their own test runs:

```bash
cd worker && npm install && npm run typecheck && npm test
cd lyrics-lrclib-worker && npm install && npm run typecheck && npm test
cd lyrics-lyricsdb-worker && npm install && npm run typecheck && npm test
```

More detail: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Environment variable setup

Copy `.env.example` to `.env.local` (or `.env`) and fill in the browser-safe values:

| Variable | Required | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL` | cloud only | Supabase project URL (browser-safe) |
| `VITE_SUPABASE_ANON_KEY` | cloud only | Supabase publishable key; RLS enforces access |
| `VITE_WORKER_URL` | cloud storage | Main Worker origin issuing signed URLs |
| `VITE_LRCLIB_WORKER_URL` | optional | LRCLIB proxy Worker (falls back to direct public API) |
| `VITE_LYRICSDB_WORKER_URL` | optional | LyricsDB proxy Worker (falls back to direct public API) |

Without any of these the app runs in pure local mode. Never put a service-role key, JWT secret, or R2 credential in any `VITE_*` variable — everything prefixed `VITE_` is compiled into the public bundle. Full reference including Worker secrets: [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md).

## Cloud setup

Cloud mode is additive and opt-in: with no configuration, no cloud UI appears and no cloud network calls are made. The pieces:

1. **Supabase** — Auth (Email) + Postgres metadata, RLS-isolated per user.
2. **Cloudflare R2** — private bucket holding audio/artwork objects, one object per track per user.
3. **Main Worker** (`worker/`) — verifies Supabase access tokens, issues short-lived signed R2 URLs, verifies upload completions, proxies MusicBrainz metadata.
4. **Lyrics proxy Workers** (`lyrics-lrclib-worker/`, `lyrics-lyricsdb-worker/`) — optional stateless CORS/caching proxies, no secrets.

### Supabase setup

1. Create a project (Supabase dashboard) and enable **Email** auth.
2. Copy the project URL and the **anon/publishable** key (Project Settings → API).
3. Apply the migrations in order: `supabase/migrations/0001_cloud_library.sql`, then `0002_track_description.sql` (SQL editor or `supabase db push`).
4. Optionally verify policies: `supabase test db` with `supabase/tests/rls_policies.test.sql` (pgTAP).

### Cloudflare R2 setup

1. Create a **private** R2 bucket (e.g. `local-music-media`).
2. Create an R2 API token with Object Read & Write; note account ID, access key ID, and secret.
3. Apply the browser-upload CORS configuration from `worker/cors.json` to the bucket (Cloudflare dashboard or API).

### Worker deployment

```bash
cd worker
npm install
wrangler login
wrangler secret put R2_ACCOUNT_ID
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
wrangler secret put SUPABASE_URL
# optional: SUPABASE_JWT_SECRET, SUPABASE_ANON_KEY, INTENT_SECRET — see docs/SECURITY.md
# edit [vars] in worker/wrangler.toml (ALLOWED_ORIGIN, TTLs, upload cap)
npm run deploy
```

Lyrics proxy Workers (no secrets required):

```bash
cd lyrics-lrclib-worker   && npm install && npm run deploy
cd lyrics-lyricsdb-worker && npm install && npm run deploy
```

Endpoint inventory and verification steps: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

### Vercel deployment

- Build command `npm run build`, output directory `dist`, framework preset Vite.
- Set the `VITE_*` environment variables in the project settings (only publishable values).
- `vercel.json` routes non-asset paths to `/index.html` so `BrowserRouter` deep links work on refresh.

## Testing

- **Frontend:** `npm test` — colocated `*.test.ts(x)` files cover stores, services, parsers, and key components (Vitest + Testing Library + fake-indexeddb).
- **Main Worker:** `cd worker && npm test` — Miniflare with in-memory R2 covers auth, key authorization, upload verification, and deletion paths.
- **Lyrics Workers:** `npm test` in each directory — proxy mapping, caching headers, and upstream failure handling.
- **Database:** pgTAP policy tests in `supabase/tests/` run via `supabase test db`.

## Privacy and security

- Your audio files, artwork, and library metadata never leave the device unless you explicitly enable a cloud operation. There is no analytics, no telemetry, and no tracking.
- Local search, playback, lyrics rendering, and backup/restore all work with the network disconnected.
- Online lyrics lookups send metadata only (title/artist/album/duration) — never audio.
- The frontend bundle contains only publishable configuration. Token signature verification, ownership checks, object-key authorization, and upload verification all happen in the Worker; RLS plus defensive triggers enforce per-user isolation in Postgres.
- Signed URLs are short-lived (default 120 s PUT / 300 s GET), constructed server-side, and never persisted.

Details and the current security findings list: [docs/SECURITY.md](docs/SECURITY.md).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Track shows **Re-import required** after reload | The file was imported without a persistent handle or stored copy. Re-import it, enable *Settings → Storage → Keep copies of audio in this app*, or relink via the track menu (*Locate file*). |
| Track shows **Grant access** | Chromium revoked the handle permission after a browser update/clear. Click the row's play button and re-grant in the browser prompt — this happens inside the click gesture by design. |
| Cloud track shows **offline — this song is in the cloud** | You are offline and the track has no local copy. Reconnect, or use *Keep a local copy* from the track menu while online. |
| Deep link 404s on production | Ensure `vercel.json` is deployed (SPA rewrite to `/index.html`). |
| Import summary lists "unsupported" | Your browser cannot decode that codec; the file was not silently added. Try a Chromium browser or convert the file. |
| Wrong lyrics attached | Use the track's *Choose lyrics* action to pick from ranked candidates, or import the correct `.lrc` manually — manual lyrics are never auto-replaced. |
| Storage quota errors | Check *Settings → Storage* for usage; stored copies can be removed per track; browsers may evict data under disk pressure — export a backup. |
| Worker returns 500 on upload | A required Worker secret is missing (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `SUPABASE_URL`, or `INTENT_SECRET`) — re-run `wrangler secret put`. |

## Limitations, honestly

- Persistent file access requires Chromium (File System Access API); Firefox/Safari users should enable stored copies.
- Codec support is the browser's, not the app's; every import is decode-probed with a real audio element.
- Metadata parsing is deliberately lightweight; unusual or corrupt tags fall back to filename-derived metadata.
- Word-level lyric highlighting requires genuine word-level timestamps in the source.
- Cloud storage lifecycle rules for orphaned objects are configured in the Cloudflare dashboard, not in this repository.

## Project structure

```
src/             application source
  app/           bootstrap, router, error boundary
  components/    shared shell, player, track list, overlays, icons
  features/      home, library, liked, playlists, recent, player, lyrics, broken, settings
  stores/        Zustand stores (playback, library, lyrics, settings, cloud, toasts)
  services/      audio engine · metadata parsers · IndexedDB repository ·
                 file access · lyrics providers · artwork · backup · offline · cloud
  types/         persisted entity types
supabase/        versioned SQL migrations + pgTAP RLS policy tests
worker/          main Cloudflare Worker (auth, R2 signing, upload verification)
lyrics-lrclib-worker/    LRCLIB CORS/cache proxy Worker
lyrics-lyricsdb-worker/  LyricsDB CORS/cache proxy Worker
public/          PWA manifest, service worker, icons
scripts/         service-worker precache injection, icon/test-media generators
docs/            architecture, deployment, environment, security, development guides
```

## License

MIT — see [LICENSE](LICENSE). This project is an independent implementation and is not affiliated with or endorsed by Tryliner or the Liner project; nothing from any reference product was used here, and forks should stay clearly separate from it.
