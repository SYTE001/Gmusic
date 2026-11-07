# Environment Variables Reference

There are three configuration scopes with a hard boundary between them:

1. **Frontend (Vite `VITE_*`)** — compiled into the public bundle. Publishable values only.
2. **Main Worker secrets / vars** — server-side only, set with `wrangler secret put` / `wrangler.toml [vars]`.
3. **Lyrics proxy Workers vars** — non-secret operational configuration.

## Frontend (`.env.local` or `.env`)

Copy `.env.example` as the template. All values are publishable by design:

| Variable | Required | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL` | cloud sync | Supabase project URL, e.g. `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | cloud sync | Supabase **anon/publishable** key (new-style `sb_publishable_…` or legacy anon JWT). Access is enforced by RLS, not by key secrecy. |
| `VITE_WORKER_URL` | cloud storage | Main Worker origin, e.g. `https://<worker>.<account>.workers.dev`. Gates R2 storage/migration separately from metadata sync. |
| `VITE_LRCLIB_WORKER_URL` | optional | LRCLIB proxy Worker origin. When unset, the client falls back to the public `lrclib.net` API directly where CORS permits. |
| `VITE_LYRICSDB_WORKER_URL` | optional | LyricsDB proxy Worker origin. Same fallback behavior. |

Rules:

- **Never** place a Supabase service-role key, JWT secret, R2 access key/secret, or any private credential in a `VITE_*` variable or any file under `src/`. Everything prefixed `VITE_` ships to every visitor.
- `.env`, `.env.local`, `.env.*.local` are git-ignored; only `.env.example` is committed.
- Changing frontend env values requires a rebuild (`npm run build`) — they are compile-time constants.

## Main Worker (`worker/`)

Secrets — set with `npx wrangler secret put NAME` (or a local `.dev.vars` file, git-ignored; see `worker/.dev.vars.example`):

| Secret | Required | Purpose |
|---|---|---|
| `R2_ACCOUNT_ID` | yes | Cloudflare account ID — used to build the S3-compatible R2 endpoint host |
| `R2_ACCESS_KEY_ID` | yes | R2 API token access key ID (S3 SigV4 presigning) |
| `R2_SECRET_ACCESS_KEY` | yes | R2 API token secret |
| `SUPABASE_URL` | yes | Supabase project URL; enables asymmetric JWT verification against the official JWKS |
| `SUPABASE_JWT_SECRET` | optional | Legacy Supabase JWT secret for HS256 local verification |
| `SUPABASE_ANON_KEY` | optional | Enables the Supabase auth-service verification fallback for legacy HS256 tokens |
| `INTENT_SECRET` | **required** | Dedicated HMAC key for upload-intent tokens. The Worker fails closed (500 `misconfigured`) without it — set this before deploying. |
| `SUPABASE_JWKS_URL` | optional | Override for the JWKS endpoint (defaults to the project's `/.well-known/jwks.json`) |
| `SUPABASE_JWT_AUDIENCE` | optional | Enforce an `aud` claim on access tokens |

Non-secret `[vars]` in `worker/wrangler.toml`:

| Var | Default | Purpose |
|---|---|---|
| `ALLOWED_ORIGIN` | — | Browser origin allowed by CORS. When unset, CORS defaults permissively — always set it in production. |
| `R2_BUCKET_NAME` | `local-music-media` | Bucket name (matches the `[[r2_buckets]]` binding) |
| `MAX_UPLOAD_BYTES` | `524288000` | Upload size cap (500 MB) |
| `PUT_URL_TTL_SECONDS` | `120` | Presigned PUT lifetime, capped at 3600 |
| `GET_URL_TTL_SECONDS` | `300` | Presigned GET lifetime, capped at 3600 |

## Lyrics proxy Workers

Neither Worker holds secrets. Each `wrangler.toml` `[vars]` section carries only:

| Var | Worker | Purpose |
|---|---|---|
| `ALLOWED_ORIGIN` | both | Browser origins allowed by CORS (comma-list supported; localhost is always allowed for development) |
| `LRCLIB_BASE_URL` | lyrics-lrclib-worker | Upstream API (default `https://lrclib.net/api`) |
| `LYRICSDB_BASE_URL` | lyrics-lyricsdb-worker | Upstream API (default `https://lyricsdb.kollod.dev/api`) |
| timeout / TTL vars | both | Upstream timeout and edge-cache TTLs (`/api/get` 24 h, `/api/search` 15 min, etc.) |

## Local development secrets (`worker/.dev.vars`)

For `npm run dev` inside `worker/`, copy `worker/.dev.vars.example` to `worker/.dev.vars` and fill in real values. `.dev.vars` is git-ignored in every Worker package. It must never be committed and must never contain placeholder comments implying real values are safe to commit.

## Rotation notes

- R2 credentials, `INTENT_SECRET`, and `SUPABASE_JWT_SECRET` have different rotation lifecycles; reusing one for another purpose couples their rotations (one reason `INTENT_SECRET` should be set explicitly).
- Rotating `INTENT_SECRET` invalidates in-flight upload intents only (they expire within minutes anyway).
- Rotating the Supabase JWT secret does not affect asymmetric (JWKS-verified) tokens.
