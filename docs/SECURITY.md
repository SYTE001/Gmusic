# Security Model & Findings

This document describes Gmusic's security architecture, the guarantees it makes, and the current audit findings with their remediation status. Last full audit: 2026-11-08 (static review + secret scan of the full git history).

## Threat model summary

| Asset | Where it lives | Protection |
|---|---|---|
| Local audio files | User's disk, never uploaded unless the user migrates a track | Never modified or deleted by the app; removal only drops the app's reference |
| Local library data | Browser IndexedDB | Browser profile isolation; persistent-storage request; exportable backup |
| Cloud audio/artwork | Private R2 bucket | Private bucket; Worker-only credentials; server-constructed user-scoped keys; short-lived signed URLs |
| Cloud metadata | Supabase Postgres | RLS on every table + defensive ownership triggers |
| Supabase session | Browser (Supabase JS) | Publishable anon key only; access tokens verified by signature server-side |
| Worker credentials | Cloudflare secrets | Never in code, `wrangler.toml`, frontend env, or version control |

## Frontend exposure rules

- Only `VITE_*` publishable values are compiled into the bundle (see [ENVIRONMENT.md](ENVIRONMENT.md)). The audit verified `.env.local` contains exactly the five publishable values and nothing else.
- The frontend never sees or computes: service-role keys, JWT secrets, R2 credentials, upload-intent HMAC keys, or object-key authorization decisions.
- Signed URLs are minted per request, held in a module-level in-memory map with a 30 s refresh margin, and cleared on sign-out. They are never written to IndexedDB, Postgres, track records, or the service worker (asserted by the pgTAP tests).

## Authentication & authorization (Worker)

- Access tokens are verified by **signature**, never by decoding: asymmetric algorithms (RS/ES/PS 256–512) verify against the Supabase JWKS with issuer pinning and algorithm pinning; HS256 verifies locally when `SUPABASE_JWT_SECRET` is configured; legacy tokens can fall back to Supabase's auth-service verification.
- Claims enforcement: `role: authenticated`, anonymous tokens rejected, `iat` mandatory and not in the future. Expired/invalid tokens fail closed with 401.
- The authenticated `sub` is the **only** user identity used. Object keys are constructed server-side as `users/{userId}/tracks/{trackId}/{audio|artwork}.{ext}` and re-parsed/authorized on every operation — a client-supplied key for another user returns 403.
- Uploads bind expected size and content-type into a signed intent token; `/complete` re-checks both against the stored object via HEAD and **deletes the object on mismatch**. The browser-supplied size is ignored in the intent path.

## Database isolation (Supabase)

- Every user-scoped table carries `user_id` with RLS for SELECT/INSERT/UPDATE/DELETE (`auth.uid() = user_id`).
- `playlist_tracks` uses composite foreign keys to `(id, user_id)` on both parents, so membership rows cannot cross users even through ID manipulation.
- A `BEFORE INSERT/UPDATE` trigger (`assert_owning_user`) re-asserts ownership independently of RLS and blocks `user_id` changes.
- pgTAP tests (`supabase/tests/rls_policies.test.sql`, 35 assertions) cover two-user isolation in both directions, cross-user write denials, ownership-trigger enforcement, upsert idempotency, and assert that no `play_url`/`upload_url` columns exist.

## Secret scanning

- The full git history (38 commits) was scanned for high-signal patterns (AWS keys, private key blocks, service-role markers and their base64 fragments, generic API-key/secret assignments). The only `service_role` occurrence is a test fixture constructing a synthetic token — no real secret was ever committed.
- `.env.local`, `.dev.vars`, and key/certificate patterns are git-ignored. Only `.env.example` and `worker/.dev.vars.example` (placeholders) are tracked.
- Re-scan before releases: `gitleaks detect --source .` (or `git log -p | grep -E "<patterns>"`).

## Current findings (2026-11-08 audit)

| # | Severity | Finding | Remediation |
|---|---|---|---|
| 1 | **Medium-High** (conditional) | ~~`worker/src/uploadIntent.ts` falls back through `INTENT_SECRET` → `R2_SECRET_ACCESS_KEY` → `SUPABASE_JWT_SECRET` → hard-coded `"local-music-upload-intent"` when no intent secret is set.~~ **Remediated (2026-11-08):** `getIntentSecret()` now fails closed with a `misconfigured` error when `INTENT_SECRET` is absent; the fallback chain and public constant are removed. | **Deploy requirement:** the next Worker deployment must have `INTENT_SECRET` set first (`npx wrangler secret put INTENT_SECRET`) or `/api/audio/upload-url` and `/api/audio/complete` will return 500 `misconfigured`. Until that secret is set on the live Worker, keep the currently deployed (pre-remediation) version running. |
| 2 | **Medium** | The main Worker's CORS `ALLOWED_ORIGIN` defaults to a permissive value when the var is unset. | Always set `ALLOWED_ORIGIN` in `wrangler.toml [vars]` (done in the current config; keep it pinned to the exact production origin). |
| 3 | **Low** | Lyrics proxy Workers are public, stateless, and have no rate limiting of their own (they pass through upstream 429s); their CORS allow-list hard-codes localhost and one production origin. | Acceptable for their purpose. If abuse becomes a concern, add Cloudflare WAF rate-limiting rules or lock `ALLOWED_ORIGIN` to the exact production origin. |
| 4 | **Low** | The MusicBrainz proxy is the only unauthenticated Worker surface; its 1 req/s limit is per-isolate, not global. | Acceptable: read-only, allow-listed entities, response-capped, cached. Add Cloudflare rate limiting if needed. |
| 5 | **Low** | `npm audit` reports vulnerabilities in build-chain dependencies (root: 8 moderate / 2 critical; worker: 7 high / 2 moderate / 2 critical, mostly `sharp`/libvips inherited via wrangler's toolchain). | Track in a dedicated dependency-audit pass. Do **not** run `npm audit fix --force` (breaking changes). None of the affected packages ship in the runtime bundle. |
| 6 | **Info** | pgTAP RLS tests require `supabase test db` and were not executed in the audit environment. | Run them once per Supabase project at setup (see [DEPLOYMENT.md](DEPLOYMENT.md)). |
| 7 | **Info** | Orphaned R2 objects (upload started, never completed) rely on bucket lifecycle rules. | Configure a lifecycle expiry rule on the bucket. |

## Deployment secrets checklist

- [ ] `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `SUPABASE_URL` set as Worker secrets
- [ ] `INTENT_SECRET` set (finding #1 mitigated)
- [ ] `ALLOWED_ORIGIN` pinned to the exact production origin on all three Workers
- [ ] No secret ever placed in a `VITE_*` variable, `wrangler.toml` `[vars]`, or any tracked file
- [ ] R2 bucket private; CORS applied from `worker/cors.json`; lifecycle rule configured
- [ ] `gitleaks detect --source .` run before each release
