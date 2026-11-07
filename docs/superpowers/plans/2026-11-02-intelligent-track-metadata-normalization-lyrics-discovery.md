# Intelligent Track Metadata Normalization & Lyrics Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a robust metadata normalization layer and intelligent lyrics discovery strategy in Gmusic so that tracks with noisy video descriptions, reversed artist/title ordering, missing delimiters, or noisy filenames are correctly identified and matched with their canonical lyrics without regressing offline-first behavior or lyrics quality.

**Architecture:** A pure, on-device metadata normalization pipeline analyzes raw tags and filenames, strips non-musical video/release noise while preserving meaningful version descriptors (Live, Acoustic, Remix), and generates prioritized canonical identity candidates. The lyrics resolution engine executes a multi-stage search strategy (Stage A: Exact, Stage B: Structured search, Stage C: Deduplicated alternative queries) with configurable candidate scoring (40% title, 35% artist, 15% duration, 10% album), version distinction checks, and real-time UI resolution phase feedback.

**Tech Stack:** TypeScript, React 19, Zustand, Vitest, IndexedDB (fake-indexeddb).

**Spec:** PRD: Intelligent Track Metadata Normalization & Lyrics Discovery

## Global Constraints

- Preserve existing offline-first behavior, local privacy, audio correctness, and data integrity (rules.md §1, §4).
- No external network dependency for core local player functions (rules.md §4, §11).
- Preserve lyrics quality priority: Word-synchronized > Line-synchronized > Plain lyrics (PRD §6). Never overwrite higher quality with lower quality.
- Do not destroy legitimate title information or version identifiers (Remix, Acoustic, Live, Radio Edit, feat. credits) during cleaning (PRD §2).
- Duration is a compatibility signal, not an absolute rejection rule (PRD §5).
- Maintain compatibility with LRCmux and LRCLIB APIs and existing AMLL word-by-word player (PRD §6).

## Review Focus

1. `Billie Eilish - Ocean Eyes (Dance Performance Video)` with 215s duration matches LRCLIB's 200s studio recording without 404 or duration rejection.
2. `Ocean Eyes - Billie Eilish` (reversed order) resolves to Title: `Ocean Eyes`, Artist: `Billie Eilish` and matches lyrics without getting stuck.
3. `Ocean Eyes (Live Acoustic) - Billie Eilish` preserves `(Live Acoustic)` and does NOT auto-accept studio version lyrics.
4. Ambiguous song title (e.g., "Hello") by different artists rejects mismatched artist candidates.
5. Importing audio immediately initiates background metadata normalization and lyrics discovery when auto-fetch is enabled.

---

### Task 1: Dedicated Metadata Normalization Module

**Files:**
- Create: `src/services/metadata/normalization.ts`
- Create: `src/services/metadata/normalization.test.ts`

- [ ] Write tests in `src/services/metadata/normalization.test.ts` for noise stripping (Video, Dance Performance, Lyrics, Audio, Visualizer, HD, 4K, Topic, Remastered release descriptors).
- [ ] Write tests for version qualifier preservation (Remix, Acoustic, Live, Radio Edit, feat. credits).
- [ ] Write tests for delimiter parsing (` - `, ` — `, ` – `, ` | `, ` ~ `, ` _ `, ` // `) and delimiter-less extraction.
- [ ] Write tests for artist/title ordering detection (Artist - Title vs Title - Artist) with and without library context.
- [ ] Implement `cleanNoiseFromText`, `extractVersionQualifiers`, `extractArtistAndTitle`, and `normalizeTrackMetadata` in `src/services/metadata/normalization.ts`.
- [ ] Run vitest to ensure all normalization unit tests pass.

---

### Task 2: Candidate Matching & Scoring Upgrade

**Files:**
- Modify: `src/services/lyrics/matching.ts`
- Modify: `src/services/lyrics/matching.test.ts`

- [ ] Update scoring weights in `src/services/lyrics/matching.ts` to PRD §5 specifications: Title 40%, Artist 35%, Duration 15%, Album 10%.
- [ ] Update decision thresholds: Strong match (90–100), Validated match (80–89, requiring title >= 0.85 and artist >= 0.85), Candidate (>= 40), below 80 continuing search without auto-accept.
- [ ] Update duration scoring from hard 20s cutoff to a smooth compatibility signal accounting for video intros/outros/edits.
- [ ] Implement primary artist extraction and featured artist matching.
- [ ] Implement version qualifier mismatch check (Case D): penalize/reject auto-acceptance of studio recordings onto alternate (Live/Acoustic/Remix) versions.
- [ ] Update tests in `src/services/lyrics/matching.test.ts` to verify the new scoring, version protection, and alias matching while ensuring existing test cases pass.
- [ ] Run vitest to ensure all matching tests pass.

---

### Task 3: Intelligent LRCLIB / LRCmux Multi-Stage Search Strategy

**Files:**
- Modify: `src/services/lyrics/lyricsService.ts`
- Modify: `src/services/lyrics/lyricsService.discovery.test.ts`

- [ ] Incorporate `normalizeTrackMetadata` at the start of `resolveLyrics` and `resolveLyricsForTrack`.
- [ ] Implement Stage A: Exact lookup via `/get` with normalized track and artist; fallback without duration if 404 occurs.
- [ ] Implement Stage B: Structured search via `/search` with normalized track and artist, evaluating candidates with `rankCandidates`.
- [ ] Implement Stage C: Alternative query generation (swapped title/artist, cleaned title, original title, primary artist, or query `q`), with request deduplication (`seenQueries`).
- [ ] Support reporting resolution progress phases (`"identifying"`, `"searching"`, `"validating"`).
- [ ] Add caching for normalized track identities (`normalizedMetadataCache`).
- [ ] Add unit tests in `src/services/lyrics/lyricsService.discovery.test.ts` verifying Stage A, Stage B, and Stage C behavior, swapped order resolution, and noise tolerance.
- [ ] Run vitest to verify all discovery tests pass.

---

### Task 4: UI Resolution Phase & State Differentiating

**Files:**
- Modify: `src/stores/lyricsStore.ts`
- Modify: `src/features/lyrics/LyricsView.tsx`
- Modify: `src/stores/lyricsStore.test.ts`

- [ ] Add `phase: ResolutionPhase` (`"idle" | "identifying" | "searching" | "validating" | "ready" | "not-found" | "error" | "offline"`) to `useLyricsStore`.
- [ ] Wire `resolveForTrack` to update `phase` during track identification, searching, and validation.
- [ ] Update `LyricsView.tsx` to display distinct messages for each phase ("Identifying track…", "Searching lyrics…", "Validating lyrics…", "Lyrics found", "No reliable match found").
- [ ] Ensure "No lyrics yet" is never shown prematurely while any resolution phase is running.
- [ ] Run vitest to verify `lyricsStore.test.ts` and `LyricsView.test.tsx` pass.

---

### Task 5: Import Pipeline Integration & Auto-Discovery on Import

**Files:**
- Modify: `src/services/library/importService.ts`
- Modify: `src/stores/libraryStore.ts`
- Modify: `src/services/library/importService.test.ts`

- [ ] In `importAudioItems`, apply `normalizeTrackMetadata` when tags are missing or when tags contain video noise, setting clean `title` and `artist` while preserving original `fileName`.
- [ ] In `importItems`, trigger asynchronous lyrics resolution for newly added tracks when `prefs.autoFetchLyrics` is enabled.
- [ ] Ensure `importService.test.ts` passes and add tests verifying metadata cleaning on import.

---

### Task 6: Mandatory PRD Test Cases & Full Verification

**Files:**
- Create: `src/services/lyrics/mandatoryCases.test.ts`

- [ ] Implement tests in `src/services/lyrics/mandatoryCases.test.ts` for all 6 mandatory cases:
  - Case A: `Billie Eilish - Ocean Eyes (Dance Performance Video)`
  - Case B: `Ocean Eyes - Billie Eilish` (reversed metadata)
  - Case C: `Billie Eilish - Ocean Eyes [Official Music Video] HD` (noisy metadata)
  - Case D: `Ocean Eyes (Live Acoustic) - Billie Eilish` (legitimate alternate version distinction)
  - Case E: Ambiguous title shared by multiple artists
  - Case F: Missing metadata audio with meaningful filename
- [ ] Run complete test suite (`npm test`), type check (`npm run typecheck`), and lint (`npm run lint`).
- [ ] Verify production build (`npm run build`).
