# Song List and Context Menu UI/UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor Song List (`TrackRow.tsx`) and Three-Dot Context Menu (`Menu.tsx`) to achieve Apple-inspired minimalist aesthetics, consistent pixel-aligned column layouts, React Portal layering above the bottom player, and auto-flip positioning.

**Architecture:** 
1. `Menu.tsx` uses React `createPortal` to render directly into `document.body` with fixed coordinates computed from the trigger's `getBoundingClientRect()`, layered at `z-[100]` with auto-flip logic, escaping all parent `overflow` and stacking contexts.
2. `TrackRow.tsx` adopts an explicit column hierarchy (`flex-1 min-w-0` for title/artist, fixed widths for album, date, duration, and 32x32px buttons) guaranteeing identical horizontal and vertical alignment across all rows.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, Lucide / custom SVG Icons, Vitest, React Testing Library.

**Spec:** [`docs/superpowers/specs/2026-11-04-song-list-and-context-menu-ui-ux-design.md`](file:///C:/Users/User/documents/music/docs/superpowers/specs/2026-11-04-song-list-and-context-menu-ui-ux-design.md)

## Global Constraints
- Preserve all existing playback, queue, playlist, and cloud action functionality.
- No new npm dependencies; use native React Portal and DOM bounding rect geometry.
- Dark and light theme compatibility via CSS variables (`--surface`, `--border-subtle`, `--shadow-overlay`).
- Zero layout jitter across rows; identical button hit targets (32x32px) for favorite and menu.
- Full keyboard accessibility (Arrow keys, Enter, Escape, tabIndex).

## Review Focus
1. Dropdown opened near bottom of screen above bottom music player: must flip upward and render on top of `MiniPlayer` without clipping.
2. Long song titles with availability badges: title truncates with ellipsis without shifting album or duration columns.
3. Rapid clicking outside or pressing Escape: menu closes immediately and restores focus to trigger button without errors.
4. Window scrolling or resizing while menu is open: closes or repositions cleanly without leaving orphaned popovers.
5. Touch device / coarse pointer compatibility: hit targets remain comfortable without causing vertical layout shifts.

---

### Task 1: Portal-based Layering & Apple Polish in `Menu.tsx`

**Files:**
- Modify: `src/components/Menu.tsx`
- Create: `src/components/Menu.test.tsx`

**Interfaces:**
- Consumes: `MenuItemSpec` from `src/components/Menu.tsx`
- Produces: `export function Menu(props: { items: MenuItemSpec[] | (() => MenuItemSpec[]); buttonLabel: string; trigger?: ReactNode; onOpenChange?: (open: boolean) => void })`

- [ ] **Step 1: Write unit tests for Menu portal rendering, positioning, and keyboard interactions**

Create `src/components/Menu.test.tsx` verifying:
- Menu renders trigger button with `aria-haspopup="menu"`.
- Clicking trigger opens menu inside `document.body` portal.
- Clicking outside closes menu.
- Pressing Escape closes menu and restores trigger focus.
- ArrowDown / ArrowUp moves focus between menuitems.
- Visual classes include solid surface, border, and shadow.

- [ ] **Step 2: Run test to verify failure before implementation**

Run: `npx vitest run src/components/Menu.test.tsx`
Expected: FAIL (or tests fail due to missing portal assertions).

- [ ] **Step 3: Implement Portal & Visual Polish in `src/components/Menu.tsx`**

1. Import `createPortal` from `react-dom`.
2. Measure trigger `getBoundingClientRect()` on open and window resize/scroll.
3. Compute placement (`"top"` if `spaceBelow < 280 && spaceAbove > spaceBelow`, else `"bottom"`).
4. Compute fixed coords (`top`/`bottom`, `right`, clamped `maxHeight`).
5. Render dropdown into `createPortal(<div role="menu" className="fixed z-[100] ... surface-card ...">, document.body)`.
6. Style with solid background (`bg-surface`), crisp border (`border border-[var(--border-subtle)]`), deep overlay shadow (`shadow-[var(--shadow-overlay)]`), rounded-xl, padding 6px (`p-1.5`).
7. Standardize menu items with fixed 16px icon slot (`w-4 h-4 shrink-0 flex items-center justify-center text-text-muted`), 8px gap, text truncation, and smooth hover/active states.
8. Maintain Escape, arrow navigation, outside click, and window scroll listeners.

- [ ] **Step 4: Run test to verify Menu tests pass**

Run: `npx vitest run src/components/Menu.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit Task 1**

```bash
git add src/components/Menu.tsx src/components/Menu.test.tsx
git commit -m "feat: refactor Menu with React Portal, auto-flip positioning and solid Apple polish"
```

---

### Task 2: Song List Column Alignment & Proportional Layout in `TrackRow.tsx`

**Files:**
- Modify: `src/components/TrackRow.tsx`
- Create / Modify: `src/components/TrackRow.test.tsx`

**Interfaces:**
- Consumes: `Track`, `PlaybackContext` from `src/types`
- Consumes: `Menu` from `src/components/Menu`
- Produces: `TrackRow` memoized component with rock-solid column alignment

- [ ] **Step 1: Write tests for TrackRow column alignment and button dimensions**

Create or update `src/components/TrackRow.test.tsx` verifying:
- Renders track artwork, title, artist with consistent class structure.
- Renders duration, favorite button, and menu button with matching 32x32px size (`size-8`).
- Like button toggles like state without triggering row playback.
- Menu trigger opens menu without row playback.
- Album and date added render with expected fixed widths when enabled.

- [ ] **Step 2: Run test to verify failure or identify gaps**

Run: `npx vitest run src/components/TrackRow.test.tsx`

- [ ] **Step 3: Refactor `src/components/TrackRow.tsx`**

1. Replace loose grid layout with structured flex columns:
   - Row: `flex items-center h-14 px-3 rounded-lg gap-3 transition-colors hover:bg-surface-hover ${isCurrent ? 'bg-surface-raised' : ''}`.
   - Col 1 (Leading & Play/Index): `w-7 shrink-0 text-center flex items-center justify-center hidden sm:flex`.
   - Col 2 (Artwork): `size-10 shrink-0 rounded-md`.
   - Col 3 (Identity): `min-w-0 flex-1 flex flex-col justify-center` with title + badges on top line and artist on bottom line.
   - Col 4 (Album): `w-44 lg:w-48 xl:w-56 shrink-0 truncate text-xs text-text-secondary hidden md:block`.
   - Col 5 (Date Added): `w-24 shrink-0 text-right text-xs text-text-muted hidden xl:block`.
   - Col 6 (Trailing Action Cluster): `flex items-center justify-end gap-1 sm:gap-1.5 shrink-0`:
     - Duration: `w-11 text-right text-xs tabular-nums text-text-muted shrink-0`.
     - Favorite button: `size-8 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-hover flex items-center justify-center shrink-0` with `HeartIcon size={16}`.
     - Three-dot menu: `size-8 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-hover flex items-center justify-center shrink-0` with `MoreIcon size={16}`.
     - Custom trailing props (playlist reorder) seamlessly aligned.
2. Stop propagation on favorite and menu buttons so row playback is never accidentally triggered.

- [ ] **Step 4: Run test to verify TrackRow tests pass**

Run: `npx vitest run src/components/TrackRow.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit Task 2**

```bash
git add src/components/TrackRow.tsx src/components/TrackRow.test.tsx
git commit -m "feat: align TrackRow columns with fixed widths and uniform action buttons"
```

---

### Task 3: Full Integration, Theme & Build Verification

**Files:**
- Verify: `src/components/AppShell.tsx`
- Verify: `src/features/library/LibraryPage.tsx`
- Verify: `src/features/playlists/PlaylistDetailPage.tsx`
- Verify: `src/features/recent/RecentPage.tsx`
- Verify: `src/features/liked/LikedPage.tsx`

- [ ] **Step 1: Run full test suite across the entire application**

Run: `npm test`
Expected: PASS for all test files (524+ tests).

- [ ] **Step 2: Run production type check and build**

Run: `npm run build`
Expected: Production build compiles cleanly with zero TypeScript or asset errors.

- [ ] **Step 3: Verify light and dark mode CSS variable consistency**

Confirm dropdown tokens in `src/styles/base.css` resolve with 100% opacity, crisp contrast, and correct z-index in both themes.

- [ ] **Step 4: Commit Task 3**

```bash
git commit --allow-empty -m "chore: verify song list and context menu UI integration across views"
```
