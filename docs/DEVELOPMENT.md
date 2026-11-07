# Development Guide

How to set up, work in, and validate this repository. For system design see [ARCHITECTURE.md](ARCHITECTURE.md); for configuration see [ENVIRONMENT.md](ENVIRONMENT.md); for deployment see [DEPLOYMENT.md](DEPLOYMENT.md).

## Setup

```bash
npm install
npm run dev        # http://localhost:5173
```

The app runs in pure local mode with no configuration. To exercise cloud features locally, copy `.env.example` → `.env.local` and fill in publishable values (see [ENVIRONMENT.md](ENVIRONMENT.md)).

Worker development is separate:

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars   # fill in real local values; never commit
npm run dev                      # wrangler dev
```

## Commands

| Command | Scope | What it does |
|---|---|---|
| `npm run dev` | frontend | Vite dev server |
| `npm run build` | frontend | `tsc -b && vite build` + service-worker precache injection (`scripts/build-sw.mjs`) |
| `npm run preview` | frontend | Serves `dist/` at `http://localhost:4173` (service worker requires localhost/HTTPS) |
| `npm run typecheck` | frontend | Strict TypeScript, project references |
| `npm run lint` | frontend | ESLint over `src` and `scripts` (typescript-eslint + react-hooks) |
| `npm test` / `npm run test:watch` | frontend | Vitest (jsdom + fake-indexeddb) |
| `npm run typecheck` / `npm test` / `npm run build` | `worker/` | Worker TS / Miniflare tests (in-memory R2) / wrangler dry-run bundle |
| `npm run typecheck` / `npm test` | `lyrics-*-worker/` | Same pattern per proxy Worker |
| `npx wrangler deploy` | each Worker dir | Deploy that Worker |
| `supabase test db` + `supabase/tests/rls_policies.test.sql` | database | pgTAP RLS policy tests |

Root tests never pick up Worker files (`vite.config.ts` excludes `worker/**`); each Worker is its own validation scope with its own tsconfig and lockfile.

## Repository conventions

### Layer boundaries (enforced by review, described in AGENTS.md)

- **UI → store → service → repository/API.** Components orchestrate and present; they never touch IndexedDB, construct signed URLs, or own timers for playback/lyric timing.
- One shared audio engine (`src/services/audio/engine.ts`); the `HTMLAudioElement` clock is the only timing authority. Never create a second audio element, playback clock, or lyric timer.
- Zustand stores are the only global state owners. Don't mirror globally-owned values in local component state.
- External data (provider responses, backup files) is validated at the boundary, never trusted.
- TypeScript strict; no `any`; no broad lint suppressions.

### Data integrity invariants (non-negotiable)

- Original audio files are never modified or deleted by the app.
- Broken/permission/missing states are honest and recoverable; transient failures never permanently mark a track broken.
- Manual lyrics and synced lyrics are never silently downgraded or overwritten by lower-quality results; word timestamps are never fabricated.
- Backup restore is all-or-nothing (single transaction) and validated before any mutation.
- Signed URLs are never persisted anywhere (IndexedDB, Postgres, track records, service worker).

### Styling

- Semantic design tokens live in `src/styles/base.css` per theme (`:root`/`[data-theme]`); swap palettes there only, never in components. Tailwind 4 consumes them via `@theme inline`.
- Single primary breakpoint at 900 px (sidebar ↔ top bar + bottom tabs); Now Playing switches at 768 px via `matchMedia`.
- Animations respect `prefers-reduced-motion` and the `data-motion` override.

## Testing layout

- Tests are colocated: `src/**/*.test.ts(x)` next to the code they cover (Vitest + Testing Library + fake-indexeddb).
- Worker tests live in `worker/test/` (Miniflare with in-memory R2, `jose`-signed test tokens).
- Determinism rules for playback/lyric tests: fake timers for debounce/timeout paths; real promise ordering for async guards; no wall-clock sleeps.
- When changing a store action or persisted shape: search all call sites, update them in the same change, and update the colocated tests including hydration/persistence cases.

## Maintenance scripts (`scripts/`)

| Script | Purpose |
|---|---|
| `build-sw.mjs` | Part of `npm run build`; injects hashed asset list into `public/service-worker.js` with a build-hash cache name |
| `generate-icons.mjs` | One-off PNG icon generator for `public/icons/` (no dependencies; not wired into npm scripts) |
| `make-test-media.mjs` | Regenerates the synthetic WAV/LRC fixtures in `test-media/` |

## Local data & debugging

- All local data lives in the browser profile's IndexedDB database `local-music` (devtools → Application → IndexedDB). Deleting site data resets the library; export a backup first if it matters.
- Playback error classification is deterministic and testable (`src/services/errors/summarizePlaybackError.ts`); verbatim messages are preserved for the Broken page.
- Lyrics provider diagnostics: in-memory ring buffer (`src/services/lyrics/lyricsDiagnostics.ts`), logged to the console in dev only.

## Pre-push checklist

1. `npm run typecheck && npm run lint && npm test` (root)
2. `npm run build && npm run preview` — smoke test the production build, including an offline reload
3. If Worker code changed: `cd worker && npm run typecheck && npm test && npm run build` (same for touched lyrics workers)
4. If Supabase schema changed: migrations are additive and re-runnable; update `supabase/tests/`
5. Secret scan before release: `gitleaks detect --source .`
