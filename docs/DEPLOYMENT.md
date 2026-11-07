# Deployment Guide

Gmusic deploys as one static frontend plus three Cloudflare Workers and one Supabase project. Each piece can be deployed independently; the app degrades gracefully when optional pieces are absent.

## 0. Prerequisites

- Node.js 20+, npm
- A Cloudflare account (Workers + R2)
- A Supabase project (cloud metadata + auth)
- A Vercel account (frontend hosting)

## 1. Supabase (metadata + auth)

1. Create a project in the [Supabase dashboard](https://supabase.com/dashboard).
2. **Authentication → Providers**: enable **Email**.
3. Apply the migrations in order (SQL editor or `supabase db push`):
   - `supabase/migrations/0001_cloud_library.sql` — tables `tracks`, `playlists`, `playlist_tracks`, `track_lyrics`, `track_playback`, all RLS-enabled with defensive ownership triggers.
   - `supabase/migrations/0002_track_description.sql` — adds `tracks.description`.
4. Project Settings → **API**: copy the **Project URL** and the **anon/publishable** key. These are the only Supabase values the browser ever sees. Never copy the service-role key into any frontend file.
5. Optional but recommended: run the pgTAP policy tests with `supabase test db` using `supabase/tests/rls_policies.test.sql` (35 assertions covering cross-user isolation and the URLs-never-persisted invariant).

## 2. Cloudflare R2 (private object storage)

1. Create a **private** bucket, e.g. `local-music-media`. Do not enable public access.
2. Create an R2 API token with **Object Read & Write** scope; note the **account ID**, **access key ID**, and **secret access key**.
3. Apply the browser-upload CORS configuration from `worker/cors.json` to the bucket (Cloudflare dashboard → R2 → bucket → Settings → CORS policy, or via the API). It allows `GET/PUT/HEAD` from your production origin and localhost dev origins.
4. Recommended: configure an object **lifecycle rule** on the bucket to expire orphaned uploads (objects uploaded but never completed/verified).

## 3. Main Worker (`worker/`) — signing, verification, MusicBrainz proxy

```bash
cd worker
npm install
npx wrangler login
```

Set required secrets (never in `wrangler.toml`):

```bash
npx wrangler secret put R2_ACCOUNT_ID
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put SUPABASE_URL
npx wrangler secret put INTENT_SECRET       # upload-intent signing (fail-closed)
# optional: SUPABASE_JWT_SECRET, SUPABASE_ANON_KEY, SUPABASE_JWKS_URL, SUPABASE_JWT_AUDIENCE
```

Edit `[vars]` in `worker/wrangler.toml`:

| Var | Default | Meaning |
|---|---|---|
| `ALLOWED_ORIGIN` | — | Your deployed frontend origin (e.g. `https://gmusic-tawny.vercel.app`) |
| `R2_BUCKET_NAME` | `local-music-media` | Bound bucket |
| `MAX_UPLOAD_BYTES` | `524288000` | 500 MB upload cap |
| `PUT_URL_TTL_SECONDS` | `120` | Presigned PUT lifetime (capped ≤ 3600) |
| `GET_URL_TTL_SECONDS` | `300` | Presigned GET lifetime (capped ≤ 3600) |

Deploy and verify:

```bash
npm run deploy
curl https://<your-worker>.workers.dev/api/health   # -> {"ok":true,...}
```

## 4. Lyrics proxy Workers (optional)

Both are stateless, secretless CORS/caching proxies. Deploy from their directories:

```bash
cd lyrics-lrclib-worker   && npm install && npm run deploy
cd lyrics-lyricsdb-worker && npm install && npm run deploy
```

Configure `ALLOWED_ORIGIN` in each `wrangler.toml` `[vars]` if you want to restrict origins (localhost dev origins and one production origin are allowed by default in code). Health checks: `GET /api/health` on each.

## 5. Frontend (Vercel)

1. Import the repository into Vercel. Framework preset: **Vite**.
   - Build command: `npm run build` (includes TypeScript compile and service-worker precache injection)
   - Output directory: `dist`
2. Set environment variables (Project Settings → Environment Variables):

   | Variable | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | Supabase project URL |
   | `VITE_SUPABASE_ANON_KEY` | Supabase publishable/anon key |
   | `VITE_WORKER_URL` | Main Worker origin |
   | `VITE_LRCLIB_WORKER_URL` | LRCLIB proxy Worker origin (optional) |
   | `VITE_LYRICSDB_WORKER_URL` | LyricsDB proxy Worker origin (optional) |

3. Deploy. `vercel.json` in the repository root routes non-asset paths to `/index.html` so `BrowserRouter` deep links (e.g. `/playlist/abc`, `/settings`) survive refresh. Without it, online deep-link loads 404 — keep this file deployed.
4. Point `ALLOWED_ORIGIN` on the Workers (steps 3–4) at the final Vercel URL and redeploy the Workers if it changed.

## 6. Post-deployment verification

1. Open the frontend → Settings → Cloud → sign in (or create an account).
2. Upload one track to the cloud from its track menu; confirm the file appears in the private R2 bucket under `users/<userId>/tracks/<trackId>/...`.
3. From a second browser/device, sign in and confirm the track syncs and plays (signed URL flow).
4. Delete the cloud track from one device; confirm the R2 objects are gone (deletion retries converge).
5. Build the app locally (`npm run build && npm run preview`), then go offline and reload — the shell and your local library must keep working.
6. Hard-refresh a deep link (e.g. `/library`) on production — it must render, not 404.

## Rollback

Each piece is versioned independently: Vercel keeps per-deployment instant rollback; Workers roll back with `npx wrangler rollback` or by redeploying a previous commit; Supabase migrations are additive (`create table if not exists`, `add column if not exists`) and are not reversed automatically.
