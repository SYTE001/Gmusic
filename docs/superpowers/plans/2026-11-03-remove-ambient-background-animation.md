# Remove Ambient Background Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completely remove the Ambient Background Animation feature from the Music Player page, eliminate artwork color extraction and unused canvas/animation routines, and set a clean, neutral theme background for optimal lyrics readability and performance.

**Architecture:**
1. In `NowPlayingPage.tsx`: Remove `<LyricsAmbientBackground />` and its import. Update the root overlay container from `bg-transparent` to `bg-app-bg` to ensure a consistent, neutral background respecting active Dark/Light themes with high lyrics contrast.
2. Clean up ambient background files and assets: Delete `LyricsAmbientBackground.tsx`, `useLyricsAmbient.ts`, `ambientBackground.css`, and fallback image assets (`lyrics-fallback-dark.webp`, `lyrics-fallback-light.webp`).
3. In `Artwork.tsx`: Remove the unused artwork dominant color extraction logic (`dominantColors`, `getDominantColor`, canvas extraction), removing unnecessary offscreen canvas operations and event listeners.
4. Replace `LyricsAmbientBackground.test.tsx` with targeted `NowPlayingPage.test.tsx` asserting that `NowPlayingPage` mounts with `bg-app-bg`, has no ambient canvas/layers, and preserves all playback controls and artwork layout.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, Vitest, Testing Library.

**Spec:** User request (Hapus sepenuhnya fitur Ambient Background Animation pada halaman Music Player).

## Global Constraints
- Do not alter the Music Player layout, dimensions, or album artwork positioning.
- Do not alter typography, lyric transition animations, or playback controls.
- Do not alter the album artwork fetching/cache system.
- Dark Mode and Light Mode must continue functioning normally with high-contrast text and neutral backgrounds.
- Do not introduce any new gradients, glassmorphism, or decorative background effects.
- Clean up all unused hooks, state, animations, canvas logic, and assets.

## Review Focus
1. NowPlayingPage background must be solid neutral (`bg-app-bg`), rendering `#09090b` in Dark Mode and `#f5f5f7` in Light Mode.
2. Inactive and active lyrics must remain crisp, legible, and unperturbed by any artwork colors or blurs.
3. Track change must not execute canvas operations, image decoding for background, or animation loops.
4. Album artwork rendering, aspect ratio, rounded corners (`rounded-[20px]`), and playback controls must remain completely intact.
5. All test suites and production build (`npm run build`) must pass cleanly.

---

### Task 1: Remove Ambient Background from NowPlayingPage & Delete Ambient Modules

**Files:**
- Modify: `src/features/player/NowPlayingPage.tsx`
- Delete: `src/features/lyrics/LyricsAmbientBackground.tsx`
- Delete: `src/features/lyrics/useLyricsAmbient.ts`
- Delete: `src/features/lyrics/ambientBackground.css`
- Delete: `src/assets/lyrics-fallback-dark.webp`
- Delete: `src/assets/lyrics-fallback-light.webp`

- [ ] **Step 1: Update `src/features/player/NowPlayingPage.tsx`**
  - Remove `import LyricsAmbientBackground from "../lyrics/LyricsAmbientBackground";`
  - Remove `<LyricsAmbientBackground trackId={track.id} />` from the render tree.
  - Change the main container element class from `bg-transparent` to `bg-app-bg`.
  - Remove fragment wrapper `<> ... </>` as the main container is now the single root element.
  - Clean up JSDoc / comments referencing liquid ambient background.

- [ ] **Step 2: Delete ambient background source files and assets**
  - Delete `src/features/lyrics/LyricsAmbientBackground.tsx`
  - Delete `src/features/lyrics/useLyricsAmbient.ts`
  - Delete `src/features/lyrics/ambientBackground.css`
  - Delete `src/assets/lyrics-fallback-dark.webp`
  - Delete `src/assets/lyrics-fallback-light.webp`

- [ ] **Step 3: Verify TypeScript compilation**
  Run: `npx tsc --noEmit`
  Expected: Success without type errors (except test file if referencing deleted modules, addressed in Task 3).

---

### Task 2: Remove Artwork Dominant Color Extraction from `src/components/Artwork.tsx`

**Files:**
- Modify: `src/components/Artwork.tsx:127-134,215-273`

- [ ] **Step 1: Clean up `clearArtworkCache` in `src/components/Artwork.tsx`**
  - Remove `dominantColors.clear();` call from `clearArtworkCache()`.

- [ ] **Step 2: Remove `dominantColors` and `getDominantColor`**
  - Remove the `dominantColors` Map definition.
  - Remove `export async function getDominantColor(...)` and its offscreen canvas image processing loop.
  - Clean up PRD JSDoc comment regarding artwork-derived tints.

- [ ] **Step 3: Verify Artwork component tests and exports**
  Run: `npx vitest run src/services/artwork/artworkService.test.ts`
  Expected: PASS

---

### Task 3: Replace Ambient Background Tests with NowPlayingPage Neutral Presentation Tests

**Files:**
- Delete: `src/features/lyrics/LyricsAmbientBackground.test.tsx`
- Create: `src/features/player/NowPlayingPage.test.tsx`

- [ ] **Step 1: Delete `src/features/lyrics/LyricsAmbientBackground.test.tsx`**
  - Remove obsolete tests targeting deleted ambient background components.

- [ ] **Step 2: Create `src/features/player/NowPlayingPage.test.tsx`**
  - Test that `NowPlayingPage` mounts with `bg-app-bg` on its root container.
  - Test that no `.gm-ambient` elements or `<canvas>` elements exist in the DOM.
  - Test that track title, artist, artwork container, and playback controls (play/pause, seekbar, shuffle, repeat) render properly without ambient background interference.
  - Test that escape key navigates back.

- [ ] **Step 3: Run the new test**
  Run: `npx vitest run src/features/player/NowPlayingPage.test.tsx`
  Expected: PASS

---

### Task 4: Complete Verification & Build Validation

**Files:**
- Test: Full Vitest suite
- Build: Vite production build

- [ ] **Step 1: Run the full test suite**
  Run: `npm test -- --run`
  Expected: All test suites PASS with zero failures.

- [ ] **Step 2: Run production build**
  Run: `npm run build`
  Expected: Build completes successfully; output bundle has no ambient background chunks or CSS.
