# Agent Rules — Offline Personal Music Player

## 1. Priority Order

Follow this order when making decisions:

1. User's explicit instructions in the current task.
2. `prd.md` acceptance criteria and non-goals.
3. These engineering and design rules.
4. Existing repository conventions, provided they do not conflict with the above.

If two requirements conflict, preserve offline-first behavior, local privacy, audio correctness, and data integrity.

## 2. Mandatory First Steps

Before editing code:

1. Inspect the repository tree, `package.json`, current routes, app state, styling, tests, and README.
2. Identify the framework and versions already in use. Do not replace the stack without a documented technical reason.
3. Read the applicable repository license and third-party dependency licenses.
4. Identify which features are real, stubbed, or missing.
5. Write a brief implementation plan and name the files/modules expected to change.
6. Run existing checks once to establish the baseline. Record pre-existing failures separately from new failures.

Do not delete or replace working features just because a different implementation is easier.

## 3. License and Originality Rules

The referenced `tryliner/desktop` repository declares a source-available, non-commercial license with restrictions on public competing forks, redistribution, trademark use, and extracting core algorithms/assets for separate applications.

- Do not copy Liner branding, logo, screenshot assets, proprietary assets, shaders, signing/cryptographic code, lyric-synchronization internals, or distinctive implementation details into a separate project.
- Treat the supplied video and repository as product-category and high-level visual references, not permission to reproduce protected code or branding.
- Implement the product from original code with original component structure, styling, and assets.
- Before editing the reference repository or reusing any code, verify that the intended local personal use is permitted by the current license. If uncertain, stop code reuse and use a clean-room implementation.
- Do not publish, deploy, monetize, or redistribute a derivative of the reference project unless the rights holder has granted explicit permission.
- Do not present the new app as an official Liner product or use its name in the app UI.
- Preserve required notices for any dependency or code that is lawfully reused.

## 4. Product Scope Rules

The product is a **personal local-file player**, not a streaming service.

Allowed:
- User-selected local audio files
- Local metadata, playlist, liked-song, playback-history, and lyric persistence
- Sidecar `.lrc` and `.txt` lyric import
- Browser-local backup export/import
- Offline PWA app-shell caching

Disallowed unless the user explicitly changes scope:
- Login or user accounts
- Cloud database or sync
- Remote music catalog or streaming APIs
- Spotify/Apple Music/YouTube Music scraping or protected-stream extraction
- Audio uploads, analytics, advertising, or tracking
- Required API keys or backend services
- AI lyric generation or speech-to-text APIs
- Fake demo content in production

Never create an external network dependency for a feature that can work locally.

**Cloud-mode amendment (explicitly granted scope).** The optional cloud layer is permitted under these conditions, all mandatory:
- Cloud features are invisible and inert until the user configures the environment and signs in; the local product behaves identically without them.
- Only publishable values may ship to the browser (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_WORKER_URL`). Service-role keys, JWT secrets, and R2 access keys are Worker secrets, never frontend values.
- Access tokens are verified by signature (or by the Supabase Auth service). Never decode-and-trust a JWT; never trust a user id from the browser.
- Cloud audio objects live under `users/{userId}/...` keys built and authorized by the Worker. The bucket stays private.
- Presigned URLs are short-lived and per-request. They are never stored in Postgres, IndexedDB, a Track record, or the service worker.
- A failed sync, failed upload, or dead network must never delete or alter local data. Local copies are removed only by an explicit user action after the cloud copy and metadata are verified.
- Cloud services stay in `src/services/cloud/*`; network calls must never move into UI components.

## 5. Architecture Rules

- Keep a single source of truth for playback.
- Use one shared audio service/audio element. Do not let individual pages create independent audio elements.
- Separate presentation, state management, persistence, file access, metadata parsing, and lyric parsing.
- Keep IndexedDB operations inside a repository/service layer.
- Keep audio events and media state inside the playback service/store.
- Use TypeScript types for persisted entities, component props, and service boundaries.
- Validate unknown data at runtime, especially imported backups and metadata.
- Use schema versioning and safe IndexedDB migrations.
- Use stable IDs; do not rely on array indexes as track or playlist identity.
- Avoid global mutable state outside the chosen store/service.
- Do not introduce an abstraction unless it reduces duplication, improves testability, or clarifies a real boundary.
- Keep components focused. Extract a component when it has a clear responsibility, not merely to reduce line count.

## 6. Data Integrity and Browser Storage

- Never claim browser-selected audio is permanently stored unless the implementation actually stores the file bytes or has a valid persisted handle.
- Prefer persisted File System Access handles when supported and permitted; handle permission revocation.
- Provide multi-file input fallback for browsers without folder access.
- Preserve track metadata when its source file becomes unavailable.
- Never delete or modify the user's original audio file.
- Removing a track from the app means removing its app-library reference only.
- Playlist deletion must not delete track records.
- Backups must exclude machine-specific filesystem paths and file handles.
- Validate a backup fully before mutation. Use confirmation before replacing existing data.
- Handle quota errors and failed migrations explicitly.
- Debounce frequent writes. Do not persist the playback clock on every animation frame.
- Do not use `localStorage` for large data, artwork blobs, lyrics collections, or full library state.
- Revoke object URLs and release references when they are no longer needed.

## 7. Playback Correctness

- Audio element time is the authority for playback position and lyric timing.
- Do not maintain separate timers that drift away from the real audio clock.
- Handle `play()`, `pause`, `ended`, `timeupdate`, `durationchange`, `loadedmetadata`, `error`, and seeking states.
- Account for autoplay restrictions; playback must follow a user gesture when required.
- Avoid race conditions when switching tracks quickly.
- Prevent the old track from continuing after a new track is selected.
- Ensure queue operations are deterministic.
- Define and test shuffle and repeat transitions.
- Never display fabricated duration, progress, or playing status.
- Track availability errors must be visible and recoverable.
- Test at least MP3 plus one other browser-supported format, and explicitly document format-specific browser limitations.

## 8. Lyrics Rules

- Parse `.lrc` timestamps into integer milliseconds.
- Sort lyric entries by timestamp while preserving stable ordering for equal timestamps.
- Support offset correction as a separate per-track value; do not rewrite original imported data to apply the offset.
- Use the audio element's current time to select the active lyric.
- Clicking a timed line seeks the actual playback engine.
- Plain `.txt` is static content unless reliable timestamps are provided.
- Never simulate word- or syllable-level synchronization from line-only timestamps.
- Validate malformed timestamps and keep valid lines when safe to do so.
- Avoid auto-scroll on every animation frame. Scroll only when the active line changes or when visual interpolation requires it.
- Test offset boundaries, timestamps before zero, repeated timestamps, empty files, malformed lines, and track changes.

## 9. UI and Visual Rules

- Follow the design direction in `prd.md`: calm, premium, dark, artwork-led, typography-focused, and music-first.
- Create original visual components. Do not reproduce Liner screenshots pixel-for-pixel or reuse Liner logos/assets.
- Prefer solid, controlled surfaces with subtle gradients only when they improve contrast or reflect artwork.
- Do not add random neon glows, excessive glass effects, generic SaaS cards, excessive borders, or decorative animation.
- Define colors, spacing, radii, typography, and shadows as reusable tokens.
- Keep album art from compromising text contrast.
- Use consistent spacing, icon sizes, control hierarchy, loading states, and empty states.
- Every visible control must do what its label or icon implies. No decorative buttons that pretend to work.
- Every icon-only button needs an accessible name and tooltip/title where appropriate.
- Provide visible keyboard focus styles.
- Respect `prefers-reduced-motion`.
- Avoid layout shifts when artwork or metadata loads.
- Prevent horizontal overflow at 360px width.
- Keep the mini-player persistent while routes change.
- Avoid excessive rerenders from playback time updates; isolate high-frequency state from unrelated page content.

## 10. Interaction Rules

- Use explicit loading, success, empty, and error states.
- Confirm destructive actions.
- Distinguish `Remove from library` from `Delete source file`; do not implement source-file deletion.
- Keep dialogs keyboard-accessible and trap focus only while open.
- Close menus/dialogs with Escape where appropriate.
- Preserve user input after recoverable errors.
- Do not show success toast until the operation actually succeeds.
- Do not silently ignore permission denial, storage failure, unsupported format, or invalid import.
- Keyboard shortcuts must not hijack typing inside input, textarea, editable controls, or native media interactions.
- Avoid adding gestures with no clear discoverability or accessible equivalent.

## 11. Offline and Privacy Rules

- No remote fetch is allowed for core app functionality.
- Bundle fonts, icons, and required UI assets locally.
- Search, filtering, lyric matching, and playlist operations must stay local.
- Do not send file names, metadata, lyrics, artwork, or audio data to any server.
- A service worker caches the app shell only by default, not arbitrary audio.
- Show clear offline limitations and installation/cache status when relevant.
- Never claim the app shell is available offline before it has been cached successfully.
- Verify offline behavior using a production build and browser network disabled.
- Search the code for `fetch`, XHR, analytics SDKs, external fonts, and remote asset URLs before finalizing; justify any remaining network call.

## 12. Performance Rules

- Avoid unbounded lists; use virtualization when real data size justifies it.
- Limit artwork decoding and render dimensions.
- Use thumbnails or object-fit rendering instead of repeatedly decoding large originals.
- Do not run full-file hashes on the main thread.
- Debounce search and persistence only where necessary; do not add lag to playback controls.
- Clean up event listeners, media subscriptions, object URLs, and worker tasks.
- Stop animation frames when views are hidden or unmounted.
- Avoid unnecessary dependencies and large animation libraries.
- Measure before optimizing. Do not make performance claims without a test or trace.
- Prioritize stable playback and low memory use over decorative effects.

## 13. Code Quality Rules

- Follow the existing project formatter and lint configuration.
- Avoid `any`; if unavoidable at an external boundary, isolate and validate it.
- Do not suppress TypeScript or lint errors to force a build.
- Avoid broad `try/catch` blocks that swallow errors.
- Keep error messages actionable, but never expose stack traces to end users.
- No dead code, duplicate helpers, unused imports, placeholder handlers, or unexplained magic values.
- Do not add a dependency if a small, tested native implementation is sufficient.
- Do not change package manager or lockfile format without explicit need.
- Do not edit generated output or minified bundles by hand.

## Additional Rules for the Cloud Layer

- The Worker project keeps its own package, config, build, and tests; it must not alter the frontend's build or package manager.
- Every Worker endpoint has a failure status with an actionable message; tests cover unauthenticated, invalid-token, expired-token, and cross-user cases at minimum.
- `completeUpload`-style verification is mandatory: object existence plus size and metadata, before any success state is shown or persisted.
- SQL changes are version-controlled migrations with RLS policies for SELECT, INSERT, UPDATE, and DELETE; policy tests exist where a database instance is available.
- Sync is idempotent and keyed on stable ids; a retry must never duplicate a track, playlist, or membership row.
- Cloud playback goes through the same single audio element and clock. Adding a cloud source must not introduce a second engine, a second clock, or timing drift.
- The IndexedDB schema must stay readable by existing installs: cloud fields are optional and migrations are additive and re-runnable.

## 14. Testing Rules

Add tests with each feature; do not postpone all tests until the end.

Minimum automated coverage:
- LRC parsing and offsets
- Active lyric selection at boundary timestamps
- Playback queue next/previous/repeat/shuffle behavior
- Playlist CRUD and track ordering
- Liked state persistence
- Backup schema validation and import/export
- IndexedDB error/quota paths where testable
- Missing-file and permission-denied state transitions
- Search normalization and filtering
- Route change does not reset playback

Before completing a task, run the available equivalents of:
1. Type check
2. Lint
3. Unit tests
4. Production build

Report which commands ran and whether they passed. Do not say tests pass if they were not executed.

## 15. Agent Workflow Rules

- Work in small, verifiable phases following `prd.md`.
- Start each phase by stating the intended behavior and affected modules.
- Implement a vertical slice that can run before starting the next slice.
- Inspect existing code before replacing it.
- Do not rewrite the entire application in one pass.
- Keep existing working behavior unless there is a clear reason to change it.
- When blocked, document the exact browser/API limitation and build the best honest fallback.
- If a requirement conflicts with browser security, codec support, or the license, do not fake compliance; implement a transparent alternative.
- Keep a concise changelog of major architecture decisions.
- After changes, review the diff for accidental asset/code copying, remote dependencies, secrets, and unrelated modifications.

## 16. Definition of Done

A task is not complete until:
- The specified interaction works end-to-end.
- Loading, empty, and error states exist.
- Data survives reload where required and supported.
- Playback and lyric timing use the real audio clock.
- Keyboard and responsive behavior are checked.
- Tests, lint, typecheck, and build are run where available.
- No unrelated features are broken.
- Documentation explains any limitations.
- No fake API, dummy production content, or nonfunctional control remains.
