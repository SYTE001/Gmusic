# Solid Lyrics Spin Transition & Final Performance Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Gmusic's rubber-like, bouncy, word-by-word staggered lyrics animation with a unified, solid 3D spin/flip transition (~10° rotation, 280ms duration, `cubic-bezier(0.22, 1, 0.36, 1)`, subtle opacity fade, center transform origin) while preserving word-by-word synchronization, eliminating unnecessary Web Animations instances, and optimizing rendering performance to a rock-solid 60 FPS.

**Architecture:** 
1. AMLL runtime configuration in `AmllLyricPlayer.tsx`: Disable physics-based springs (`setEnableSpring(false)`), eliminate cumulative staggered line delays via `LayoutReasonStrategyMap[LayoutReason.PlaybackTick].disableStagger = true`, reduce idle rAF settle window from 1600ms to 350ms, and intercept/no-op per-word `float-word` / `emphasize-word-float` animation instances while preserving `fade-word` mask-image highlighting.
2. GPU-composited CSS 3D transformation in `amll.css`: Apply 3D perspective to container, smooth cubic-bezier scroll transitions to line wrappers, and unified 3D flip rotation (`rotateX(-10deg)` for past, `rotateX(0deg)` for active, `rotateX(10deg)` for upcoming) with subtle opacity fade to `.FmKaba_lyricMainLine`. Lock all word and character spans to prevent independent movement (`transform: none !important`). Provide graceful fallbacks for `prefers-reduced-motion` and `html[data-motion="on"]`.
3. Validation in `LyricsView.test.tsx` and vitest suite.

**Tech Stack:** React 19, TypeScript, CSS 3D transforms (`rotateX`, `perspective`), `@applemusic-like-lyrics/core`, Vitest, Testing Library.

**Spec:** User request (Solid Lyrics Spin Transition & Final Performance Optimization).

## Global Constraints
- Unified line movement: Entire lyric line must behave as ONE solid visual element.
- No rubber, bounce, or elastic overshoot.
- Rotation: ~8–15 degrees (tuned to 10 degrees).
- Duration: 220–320ms (tuned to 280ms).
- Easing: `cubic-bezier(0.22, 1, 0.36, 1)`.
- Transform origin: `center`.
- Preserve word-by-word synchronization engine and highlighting accuracy.
- Zero layout-triggering animated properties (no width, height, top/left, margin, padding, blur).
- Respect `prefers-reduced-motion` and `html[data-motion="on"]`.

## Review Focus
1. Word-by-word timestamps and active word detection must remain accurate without timing delay.
2. Seeking forward and backward must snap smoothly without animation stacking or queue accumulation.
3. Pausing and resuming must freeze and resume cleanly with zero spring settle delay.
4. Rapid playback ticks must not cause animation buildup or frame drops.
5. Reduced motion must disable 3D rotation and provide an instantaneous or subtle opacity transition.

---

### Task 1: AMLL Configuration & Animation Engine Tuning

**Files:**
- Modify: `src/features/lyrics/AmllLyricPlayer.tsx`
- Test: `src/features/lyrics/LyricsView.test.tsx`

- [ ] Disable AMLL spring physics simulation unconditionally (`player.setEnableSpring(false)`) to eliminate rubber bounce and overshoot.
- [ ] Configure `LayoutReasonStrategyMap[LayoutReason.PlaybackTick].disableStagger = true` to remove 50ms cumulative line delays.
- [ ] Reduce `SETTLE_MS` from 1600ms to 350ms to eliminate unnecessary requestAnimationFrame idle iterations.
- [ ] Filter out per-word float animations (`float-word` and `emphasize-word-float`) during lyric setup/lifecycle to eliminate hundreds of active Web Animations instances while preserving `fade-word` mask-image highlighting.
- [ ] Verify test suite and ensure no regressions in line seeking or clock synchronization.

### Task 2: Solid 3D Spin CSS Transition & Span Isolation

**Files:**
- Modify: `src/features/lyrics/amll.css`

- [ ] Add 3D perspective context to `.gm-amll` (`perspective: 1200px`, `perspective-origin: center center`).
- [ ] Configure `.FmKaba_lyricLineWrapper` with smooth GPU transform scrolling (`transition: transform 280ms cubic-bezier(0.22, 1, 0.36, 1) !important`).
- [ ] Style `.FmKaba_lyricMainLine` as the single visual transform target:
  - Transform origin: `center center`.
  - Easing: `cubic-bezier(0.22, 1, 0.36, 1)`.
  - Duration: 280ms.
  - Inactive / past lines: `transform: perspective(1000px) rotateX(-10deg) scale(0.96); opacity: 0.4;`
  - Inactive / upcoming lines: `transform: perspective(1000px) rotateX(10deg) scale(0.96); opacity: 0.4;`
  - Active line: `transform: perspective(1000px) rotateX(0deg) scale(1); opacity: 1;`
- [ ] Enforce word span immobility (`transform: none !important; transition: none !important; animation: none !important;`) on `.FmKaba_lyricMainLine span` and `.FmKaba_emphasizeWrapper` so individual words do not animate independently.
- [ ] Remove layout-thrashing filter and box-shadow transitions.
- [ ] Implement `prefers-reduced-motion` and `html[data-motion="on"]` overrides (disabling rotation, simplifying to subtle opacity transition).

### Task 3: Comprehensive Test Suite & Edge Case Verification

**Files:**
- Modify: `src/features/lyrics/LyricsView.test.tsx`

- [ ] Add unit tests asserting:
  - Spring physics is disabled on player initialization.
  - Staggered playback delay is disabled.
  - Word synchronization clock and line seek handlers operate with exact accuracy.
  - Active and inactive lines receive expected CSS classes and styles.
  - Reduced motion override is handled properly.
- [ ] Run full test suite to guarantee zero regressions across all 29 test files.

### Task 4: Build & Performance Verification

**Files:**
- Run commands: typecheck, build, test, dev preview.

- [ ] Run `npm run typecheck` to verify complete type safety.
- [ ] Run `npm run build` to verify production bundle generation.
- [ ] Verify runtime behavior in the browser environment.
