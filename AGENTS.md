# AGENTS.md — Gmusic Repository Operating Guide

> **Purpose:** This is the first-read operating manual for every coding agent working in this repository. It provides stable product context, architecture boundaries, file-routing guidance, and task procedures so an agent can understand a prompt without scanning the entire repository.
>
> **Read this file at the beginning of every task.** After that, inspect only the files selected by the task-routing rules below. Do not treat this document as a substitute for inspecting the specific implementation you are about to change.

---

## 1. Mandatory Instruction Order

Apply instructions in this order:

1. The user's explicit instructions in the current prompt.
2. Relevant acceptance criteria and scope in `prd.md`.
3. The repository engineering and product constraints in `rules.md`.
4. This file's architecture map and workflow.
5. Existing implementation patterns in the smallest relevant code area.

When instructions conflict, preserve data integrity, playback correctness, local-first behavior, privacy, and existing working behavior unless the user explicitly authorizes a change.

Do not invent product requirements. A screenshot or short prompt may identify the desired result, but it does not authorize unrelated redesigns or architecture rewrites.

## 2. Project Identity and Product Model

Gmusic is an **offline-first personal music player for the web**. It imports and plays audio files selected by the user, manages a local music library, playlists and liked tracks, supports timed or plain lyrics, and provides an optional cloud layer.

It is not a music streaming service and must not behave like one.

### Core product principles

- Local-first: the app must remain useful without signing in, configuring cloud services, or maintaining a network connection after the app shell is available.
- Privacy-first: local audio, artwork, lyrics and personal library data stay on-device unless the user explicitly enables an applicable cloud operation.
- Honest state: never claim a file is permanently available, uploaded, synced, cached, or playable unless the implementation has verified that state.
- One playback engine: one shared audio element/service is the source of truth for playback time and lyric synchronization.
- Recoverability: missing files, permission loss, invalid metadata, unsupported codecs, quota failures and network errors must be visible and recoverable.
- Incremental engineering: preserve working flows and modify only the smallest responsible modules.

### Existing technology baseline

Use the versions and scripts in the current root `package.json` as the authority. The repository currently uses:

- React 19, TypeScript 5.8, Vite 6 and Tailwind CSS 4.
- React Router 7 for route handling and Zustand 5 for application state.
- IndexedDB for durable local library and settings data.
- Vitest, Testing Library and jsdom for frontend tests.
- Optional Supabase Auth/Postgres for cloud metadata and Cloudflare R2 for private cloud objects.
- A separate Cloudflare Worker under `worker/` for authenticated operations and signed object URLs.
- A PWA service worker that caches the application shell, not the user's audio library.

Do not migrate frameworks, replace the state library, change package managers, or introduce a second architecture without explicit user direction and a documented reason.

## 3. First-Read Protocol: Do Not Scan the Whole Repository

Every task starts with this file. Then follow the exact routing protocol:

1. Classify the prompt into one or more task domains in Section 5.
2. Read the **entry/owner file** listed for that domain.
3. Read only the directly imported modules or store/service contracts needed to understand the behavior being changed.
4. Read the corresponding test file(s), if present. If no test exists, identify the nearest relevant test pattern.
5. Read `prd.md` only for the matching feature/acceptance criteria, and `rules.md` only for the relevant engineering constraints. Do not reread either file in full if the relevant section is already known in the current context.
6. Search for a symbol or behavior only when its owner is unclear. Prefer targeted search over opening every file in a directory.
7. Stop exploring as soon as the data flow, state owner, side effects and test surface are understood.

### Exploration budget

Use these as default limits, not rigid restrictions:

- Simple visual adjustment: 1–3 implementation files plus 1 test or style/token reference.
- Single interaction/bug: 2–5 implementation files plus relevant tests.
- Feature spanning UI, store and service: inspect the owner in each layer and their tests, normally 4–8 files before implementation.
- Cross-cutting architecture, migration or security work: expand the scope deliberately and explain why broader inspection is necessary.

Do not open all files "just in case". Expand the scope only when an import, type contract, test failure or data flow proves another file is relevant.

### Targeted search examples

Use the tool available in the current IDE/agent environment. Examples:

- Search for a component or hook name before reading unrelated components.
- Search for a store action to identify every caller before changing its contract.
- Search for a CSS class/token before changing global styling.
- Search for a route path before editing navigation behavior.
- Search for an IndexedDB object store or schema version before modifying persistence.

Do not assume a file path exists. Confirm it from the repository tree or search results.

## 4. Stable Architecture and Ownership Boundaries

The following boundaries describe the intended architecture. Confirm exact exports and current implementations in the relevant files before changing them.

### 4.1 Application bootstrap and routing

- `src/app/App.tsx`: application initialization, global store/service startup, service-worker registration and lifecycle listeners.
- `src/app/router.tsx`: route declarations, route-level lazy loading and route fallback behavior.
- `src/components/AppShell.tsx`: persistent application frame and shared shell composition.

Keep global initialization out of individual page components. Do not create a second playback engine or reinitialize global services on route navigation. Route changes must not reset playback.

### 4.2 Shared components

- `src/components/`: reusable UI elements shared by pages, including shell, sidebar, top bar, track rows, track lists, mini-player, queue, artwork, dialogs, menus, seek bar and notifications.
- `src/components/Icons.tsx`: shared icon definitions/components. Reuse existing icon conventions rather than adding arbitrary icon packages or inline icon variants.
- `src/components/TrackRow.tsx`, `TrackListSection.tsx`, `VirtualList.tsx`: track-list presentation and row/list behavior.
- `src/components/MiniPlayer.tsx`, `QueuePanel.tsx`, `SeekBar.tsx`: playback-related shared UI. These components must call existing store/service actions; they must not own a separate audio engine.
- `src/components/Menu.tsx`, `Modal.tsx`, `ConfirmDialog.tsx`: shared overlays and action surfaces. Preserve layering, focus, dismissal and keyboard behavior.
- `src/components/DynamicIslandNotification.tsx`: transient notification presentation. Notification lifecycle/state has a dedicated store; inspect it before changing notification behavior.

A shared component change has a larger regression surface than a page-local change. Check all meaningful usages before changing its props or interaction contract.

### 4.3 Feature pages

Feature-specific page UI belongs under `src/features/`:

- `home/`: home overview and recently relevant library content.
- `library/`: full library listing, import flow and track-level actions.
- `liked/`: liked/saved tracks.
- `playlists/`: playlist listing, detail, creation and membership changes.
- `recent/`: recently played content.
- `player/`: full now-playing experience and queue/playing context UI.
- `lyrics/`: lyrics presentation, active-line behavior, match selection and lyric-specific visual effects.
- `broken/`: unavailable or unplayable tracks and their recovery/removal flow.
- `settings/`: settings, storage, backup, offline and optional cloud configuration.

A page should orchestrate feature UI and call the correct store/service boundary. Do not put database logic, signed URL construction, audio lifecycle management or complex parsing directly into JSX.

### 4.4 State management

Zustand stores are under `src/stores/`. Current store domains include:

- `playbackStore.ts`: playback state and actions; coordinates with the shared audio engine.
- `libraryStore.ts`: library state, initialization, library-level actions and persistence orchestration.
- `lyricsStore.ts`: lyrics state, lookup/prefetch and lyric lifecycle.
- `settingsStore.ts`: user preferences and initialization.
- `cloudStore.ts`: optional cloud session/sync state.
- `toastStore.ts`: transient toast/notification state.
- `dynamicIslandStore.ts`: state for the Dynamic Island-style notification presentation.

Before adding state, identify the current source of truth. Do not duplicate a value in local component state when it is already globally owned, unless it is genuinely transient presentation state.

When changing a store action or state shape:
1. Search all call sites.
2. Preserve compatibility or update all call sites in the same change.
3. Update the relevant store tests.
4. Ensure persistence and hydration behavior remain correct.
5. Avoid making high-frequency playback time updates rerender unrelated screens.

### 4.5 Services and data boundaries

Services live under `src/services/`. Keep side effects and domain logic in the appropriate service rather than UI components.

| Service area | Responsibility |
|---|---|
| `audio/` | Single shared HTML audio engine, playback events and source lifecycle |
| `indexeddb/` | Local database, schema, repository and durable local records |
| `file-access/` | Browser file handles, file permissions, relinking and local/cloud resolution |
| `library/` | Import orchestration and playback-session/library workflows |
| `metadata/` | Parsing and normalization of supported audio metadata |
| `lyrics/` | LRC/TXT parsing, matching, discovery clients, capabilities and synchronization logic |
| `artwork/` | Artwork discovery, remote metadata clients and artwork selection |
| `backup/` | Backup serialization, validation, export and restore |
| `offline/` | PWA/service-worker registration and offline-related behavior |
| `cloud/` | Optional authentication, cloud library sync, migration and R2 operations |

Rules:
- UI calls stores; stores coordinate state and services; services implement domain side effects.
- IndexedDB access stays behind the repository/service layer.
- Network clients stay in service modules, never inside presentational components.
- Do not bypass repository abstractions with ad hoc IndexedDB reads/writes.
- Validate untrusted external responses and imported backup data at boundaries.
- Keep local behavior functional when cloud configuration is absent.

### 4.6 Types

- `src/types/index.ts`: shared application/persisted entity types.
- `src/types/fs-access.d.ts`: browser File System Access API typing support.

Change shared types only when the domain model genuinely changes. Persisted shape changes require compatibility analysis and safe migration planning.

### 4.7 Cloud Worker and database

- `worker/src/`: separate Cloudflare Worker implementation.
- `worker/test/`: Worker-specific tests and harness.
- `worker/wrangler.toml`: Worker deployment/configuration bindings.
- `supabase/migrations/`: versioned database changes.
- `supabase/tests/`: database policy tests.

The Worker is a separate package and runtime. Do not assume root frontend scripts validate Worker code. Do not move secrets into frontend variables, and do not let cloud failures damage local data.

## 5. Prompt-to-File Routing Matrix

Use this matrix to select the smallest relevant context set. Paths below are starting points; inspect imports and tests only as needed.

### A. Visual polish, layout, alignment, spacing, typography, responsive behavior

Start with:
- The exact page/component visible in the prompt or screenshot.
- Its adjacent CSS/Tailwind usage and shared design tokens.
- The relevant component/page test, if visual behavior is tested.

Common owners:
- Global frame/sidebar/header: `src/components/AppShell.tsx`, `Sidebar.tsx`, `TopBar.tsx`.
- Track row/list alignment: `TrackRow.tsx`, `TrackListSection.tsx`, and the specific page rendering them.
- Mini-player/queue: `MiniPlayer.tsx`, `QueuePanel.tsx`.
- Now playing: `src/features/player/NowPlayingPage.tsx`.
- Lyrics screen: `src/features/lyrics/LyricsView.tsx`, then `AmllLyricPlayer.tsx` or `LyricLineItem.tsx` only if the issue is inside the lyric renderer.
- Notifications: `DynamicIslandNotification.tsx` and its store.

Do not inspect service modules for a pure layout correction unless component data/state is demonstrably causing the layout issue.

Visual-task constraints:
- Preserve existing product structure and real functionality.
- Fix the actual layout cause: grid/flex constraints, min-width, alignment, overflow, stacking context, responsive breakpoints or text wrapping.
- Avoid one-off pixel nudges when the parent layout is wrong.
- Check light and dark themes if the element supports both.
- Check narrow layout (minimum 360px) and keyboard/focus behavior where applicable.
- Do not redesign unrelated areas.

### B. Track list, playlist list, track menu, overflow actions

Start with:
- `src/components/TrackRow.tsx`
- `src/components/TrackListSection.tsx`
- `src/components/Menu.tsx`
- The relevant page (`LibraryPage.tsx`, `LikedPage.tsx`, `PlaylistDetailPage.tsx`, `RecentPage.tsx` or `BrokenPage.tsx`)
- `src/features/library/useTrackActions.tsx` when the action behavior is involved.

Inspect the library store/service only if the action changes data or playback behavior. For menus being clipped or overlapped, inspect the nearest stacking/overflow ancestors before changing z-index.

### C. Playback, seek bar, volume, queue, shuffle, repeat, track switching

Start with:
- `src/stores/playbackStore.ts`
- `src/services/audio/engine.ts`
- `src/features/player/queue.ts` when queue ordering or transitions are involved.
- Relevant tests: `src/services/audio/engine.test.ts`, `src/stores/playbackStore.test.ts`, `src/features/player/queue.test.ts`.

Then inspect only the UI owner involved:
- `MiniPlayer.tsx`, `SeekBar.tsx`, `QueuePanel.tsx`, or `NowPlayingPage.tsx`.

Never create a second audio object, independent playback clock, or page-specific playback controller. The audio element's clock is authoritative. Guard against fast track switching, stale async resolutions, missing sources and browser autoplay restrictions.

### D. Importing audio, metadata, duplicate detection, unavailable files

Start with:
- `src/features/library/ImportMusic.tsx`
- `src/services/library/importService.ts`
- `src/services/metadata/index.ts` and only the relevant format parser.
- `src/services/file-access/FileAccessService.ts`
- `src/services/indexeddb/LibraryRepository.ts` only if persistence is involved.
- Relevant import/metadata/file-access tests.

Do not read every metadata parser when the bug is specific to one format. Preserve original files; app removal is not source-file deletion.

### E. Lyrics display, sync, offsets, parsing, auto-discovery, matching

Start with the smallest applicable path:
- Visual layout/scrolling: `src/features/lyrics/LyricsView.tsx`, `LyricLineItem.tsx`, `AmllLyricPlayer.tsx`.
- Parsed LRC/TXT: `src/services/lyrics/lyricsfile.ts`.
- Active line/word timing: `src/services/lyrics/syncEngine.ts`, `capability.ts`.
- Candidate matching: `matching.ts`, then its tests.
- Discovery/provider issue: `lyricsService.ts` plus the specific client (`lrclibClient.ts` or `lrcmuxClient.ts`).
- Lyrics state/prefetch: `src/stores/lyricsStore.ts`.
- Track-specific selection UI: `MatchPickerDialog.tsx`.

Always use real audio time. Preserve source capability distinctions: plain text, line-synced and word-synced are not interchangeable. Never fabricate word timestamps from line timestamps. Inspect the relevant test file before changing timestamp/matching logic.

### F. Album artwork, cover lookup, broken artwork, image loading

Start with:
- `src/components/Artwork.tsx` or `ArtworkCard.tsx` for presentation/loading/fallback.
- `src/services/artwork/artworkService.ts` for selection/orchestration.
- Only the relevant client: `itunesClient.ts`, `musicbrainzClient.ts`, or `coverArtClient.ts`.
- Corresponding tests for the selected client/service.

Do not change every provider for a bug isolated to image rendering. Preserve offline fallback behavior and avoid layout shifts.

### G. Broken tracks, play errors, recovery and notifications

Start with:
- `src/features/broken/BrokenPage.tsx`
- `src/features/playback/playbackErrors.test.ts` (or the relevant error source/test).
- `src/stores/playbackStore.ts`
- `src/stores/toastStore.ts` and/or `dynamicIslandStore.ts` when notification behavior is involved.
- `src/components/DynamicIslandNotification.tsx` for notification UI.

Inspect file-access or cloud resolution only when error classification/recovery depends on source availability. Keep the notification transient and the broken-track record recoverable; never mark a track broken solely because of a temporary UI/render failure.

### H. Playlists, liked songs, recent history

Start with the corresponding page:
- `src/features/playlists/PlaylistsPage.tsx`
- `src/features/playlists/PlaylistDetailPage.tsx`
- `src/features/liked/LikedPage.tsx`
- `src/features/recent/RecentPage.tsx`

Then inspect:
- `src/stores/libraryStore.ts`
- `src/services/indexeddb/LibraryRepository.ts`
- `src/types/index.ts`
- Relevant tests.

Preserve stable IDs, ordering, referential integrity and track records when playlists are deleted. Do not duplicate liked/playlist state in independent stores without a clear existing contract.

### I. Settings, appearance, storage, keyboard shortcuts, backup

Start with:
- `src/features/settings/SettingsPage.tsx`
- `src/stores/settingsStore.ts`
- Only the relevant service: `backup/`, `offline/`, `indexeddb/` or `file-access/`.
- Matching tests.

Do not inspect cloud code for a local appearance preference. Do not modify persistence schema for a preference that can be stored by the existing settings mechanism.

### J. Cloud login, sync, R2, signed URLs, migration

Start with:
- `src/features/settings/CloudAccountSection.tsx` or `CloudMigrationSection.tsx` for UI.
- `src/stores/cloudStore.ts`.
- The narrow service: `cloudAuthService.ts`, `cloudLibraryService.ts`, `migrationService.ts` or `r2StorageService.ts`.
- Relevant cloud tests.
- Then inspect the exact Worker endpoint under `worker/src/` and its test only if the request crosses the backend boundary.
- Inspect the relevant SQL migration/RLS test only for database schema/policy changes.

Security requirements:
- Never trust a browser-supplied user ID.
- Never decode-and-trust a JWT; verify signature and claims on the trusted side.
- Keep service-role keys, JWT secrets and R2 credentials in Worker secrets only.
- Keep the R2 bucket private and object keys user-scoped.
- Signed URLs are short-lived and must not be persisted in IndexedDB, Postgres, Track records or service-worker cache.
- Verify object existence/size/metadata before confirming upload success.
- Sync must be idempotent.
- A cloud failure must not delete or corrupt local data.

### K. Offline, PWA, service worker and caching

Start with:
- `src/services/offline/offlineService.ts`
- `public/service-worker.js`
- `scripts/build-sw.mjs`
- `public/manifest.webmanifest` only for manifest/install behavior.
- Relevant tests or build scripts.

The service worker caches the app shell by design. Do not silently add arbitrary audio, private signed URLs or user data to Cache Storage. Verify behavior with a production build and an offline browser session.

### L. Routing, initial load, app lifecycle

Start with:
- `src/app/App.tsx`
- `src/app/router.tsx`
- `src/components/AppShell.tsx`
- `src/app/router.test.tsx`

Avoid duplicate initialization, route-induced playback resets and leaking listeners/timers. Confirm React StrictMode-safe setup/cleanup symmetry.

### M. Type errors, lint, build, dependency or configuration

Start with:
- The exact error output and file/line.
- `package.json`, relevant TypeScript/eslint/Vite config, and the failing module.
- Root tests/scripts only as required.
- For Worker errors, use `worker/package.json`, `worker/tsconfig.json`, `worker/vitest.config.ts` and the exact failing Worker file.

Do not upgrade dependencies to fix an unrelated type error. Do not edit lockfiles manually. Root and Worker are separate validation scopes.

### N. Database schema or RLS policy

Start with:
- Exact SQL migration in `supabase/migrations/`.
- Relevant table/entity types and service code.
- Matching policy tests in `supabase/tests/`.

Make schema changes additive and re-runnable where feasible. Every user-scoped table must have explicit ownership/RLS protections. Never weaken RLS to make a test or UI flow pass.

## 6. Data Flow: Use the Existing Owner

Use this mental model before changing behavior:

```
User interaction
  -> Feature page / shared component
    -> Zustand store action
      -> Domain service
        -> IndexedDB repository / browser API / optional network client
      <- result and validated state
    <- UI update
```

For playback:

```
UI control
  -> playbackStore action
    -> single audio engine / HTMLAudioElement
      -> real media events and currentTime
        -> playbackStore synchronization
          -> mini-player, now-playing and lyrics UI
```

For lyrics:

```
Audio engine currentTime
  -> lyrics store / sync selector
    -> parsed timestamp timeline + per-track offset
      -> active line/word state
        -> lyric presentation
```

For cloud storage:

```
Frontend (publishable config only)
  -> Supabase Auth / Worker request
    -> Worker verifies token and ownership
      -> private R2 operation / Supabase metadata
  <- verified outcome
  -> cloud store update
```

If the change appears to require bypassing one of these owners, first explain why the current owner cannot support it. Do not introduce parallel state or side-effect paths casually.

## 7. Product and Design Direction

Gmusic should feel like a polished personal music product, not a generic admin dashboard.

### Visual language

- Minimal, precise, typography-led, calm and music-focused.
- Strong hierarchy and alignment; consistent row heights, spacing, control sizes and baselines.
- Solid, well-defined surfaces and restrained borders. Avoid muddy/translucent borders and glass-like surfaces.
- No random purple AI gradients, neon glows, excessive glassmorphism, decorative glow layers or gratuitous motion.
- Album artwork can influence ambience only when it does not compromise text/control contrast.
- Preserve the established dark and light themes wherever the relevant screen supports both.
- Animations should communicate state or improve continuity, not decorate empty space.
- Respect `prefers-reduced-motion`.
- Every control must be functional, keyboard accessible and correctly labeled.
- Avoid visual changes outside the scope of the user's prompt.

When the user provides screenshots:
1. Identify the exact region and visible defect.
2. Determine whether the problem belongs to the child, parent layout, overflow ancestor or stacking context.
3. Inspect the component and its immediate layout parent.
4. Correct the underlying constraint instead of applying arbitrary offsets.
5. Verify adjacent content is not clipped, overlapped or misaligned.
6. Check relevant themes and responsive width.

### Interaction quality

- Menus and dialogs must render above the correct surfaces and must not be clipped by unintended overflow containers.
- Destructive actions require confirmation.
- Close menus/dialogs with Escape when appropriate.
- Preserve input when a recoverable operation fails.
- Show loading, empty, success and error states where the operation requires them.
- Show success only after the operation is confirmed successful.
- Icon-only controls need accessible labels and suitable title/tooltip behavior.
- Keyboard shortcuts must not hijack text entry or editable controls.

## 8. Data Integrity, Playback and Lyrics Invariants

These are non-negotiable. Read the detailed rules in `rules.md` when modifying their implementation.

### Local library and files

- Never alter or delete the user's original audio files.
- Removing a track means removing the app's library reference, not deleting the source file.
- Preserve metadata when the file becomes unavailable.
- Distinguish retained file handle, stored local copy and session-only/re-import-required states.
- Handle permission revocation and storage quota failures.
- Do not persist machine-specific absolute paths or file handles in portable backups.
- Validate a backup completely before replacing current data.
- Use stable IDs, not array indexes, for track/playlist identity.

### Playback

- Exactly one shared audio engine/audio element.
- The HTML audio element's clock is authoritative.
- Do not create independent timers for playback or lyric timing.
- Guard against stale asynchronous file/source resolution when switching quickly.
- Queue/shuffle/repeat transitions must be deterministic and tested.
- Never fabricate duration, progress or playing state.
- Handle browser autoplay restrictions and unavailable/unsupported audio honestly.
- Persist playback position at sensible intervals and lifecycle transitions, not every animation frame.

### Lyrics

- Parse timed entries into integer milliseconds.
- Keep per-track offset separate from original lyric content.
- Sort timestamps stably; handle duplicate, malformed and negative-effective timestamps safely.
- Plain text is not synchronized.
- Word-level highlighting is permitted only when actual word timestamps exist.
- Clicking a timed line must seek the shared playback engine.
- Auto-scroll should follow meaningful active-line changes, not cause wasteful per-frame layout work.
- Lyrics render and scroll through a single `translate3d` container owned by `AmllLyricPlayer.tsx`; line DOM is built directly there (not via AMLL internal virtualization, which left lines empty when its size was `[0, 0]`).
- The Stage 2 background is a single solid album-adaptive color from `src/features/lyrics/palette/` via `useAdaptiveLyricsPalette.ts`, exposing `--bg`, `--lyric-active`, `--lyric-inactive`, `--accent` with enforced contrast. No animated, gradient or blur backgrounds.
- Provider results must be validated and ranked; ambiguous matches must not silently attach to the wrong track.

### Cloud

- Cloud mode is additive and opt-in.
- Local behavior remains fully useful without cloud configuration or authentication.
- Cloud sync is idempotent and must not overwrite or destroy valid local data on failure.
- Only publishable configuration reaches the browser.
- Private credentials remain Worker secrets.
- Signed URLs are ephemeral and must never be persisted.

## 9. Code Change Standards

- Keep changes small and cohesive. Avoid unrelated refactors.
- Reuse existing tokens, components, store actions and service interfaces.
- Prefer explicit TypeScript types; avoid `any`.
- Validate external data at boundaries.
- Do not silence type/lint failures with broad suppressions.
- Do not swallow exceptions or replace useful error reporting with silent fallbacks.
- Avoid duplicated business logic and placeholder handlers.
- Avoid adding dependencies when a small tested native solution is enough.
- Keep components focused on presentation/orchestration.
- Clean up subscriptions, event listeners, timers, animation frames and object URLs.
- Do not edit generated bundles, `dist/`, minified output or dependency artifacts by hand.
- Do not change unrelated lockfile entries.
- Follow existing naming, formatting and import conventions.

## 10. Testing and Validation

Add or update tests alongside the code change. Test the behavior at the narrowest useful level first.

### Root commands

Use the scripts currently defined in `package.json`. The known baseline commands are:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

### Worker commands

Run separately when `worker/` code changes:

```bash
cd worker
npm run typecheck
npm test
npm run build
```

Use the actual scripts in `worker/package.json`; do not assume root commands validate Worker code.

### Validation scope

- Pure visual change: typecheck/lint, relevant component tests, build where practical; inspect responsive and theme states in a browser when available.
- Store/service logic: relevant unit tests plus typecheck/lint.
- Persistence/import/backup: migration and failure-path tests, including compatibility with existing local data.
- Playback/lyrics: deterministic boundary/race tests and real-browser smoke test when available.
- Cloud/Worker/RLS: frontend and Worker tests plus security/ownership failure paths.
- PWA/offline: production build and offline smoke test.

At the end, state exactly which commands were run and their result. Never claim a test, browser check or build passed if it was not executed. Report pre-existing failures separately from regressions introduced by the change.

## 11. Standard Task Workflow

Use this workflow for every prompt.

### Phase 1 — Understand

- Read this `AGENTS.md`.
- Restate the requested outcome internally in one sentence.
- Identify task domain(s) using Section 5.
- Extract explicit constraints, affected visual/behavioral states and non-goals.
- Resolve ambiguities from existing behavior and the relevant PRD section. Ask only when a decision would cause destructive or materially different outcomes; otherwise make the smallest safe assumption and state it.

### Phase 2 — Focused inspection

- Open only the domain owner files, immediate dependencies, types and relevant tests.
- Trace the current behavior from UI to store/service and back.
- Identify the actual root cause before editing.
- Check git diff/status first when the environment supports it. Preserve user changes; never overwrite unrelated working-tree changes.

### Phase 3 — Plan

Before editing, create a short implementation plan:
- intended behavior,
- likely files to change,
- state/data impact,
- regression risks,
- validation to run.

For a trivial one-line fix, this plan can be one sentence.

### Phase 4 — Implement

- Make the smallest complete change.
- Preserve existing contracts or update all dependent call sites.
- Add/update tests for the changed behavior.
- Do not broaden scope without evidence.
- Do not introduce mock production data or fake success states.

### Phase 5 — Verify

- Run the narrow relevant test first.
- Run the appropriate typecheck/lint/build commands based on scope.
- Inspect the final diff for unrelated edits, accidental data loss, security leaks and incomplete states.
- For UI tasks, inspect the actual rendered result when browser tools are available; code inspection alone does not prove visual correctness.

### Phase 6 — Report

Provide a compact completion report:
- What changed and why.
- Files/modules changed.
- Tests and commands run, with pass/fail status.
- Any remaining limitation or unverified behavior.
- Do not include claims unsupported by executed checks.

## 12. When to Expand Repository Inspection

Expand beyond the initial task route only if one of these is true:

- The owner file imports a module whose contract determines the requested behavior.
- A type or state change has other call sites.
- A failing test points to another layer.
- The same UI is reused by multiple routes and the shared behavior is in scope.
- Persistence schema or public API compatibility is affected.
- Security, privacy, data-loss or cross-user isolation is involved.
- The visible symptom is caused by an ancestor or downstream side effect.
- A bug cannot be reproduced or explained with the initial file set.

When expanding, name the reason and inspect only the additional dependency. Do not restart a full-repository scan.

## 13. Explicit Non-Goals for Agents

Unless the user explicitly asks, do not:

- Rewrite or reorganize the entire app.
- Replace React, Vite, TypeScript, Tailwind, Zustand, React Router or IndexedDB architecture.
- Change the local-first privacy model.
- Add streaming-service integrations, scraping, DRM circumvention or protected-stream extraction.
- Add analytics, tracking, ads or surprise network calls.
- Upload local audio, lyrics or artwork.
- Add new cloud dependencies to a local-only feature.
- Delete local library data, original files or user settings as a shortcut.
- Replace a real workflow with placeholder buttons or mock success.
- Restyle unrelated screens.
- Change license boundaries or copy protected third-party code/assets.
- Add migrations or dependencies unrelated to the prompt.

## 14. Source-of-Truth Documents

Use these documents selectively:

- `AGENTS.md`: first-read navigation, architecture map, file-routing and agent workflow.
- `prd.md`: product scope, feature requirements, acceptance criteria and non-goals.
- `rules.md`: detailed engineering, privacy, security, performance, testing and license constraints.
- `README.md`: setup, commands, user-facing behavior, environment configuration and architecture overview.
- `worker/README.md`: Worker-specific local development and configuration.
- `docs/superpowers/plans/`: historical implementation plans. Read only if the current task continues one of those efforts or its decisions are still relevant.

Do not read all planning documents for an unrelated task. Historical plans do not override current user instructions or current code.

## 15. Final Agent Checklist

Before marking a task complete, confirm:

- [ ] I read `AGENTS.md` first.
- [ ] I selected a task route and avoided a full-repo scan.
- [ ] I inspected the actual owner and relevant tests.
- [ ] I understood the current data/state flow before changing it.
- [ ] I preserved local-first privacy and user data.
- [ ] I did not introduce a second playback engine or timing source.
- [ ] I preserved dark/light and responsive behavior where relevant.
- [ ] I added or updated tests for changed logic.
- [ ] I ran and reported the appropriate validation commands.
- [ ] I reviewed the diff for unrelated changes and security risks.
- [ ] I documented remaining limitations honestly.

---

**Operating rule:** Read this guide every time. Then read only the code needed to complete the current task safely. Repository exploration should be evidence-driven, not exhaustive.

## 16. Stable Checkpoint (P0 Reliability & Product Stabilization - 2026-11-05)

The repository at this commit is the certified stable checkpoint: `npm run typecheck`, full `npm test` (49 test files, 587 tests), `npm run lint`, and `npm run build` all pass cleanly.

State and invariants at this checkpoint:
- `@types/node` is a devDependency (fixes Vercel `TS2307: node:crypto` from `importService.test.ts`); tests stay type-checked.
- Stage 2 background is a single solid album-adaptive color (`src/features/lyrics/palette/*`, `useAdaptiveLyricsPalette.ts`); the old animated background (`LyricsBackground.tsx`, `lyricsBackground.css`, presets, `animatedLyricsBackground` setting) is removed and must not return.
- Lyrics render/scroll in `AmllLyricPlayer.tsx` via one `translate3d` track with directly built line/word DOM; `LyricsView.test.tsx` covers the real DOM path.
- **Storage & Backup Reliability:**
  - `restoreBackup` runs atomically via `repository.replaceLibrary` in one transaction. Partial writes abort cleanly, leaving the prior library intact.
  - Restoring a backup retains valid `handles` and `audio` (stored copies) for tracks present in the backup, preventing needless re-links.
  - Stricter backup validation rejects duplicate track IDs, non-string playlist track IDs, and malformed lyric lines.
  - Atomic import writes via `repository.putTrackWithFiles` write track + artwork + audio/handle in a single transaction, preventing orphan records.
  - `onversionchange` listener on IndexedDB closes stale connections when another tab initiates a schema upgrade, preventing database lockups.
  - Automatic `requestPersistentStorage()` is called on successful imports (best-effort once per session).
- **Library & Playback Integrity:**
  - Re-importing matching audio files for unavailable tracks (`missing`, `permission-required`, `offline`) relinks them and sets them `available` instead of skipping as duplicate.
  - Startup access check verifies granted handles with `handle.getFile()`, honestly marking moved/deleted files `missing`.
  - Relinking clears `broken: null` so recovered tracks don't revert to broken status on reload.
  - Removing tracks purges them from the active queue and context, adjusting `queueIndex` properly.
  - Session recovery re-maps the active index accurately when preceding tracks were deleted.
  - Session state and playback are cleanly stopped and cleared on backup restore via `resetPlaybackState()`.
- Known open item: `npm audit` reports vulnerabilities (8 moderate, 2 critical) — handle in a separate security audit, never with `npm audit fix --force`.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:46cd31e7 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
