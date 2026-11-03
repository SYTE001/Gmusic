# Redesign Error Notification + Smart Error Summary + Broken Page Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the error notification banner to match the visual reference with big, high-legibility typography, focused strictly on the core error title and track pill (omitting cluttered description text for instant 3-second readability), while preserving full error descriptions, original error messages, and deep-link inspection on the Broken page.

**Architecture:** 
1. `src/services/errors/summarizePlaybackError.ts` normalizes raw errors into `PlaybackErrorSummary` (core title, summary for Broken page, category, original technical message, error code).
2. `src/stores/playbackStore.ts` and `src/stores/libraryStore.ts` integrate the summarization engine, persisting full error details into `BrokenInfo` in IndexedDB.
3. `src/components/DynamicIslandNotification.tsx` displays the clean, high-impact notification banner: solid red square icon box, big bold error title, compact track pill, and close X. Description text is removed from the banner for rapid 3-second comprehension. Entire banner is clickable to open `/broken?trackId=...`, with hover/focus pausing auto-dismiss.
4. `src/features/broken/BrokenPage.tsx` handles deep-link query params, auto-scrolls/highlights the faulty track, and displays complete error details (summary, original message, error code, timestamp).

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, Zustand, React Router v7, Vitest, Testing Library.

**Spec:** PRD and task description in user request, visual reference at `media_1793712716403_b6d13620.png`.

## Global Constraints

- Visual banner: horizontal banner, `rounded-[28px]..rounded-[34px]`, solid neutral border (`var(--border-subtle)`), solid theme surface background (`bg-surface`), no gradient/glassmorphism/blur/neon.
- Error icon: solid red square (`#EF233C`) with `rounded-[20px]..rounded-[24px]` (~56x56px) and white warning triangle inside.
- Track pill: neutral surface (`bg-surface-raised`), musical note icon, `Artist — Title` with elegant truncation.
- Summarization: deterministic rule-based (no AI or heavy external libs), <= 1 short sentence summary, target <= 90 chars, clean of technical stack traces and file paths.
- Original error: preserved in full for Broken page inspection.
- Navigation: entire notification banner clickable to open `/broken?trackId=<id>`, keyboard Enter/Space accessible, close button (X) dismisses without navigating.
- Auto-dismiss: 3000ms countdown, paused on hover or keyboard focus, resumed when unhovered/blurred.
- Quality gates: pass `npm run typecheck`, `npm run lint`, `npm run test`, and `npm run build`.

## Review Focus

1. Input is a long DOMException with full filesystem path and stack trace: verify that notification summary contains no paths/stack traces and stays <= 90 chars while `originalMessage` keeps full text.
2. User hovers or focuses the notification banner before 3000ms: verify that auto-dismiss timer pauses and does not dismiss until pointer leaves or focus is lost.
3. User clicks the notification close button (X): verify that event propagation is stopped, notification dismisses, and no navigation to `/broken` occurs.
4. User clicks notification body or presses Enter on focused banner: verify that navigation navigates to `/broken?trackId=<id>` and the Broken page scrolls/highlights that specific track.
5. Repeated playback failure on the same broken track: verify that `BrokenInfo` updates timestamp and retry count without creating duplicate entries in the library.

---

### Task 1: Rule-Based Playback Error Summarization Engine

**Files:**
- Create: `src/services/errors/summarizePlaybackError.ts`
- Test: `src/services/errors/summarizePlaybackError.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PlaybackErrorSummary = {
    title: string;
    summary: string;
    category: "missing" | "corrupted" | "unsupported" | "decoding" | "permission" | "network" | "playback";
    originalMessage: string;
    errorCode?: string;
  };

  export function summarizePlaybackError(
    error: unknown,
    context?: { trackTitle?: string; artist?: string }
  ): PlaybackErrorSummary;
  ```

- [ ] **Step 1: Write the failing tests for error summarization**

Test cases to cover in `src/services/errors/summarizePlaybackError.test.ts`:
- Single sentence error.
- Multi-sentence error with technical explanation (e.g. `NotSupportedError: Failed to load because no supported source was found. The browser could not decode the audio resource. Please check the media format and source.`).
- Error with file paths, stack traces, and internal IDs (must strip paths like `C:\Users\...` or `/var/music/...` from summary).
- DOMException instances (`NotFoundError`, `NotSupportedError`, `SecurityError`, `QuotaExceededError`).
- MediaError objects (`code: 1` aborted, `code: 2` network, `code: 3` decode, `code: 4` unsupported).
- Corrupted/damaged audio messages.
- Missing/unavailable audio sources.
- Access denied / permission errors.
- Empty string, undefined, null, or generic object errors.
- Ensure summary is at most 1 short sentence (target <= 90 characters) and original message is preserved completely.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/services/errors/summarizePlaybackError.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `summarizePlaybackError` in `src/services/errors/summarizePlaybackError.ts`**

Implement deterministic rule-based classifier:
1. Extract raw message and code from Error, DOMException, MediaError `{ code, message }`, or primitive string.
2. Remove technical noise, stack traces, memory addresses, and file paths for the clean summary.
3. Match against known categories:
   - Missing file (`missing`): "Audio not found" / "The audio file could not be found or opened."
   - Corrupted file (`corrupted`): "Damaged audio" / "This audio file appears to be damaged."
   - Unsupported format (`unsupported`): "Unsupported audio" / "This audio format is not supported."
   - Decoding failed (`decoding`): "Playback failed" / "The audio file could not be decoded."
   - Permission denied (`permission`): "Access denied" / "Permission to access this audio file was denied."
   - Source unavailable (`missing`): "Source unavailable" / "The audio source is no longer available."
   - General / unknown (`playback`): "Playback error" / "This track could not be played."
4. Enforce summary constraint: 1 sentence, clean punctuation, maximum 90 characters.
5. Return full `PlaybackErrorSummary` with untouched `originalMessage` and extracted `errorCode`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/services/errors/summarizePlaybackError.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/errors/summarizePlaybackError.ts src/services/errors/summarizePlaybackError.test.ts
git commit -m "feat: add rule-based playback error summarization engine"
```

---

### Task 2: Store Integration & Full Error Persistence

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/stores/libraryStore.ts`
- Modify: `src/stores/playbackStore.ts`
- Modify: `src/stores/dynamicIslandStore.ts`
- Test: `src/features/playback/playbackErrors.test.ts`

**Interfaces:**
- Consumes: `summarizePlaybackError` from `src/services/errors/summarizePlaybackError.ts`
- Produces:
  - Extended `BrokenInfo`:
    ```ts
    export type BrokenInfo = {
      isBroken: boolean;
      category: BrokenCategory;
      description: string;
      failedAt: number;
      retryCount?: number;
      summary?: string;
      originalMessage?: string;
      errorCode?: string;
    };
    ```
  - Extended `NotificationPayload`:
    ```ts
    export type NotificationPayload = {
      title: string;
      description: string;
      song?: string;
      trackId?: string;
      category?: string;
      errorCode?: string;
    };
    ```

- [ ] **Step 1: Write failing tests in `src/features/playback/playbackErrors.test.ts`**

Update and add tests to verify:
- When playback engine throws a MediaError or source resolution fails, `summarizePlaybackError` is used.
- `markTrackBroken` receives and stores `summary`, `originalMessage`, and `errorCode` on the track's `broken` field.
- Subsequent errors on the same broken track increment `retryCount` and update `failedAt`, without creating duplicate entries.
- Notification payload dispatched to `useDynamicIslandStore` carries `title`, `description` (short summary), `song` formatted as `${artist} — ${title}`, and `trackId`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/playback/playbackErrors.test.ts`
Expected: FAIL due to missing fields or changed notification titles matching new summarization specs.

- [ ] **Step 3: Update `BrokenInfo` and store error handlers**

1. In `src/types/index.ts`: Add optional `summary?: string; originalMessage?: string; errorCode?: string;` to `BrokenInfo`.
2. In `src/stores/libraryStore.ts`: In `markTrackBroken`, accept `info: { category: BrokenCategory; description: string; summary?: string; originalMessage?: string; errorCode?: string }` and persist them into the track record in IndexedDB and Zustand store.
3. In `src/stores/playbackStore.ts`: In `handleEngineError` and playback source failure handlers, pass raw failure to `summarizePlaybackError`. Call `markTrackBroken` with summary, originalMessage, and errorCode. Call `useDynamicIslandStore.getState().showNotification` with the standardized payload.
4. In `src/stores/dynamicIslandStore.ts`: Update `NotificationPayload` to preserve `errorCode?: string`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/features/playback/playbackErrors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts src/stores/libraryStore.ts src/stores/playbackStore.ts src/stores/dynamicIslandStore.ts src/features/playback/playbackErrors.test.ts
git commit -m "feat: integrate error summarization with playback and library stores"
```

---

### Task 3: Redesigned Error Notification Banner & Interactive Navigation

**Files:**
- Modify: `src/components/DynamicIslandNotification.tsx`
- Modify: `src/stores/dynamicIslandStore.ts`
- Test: `src/components/DynamicIslandNotification.test.tsx`

**Interfaces:**
- Consumes:
  - `useDynamicIslandStore`
  - `useNavigate` from `react-router-dom`
  - `WarningIcon`, `CloseIcon`, `MusicNoteIcon` from `src/components/Icons`
- Produces:
  - Rendered notification banner strictly matching the design image in both Dark and Light modes.
  - Interactive pause/resume auto-dismiss on mouse enter / focus.
  - Banner click navigation to `/broken?trackId=${encodeURIComponent(trackId)}`.

- [ ] **Step 1: Write failing tests in `src/components/DynamicIslandNotification.test.tsx`**

Test cases:
- Banner renders with horizontal layout, solid red square icon box, title, summary, and track pill with music icon.
- Clicking the notification body calls navigation to `/broken?trackId=<id>`.
- Pressing Enter or Space on the focused notification triggers navigation to `/broken?trackId=<id>`.
- Clicking the close button (X) stops event propagation, dismisses the notification, and does NOT navigate.
- Auto-dismiss triggers after 3000ms under idle conditions.
- Hovering (`mouseEnter`) or keyboard focusing the notification pauses auto-dismiss.
- Unhovering (`mouseLeave`) or blurring resumes the auto-dismiss timer.
- Clean unmount clears timers without memory leaks.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/DynamicIslandNotification.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement pause/resume in `dynamicIslandStore.ts` or component**

Enhance `useDynamicIslandStore` with `pauseAutoDismiss()` and `resumeAutoDismiss()` methods, tracking remaining duration of the 3000ms window so hover/focus accurately suspends dismissal.

- [ ] **Step 4: Implement visual redesign in `src/components/DynamicIslandNotification.tsx`**

Implement according to reference image:
- Outer container: `fixed top-3 left-1/2 -translate-x-1/2 z-50 px-4 w-full flex justify-center pointer-events-none md:top-4`.
- Inner banner:
  - `pointer-events-auto relative flex items-center w-[min(580px,calc(100vw-32px))] rounded-[30px] p-3.5 border border-[var(--border-subtle)] bg-surface text-text-primary shadow-[var(--shadow-overlay)] cursor-pointer select-none transition-all duration-200 hover:border-text-muted/30 focus-visible:outline-2 focus-visible:outline-accent`.
  - Dark mode: `bg-surface` (`#111113`), border `var(--border-subtle)` (`#26262b`), text white/zinc-400.
  - Light mode: `bg-surface` (`#ffffff`), border `var(--border-subtle)` (`#e4e4e7`), text dark charcoal/zinc-600.
  - No blur, no gradient, no neon.
- Left Icon Box:
  - `grid size-14 shrink-0 place-items-center rounded-[20px] bg-[#EF233C] text-white shadow-sm`.
  - Centered `WarningIcon` with size 26 in white.
- Center Content Column:
  - `min-w-0 flex-1 pl-3.5 pr-2 flex flex-col justify-center`.
  - Big Typography Title: `<h4 className="truncate text-[16px] md:text-[17px] font-bold text-text-primary leading-tight tracking-tight">{current.title}</h4>`.
  - (Description line omitted from banner for 3-second rapid readability, full details shown in Broken page).
  - Track pill (when `current.song` exists):
    - `<div className="mt-1.5 inline-flex max-w-full items-center gap-1.5 rounded-full bg-surface-raised px-2.5 py-1 text-[11.5px] md:text-[12px] text-text-primary">`
    - `<MusicNoteIcon size={13} className="shrink-0 text-text-secondary" />`
    - `<span className="truncate">{current.song}</span>`
- Right Close Button:
  - `absolute top-3 right-3.5 grid size-7 place-items-center rounded-full text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors`.
  - `onClick={(e) => { e.stopPropagation(); dismiss(); }}`.
  - `aria-label="Dismiss notification"`.
- Keyboard & Interaction Handlers:
  - Click on container: `navigate(/broken?trackId=${encodeURIComponent(current.trackId)})` if trackId exists, else `/broken`. Dismiss notification upon navigation.
  - Keyboard `onKeyDown`: Enter or Space triggers navigation.
  - `onMouseEnter` / `onFocus`: `pauseAutoDismiss()`.
  - `onMouseLeave` / `onBlur`: `resumeAutoDismiss()`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/components/DynamicIslandNotification.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/DynamicIslandNotification.tsx src/stores/dynamicIslandStore.ts src/components/DynamicIslandNotification.test.tsx
git commit -m "feat: redesign error notification banner matching visual reference with interactive pause and navigation"
```

---

### Task 4: Broken Page Deep Linking, Track Highlighting, and Full Error Inspection

**Files:**
- Modify: `src/features/broken/BrokenPage.tsx`
- Test: `src/features/broken/BrokenPage.test.tsx`

**Interfaces:**
- Consumes:
  - `useSearchParams` from `react-router-dom`
  - `Track.broken` fields (`category`, `description`, `summary`, `originalMessage`, `errorCode`, `failedAt`, `retryCount`)
- Produces:
  - Auto-scrolling and highlight flash on target track when `?trackId=<id>` is provided.
  - Detailed error inspector panel/row for each track displaying category, short summary, original error message, error code, and timestamp.

- [ ] **Step 1: Write failing tests in `src/features/broken/BrokenPage.test.tsx`**

Test cases:
- When page loads with `?trackId=t-123`, track element with `data-track-id="t-123"` receives highlighted class / styling and is scrolled into view.
- Track item displays:
  - Category badge.
  - Summary / description.
  - Original error message (verbatim).
  - Error code if present (e.g. `MEDIA_ERR_SRC_NOT_SUPPORTED (4)`).
  - Timestamp of error formatted cleanly.
- Existing actions (Retry, Restore, Remove) remain functional.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/broken/BrokenPage.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement deep-linking and detail rendering in `src/features/broken/BrokenPage.tsx`**

1. Parse search query: `const [searchParams] = useSearchParams(); const highlightedTrackId = searchParams.get("trackId");`.
2. Scroll to and temporarily highlight matching track using `useEffect` with `element.scrollIntoView({ behavior: "smooth", block: "center" })`.
3. Add highlight animation / ring: `ring-2 ring-accent bg-surface-raised/60` for 2.5 seconds when active.
4. Render complete error details in the track card:
   - Category badge (e.g. "Unsupported audio", "Missing source", "Corrupted audio").
   - Summary text.
   - Original technical error message (in a clean subtle code block or details tag so users/devs can inspect the raw string).
   - Error code badge if available.
   - Relative or formatted timestamp (`Failed at ...`).
5. Ensure empty state and existing operations (Retry, Restore, Remove) work without regression.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/broken/BrokenPage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/broken/BrokenPage.tsx src/features/broken/BrokenPage.test.tsx
git commit -m "feat: add deep-link track highlighting and full error details on Broken page"
```

---

### Task 5: System Verification, Responsive Audit & Test Suite

**Files:**
- Test all modified and affected files.

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 2: Run linter**

Run: `npm run lint`
Expected: 0 warnings, 0 errors.

- [ ] **Step 3: Run complete automated test suite**

Run: `npm run test`
Expected: All tests pass.

- [ ] **Step 4: Run production build**

Run: `npm run build`
Expected: Build succeeds with 0 errors.

- [ ] **Step 5: Visual and layout verification**

Verify desktop and mobile rendering across dark and light themes, ensuring:
- Desktop: Horizontal notification banner centered with red square icon, title, summary, track pill, and top-right close X.
- Mobile: Responsive flex banner without overflow or collision.
- Dark theme: Dark solid background, subtle border, white/zinc typography.
- Light theme: White solid background, light gray subtle border, dark typography.
- Event isolation: Clicking close only dismisses; clicking body routes to `/broken?trackId=...`.

- [ ] **Step 6: Final Commit & Summary**

```bash
git commit --allow-empty -m "chore: complete error notification redesign and verification"
```
