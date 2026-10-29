# Local Music — Cloudflare R2 Worker

A separate Cloudflare Worker project that issues **short-lived, authenticated,
per-object presigned URLs** for private audio and artwork stored in a
Cloudflare R2 bucket. It is the only component with R2 S3 credentials.

The frontend never receives credentials, object-listing rights, or long-lived
URLs. It receives exactly one thing per request: a signed URL bound to a
server-constructed object key under the caller's own user prefix.

## Layout

```
worker/
├── src/
│   ├── index.ts      # router: /api/audio/{upload-url,complete,play-url,delete}, /api/health
│   ├── auth.ts       # Supabase access-token verification (HS256 signature or auth service)
│   ├── keys.ts       # server-side construction + authorization of object keys
│   ├── r2.ts         # presigning (AWS SDK v3) + direct object ops (R2 binding)
│   ├── env.ts        # bindings and secrets
│   └── errors.ts     # typed errors → HTTP status + actionable message
├── test/
│   ├── harness.ts    # Miniflare with an in-memory R2 bucket and a test JWT secret
│   ├── auth.test.ts
│   ├── keys.test.ts
│   └── r2Api.test.ts
├── wrangler.toml     # non-secret config; R2 bucket binding
└── .dev.vars.example # local secret template (never commit .dev.vars)
```

## Security model

- **Authentication is mandatory.** Every protected route calls `requireUser`,
  which verifies the `Authorization: Bearer <Supabase access token>` header.
  - **Asymmetric verification (default):** Supabase projects by default sign access
    tokens using asymmetric keys (RS256, ES256, etc.). The Worker verifies these
    tokens against the official Supabase JWKS endpoint (`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`)
    using `jose`, with JWKS caching and pinned algorithms.
  - **Legacy HS256 compatibility:** If using a legacy shared secret, configure
    `SUPABASE_JWT_SECRET` (for local HMAC verification pinned strictly to HS256)
    or `SUPABASE_ANON_KEY` (which verifies via Supabase Auth `GET /auth/v1/user`).
  - **Claims are validated:** Exactly 3 JWT segments are required; malformed tokens
    fail with 401; `exp`, `nbf`, `iat` (present and not in the future), `iss` against
    `${SUPABASE_URL}/auth/v1`, optional `aud` (`SUPABASE_JWT_AUDIENCE`), `role === "authenticated"`,
    and `is_anonymous !== true` (rejecting anon sessions and publishable anon keys).
    The `sub` claim of the verified token is the only user id the Worker ever uses.
- **Object keys are server-controlled.** The browser proposes `{trackId,
  fileName, mimeType, sizeBytes}`; the Worker derives
  `users/{userId}/tracks/{trackId}/audio.{ext}` (or `artwork.{ext}`) and
  validates every component against an allow-list. A client-supplied
  `objectKey` is ignored on upload and cross-user keys fail authorization
  with 403.
- **An issued URL proves nothing.** `/api/audio/complete` HEADs the object
  through the R2 binding and requires the stored size and content type to
  match the request before an upload may be marked complete. A client that
  never PUTs, or PUTs the wrong bytes, gets a 409/422 and no metadata.
- **Uploads are size- and type-limited.** `sizeBytes` must be a positive
  integer within `MAX_UPLOAD_BYTES`; the declared content type must be a real
  audio (or image, for artwork) **and** consistent with the file's extension —
  `text/html`, `application/octet-stream`, or a JPEG declared for `.mp3` are
  all 400. The same rule is re-applied at `/complete`, and a rejected upload
  has its unclaimed object cleaned up so R2 holds no object without metadata.
- **Upload intents cryptographically bind uploads.** When `/api/audio/upload-url`
  issues a presigned PUT URL, it signs an HMAC-SHA256 `uploadIntent` token containing
  `{ intentId, userId, trackId, objectKey, kind, expectedSize, expectedContentType, expiresAt }`.
  At `/api/audio/complete`, the Worker verifies the signature, expiration, and user ownership,
  and confirms that the stored R2 object strictly matches `expectedSize` and `expectedContentType`.
  Browser-supplied sizes in the completion body are ignored in favor of the server-signed intent.
  Any object failing verification (size mismatch, Content-Type mismatch, or missing metadata)
  is immediately deleted from R2, and completion is rejected with 422.
- **Residual exposure of presigned PUT:** S3-compatible presigned PUT URLs authorize direct
  browser-to-storage uploads. Cloudflare R2 does not enforce maximum content length at the
  network boundary before bytes are received for presigned PUT requests. Buffering entire
  audio files (up to hundreds of megabytes) in Worker memory would quickly exceed Worker memory limits.
  To mitigate this residual exposure:
  1. Presigned URLs and upload intents have short lifetimes (default 120 seconds).
  2. The server-controlled upload intent strictly validates size upon completion and deletes rejected objects.
  3. Strict origin checks and authenticated JWT verification prevent unauthorized upload requests.
- **Abandoned upload cleanup:** In the event that a client uploads bytes via a presigned PUT URL
  but never invokes `/api/audio/complete` (e.g., client crashes or closes browser):
  1. *Lifecycle rules:* Cloudflare R2 bucket lifecycle policies can be configured in the Cloudflare
     Dashboard to expire non-multipart uploads or purge unconfirmed objects under temporary prefixes.
  2. *Scheduled orphan cleanup:* A scheduled Cron trigger Worker can periodically scan R2 objects
     older than 24 hours, query the Supabase `tracks` table for corresponding `objectKey` and `artworkObjectKey`
     references, and safely delete unreferenced orphan objects.
- **Truthful and retryable R2 deletion:** `/api/audio/delete` accepts either `objectKey` or `trackId`.
  It paginates through all objects under `users/{userId}/tracks/{trackId}/`, verifies user ownership,
  attempts deletion of all matching objects, and verifies via a post-deletion list check that zero objects
  remain under the prefix. If any object remains or deletion fails, it returns 502 server-error so
  the client's IndexedDB pending-deletion queue preserves the entry for retry. Retries are idempotent.
- **Credentials live only in Worker secrets.** `R2_ACCOUNT_ID`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `SUPABASE_JWT_SECRET` are set
  with `wrangler secret put`. They are never present in the repository, the
  frontend, or a `VITE_*` variable. Direct object operations (HEAD, delete,
  list) use the R2 **bucket binding**, which needs no credentials at all.
- **The bucket stays private.** Do not enable public access or public bucket
  listings. Playback happens through presigned GET URLs with a short lifetime
  (`GET_URL_TTL_SECONDS`, default 300 s).

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/audio/upload-url` | authenticate, validate, build the key, return a presigned PUT URL |
| `POST` | `/api/audio/complete` | verify the object exists and its size/metadata match |
| `POST` | `/api/audio/play-url` | verify ownership and existence, return a presigned GET URL |
| `POST` | `/api/audio/delete` | authorize and remove the object plus its track siblings |
| `GET` | `/api/health` | unauthenticated smoke check |

All error responses are JSON: `{ "error": { "code": string, "message": string } }`
with a meaningful status (400 validation, 401 auth, 403 cross-user, 404 missing,
409 unverified upload, 422 verification mismatch, 5xx server).

## Development

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars   # fill in local placeholders
npm run dev                      # local dev server with live reload
npm test                         # builds the worker, then runs Miniflare tests
npm run typecheck                # tsc --noEmit
```

Tests run the wrangler-built bundle inside Miniflare with an in-memory R2
bucket, so auth, key construction, verification, and cross-user denial are
exercised end to end without any real cloud credentials.

## Deployment

```bash
cd worker
npx wrangler login
npx wrangler secret put R2_ACCOUNT_ID
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put SUPABASE_URL
# Only required if using legacy HS256 tokens:
# npx wrangler secret put SUPABASE_JWT_SECRET
npm run deploy
```

Then point the frontend at the deployed origin with `VITE_WORKER_URL`.
