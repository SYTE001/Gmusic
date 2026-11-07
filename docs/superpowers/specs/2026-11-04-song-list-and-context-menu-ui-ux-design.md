# Song List and Context Menu UI/UX Design

## 1. Intent & Context
Improve UI/UX alignment, component hierarchy, layering, and visual polish for the Song List (`TrackRow.tsx`) and Three-Dot Context Menu (`Menu.tsx`) following Apple-inspired minimalism: clean, precise, solid, and polished.

## 2. Goals & Anti-Goals
### Goals
- **Precise Column Alignment**: Ensure artwork, title, artist, album, duration, favorite, and three-dot menu columns have consistent horizontal positions and proportional vertical alignments across all rows.
- **Layering & Portaling**: Render the context menu via a React Portal (`createPortal`) into `document.body` with `z-[100]` and fixed positioning so it is never clipped by `<main>`'s `overflow-y-auto` or hidden behind the persistent bottom music player (`MiniPlayer`).
- **Dynamic Positioning & Auto-Flip**: Compute bounding rect on open, automatically flip dropdown upward when approaching the bottom of the viewport, clamp within viewport edges, and close cleanly on outside click, scroll, or Escape key.
- **Visual Polish**: Solid Apple-inspired surface (`bg-[var(--surface)]` or `bg-[var(--surface-raised)]`), sharp 1px border (`var(--border-subtle)`), soft overlay shadow, consistent 16px icon slot alignment for each menu item, uniform button hitboxes (32x32px for both heart and three-dot), and smooth hover/active/focus states across dark and light modes.
- **Zero Regression**: Retain all existing keyboard shortcuts, accessibility ARIA attributes, playback, queue, playlist actions, and cloud/availability indicators.

### Non-Goals / Anti-Goals
- Do not add external UI libraries (Floating UI, Radix, Popper). Use standard React Portal and browser geometry APIs.
- Do not redesign unrelated pages, players, or settings.
- Do not introduce translucent glassmorphism or low-contrast borders.

## 3. Approaches Considered
- **Approach 1 (Selected)**: React Portal floating menu with dynamic viewport coordinates + structured flex-column track row layout.
  - *Trade-off*: Guaranteed to escape any parent clipping context, floats above the bottom player, zero extra dependencies, pixel-accurate alignment across all rows.
- **Approach 2 (Rejected)**: Pure CSS Grid with in-flow popover.
  - *Trade-off*: Unable to escape `overflow-y-auto` of `<main>` without browser popover APIs which fail in testing and older browsers.

## 4. Detailed Component Design

### 4.1 TrackRow Layout (`src/components/TrackRow.tsx`)
1. **Row Container**:
   - `flex items-center h-14 px-3 rounded-lg gap-3 transition-colors hover:bg-surface-hover`
   - Active/current track styling: `bg-surface-raised`
   - Role `listitem`, keyboard navigation and click to play preserved.
2. **Left Column (Song Identity - flex-1 min-w-0)**:
   - Index / Play affordance: `w-7 shrink-0 text-center flex items-center justify-center hidden sm:flex`
   - Artwork: `size-10 shrink-0 rounded-md`
   - Info block: `min-w-0 flex-1 flex flex-col justify-center`
     - Title row: `flex items-center gap-1.5`
     - Title: `text-sm font-medium truncate` (colored `text-accent` if current)
     - Badges: `shrink-0` (link icon, warning icon, cloud badge)
     - Artist: `text-xs text-text-secondary truncate`
3. **Album Column (Optional - fixed width)**:
   - `w-44 lg:w-48 xl:w-56 shrink-0 truncate text-xs text-text-secondary hidden md:block`
4. **Date Added Column (Optional - fixed width)**:
   - `w-24 shrink-0 text-right text-xs text-text-muted hidden xl:block`
5. **Trailing Action Cluster (fixed width - shrink-0)**:
   - `flex items-center justify-end gap-1 sm:gap-1.5 shrink-0`
   - Duration: `w-11 text-right text-xs tabular-nums text-text-muted shrink-0`
   - Favorite button: `size-8 inline-flex items-center justify-center rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors shrink-0` with `HeartIcon size={16}`
   - Menu button: `size-8 inline-flex items-center justify-center rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors shrink-0` with `MoreIcon size={16}`
   - Playlist reorder arrows / custom trailing nodes: attached seamlessly to the right without breaking column alignment.

### 4.2 Menu Component (`src/components/Menu.tsx`)
1. **Trigger**:
   - `size-8 inline-flex items-center justify-center rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors`
   - Accessible ARIA attributes (`aria-haspopup="menu"`, `aria-expanded`).
2. **Portal Overlay**:
   - Rendered using `createPortal(menuContent, document.body)`.
   - `position: fixed; z-index: 100;`
   - Coordinates calculated on trigger click via `triggerRef.current.getBoundingClientRect()`:
     - `spaceBelow = window.innerHeight - triggerRect.bottom - 8`
     - `spaceAbove = triggerRect.top - 8`
     - If `spaceBelow < 280 && spaceAbove > spaceBelow`: placement is `"top"` (`bottom = window.innerHeight - triggerRect.top + 6`), otherwise `"bottom"` (`top = triggerRect.bottom + 6`).
     - Right edge aligns with trigger right edge: `right = Math.max(8, window.innerWidth - triggerRect.right)`.
     - Clamped max height: `max-h-[min(380px, calc(100vh - 32px))]`.
3. **Visual Shell**:
   - Solid background: `bg-[var(--surface)]` or `bg-[var(--surface-raised)]` (100% solid, no blur/glass).
   - Border: `border border-[var(--border-subtle)]`
   - Shadow: deep elevation `shadow-[var(--shadow-overlay)]`
   - Radius: `rounded-xl`
   - Padding: `p-1.5`
4. **Item Consistency**:
   - Items: `flex items-center w-full gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors select-none text-left`
   - Fixed icon wrapper: `w-4 h-4 shrink-0 flex items-center justify-center text-text-muted`
   - Label: `flex-1 truncate`
   - Separator: `my-1 h-px bg-[var(--border-subtle)]`
   - Heading: `px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted`
   - Dismiss on outside pointerdown, Escape key, or window scroll/resize. Focus restoration to trigger on Escape.

## 5. Verification Plan
- Vitest unit tests (524 tests pass).
- TypeScript compile / Vite production build (`npm run build`).
- Verify context menu floats above bottom player and never gets clipped by scrolling containers.
- Verify row alignment consistency across Library, Liked Songs, Playlist Detail, and Recent pages in both light and dark themes.
