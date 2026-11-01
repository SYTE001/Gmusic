import { create } from "zustand";
import type { Track } from "../types";
import {
  attachLrclibRecord,
  resetLyricsCacheMeta,
  resolveLyricsForTrack,
} from "../services/lyrics/lyricsService";
import type { RankedCandidate } from "../services/lyrics/matching";
import { describeLrcmuxError } from "../services/lyrics/lrcmuxClient";
import { usePlaybackStore } from "./playbackStore";
import { useSettingsStore } from "./settingsStore";

/**
 * Lyrics discovery state (feature spec §1, §8). One resolution per track;
 * results from a previous track are never applied to the current one.
 */

export type DiscoveryStatus =
  | "idle" // nothing triggered yet
  | "checking" // cache miss, lrcmux lookup running
  | "ready" // lyrics available (attached, cached, or manual)
  | "needs-selection" // plausible candidates await the user's choice
  | "not-found" // no usable match
  | "offline" // device offline, nothing cached
  | "error"; // request failed

export type DiscoveryPhase =
  | "idle"
  | "identifying"
  | "searching"
  | "validating"
  | "ready"
  | "not-found"
  | "offline"
  | "error";

type LyricsState = {
  trackId: string | null;
  status: DiscoveryStatus;
  phase: DiscoveryPhase;
  /** Bumped whenever lyrics are written, so views reload the document. */
  lyricsVersion: number;
  candidates: RankedCandidate[];
  errorMessage: string | null;
  /** True when the currently shown lyrics came from the local cache/import. */
  fromCache: boolean;

  /** Resolves lyrics for a track (no-op when already resolved/resolving). */
  resolveForTrack: (track: Track, options?: { force?: boolean }) => Promise<void>;
  /** User picked a candidate from the chooser. */
  pickCandidate: (candidate: RankedCandidate) => Promise<void>;
  /** Retry after error/not-found; clears the negative cache for the track. */
  retry: (track: Track) => Promise<void>;
  clearCandidates: () => void;
  /** Force a fresh lookup even though lyrics exist (keeps manual records until replaced). */
  searchAgain: (track: Track) => Promise<void>;
};

export const useLyricsStore = create<LyricsState>((set, get) => {
  let activeController: AbortController | null = null;
  let resolutionToken = 0;

  const run = async (track: Track, force: boolean) => {
    const token = ++resolutionToken;
    activeController?.abort();
    activeController = new AbortController();
    const controller = activeController;

    set({
      trackId: track.id,
      status: "checking",
      phase: "identifying",
      candidates: [],
      errorMessage: null,
      fromCache: false,
    });

    try {
      const result = await resolveLyricsForTrack(track, {
        force,
        signal: controller.signal,
        onProgress: (phase) => {
          if (token === resolutionToken) {
            set({ phase });
          }
        },
      });
      if (token !== resolutionToken) return; // a newer resolution took over
      switch (result.outcome) {
        case "cached":
          set({ status: "ready", phase: "ready", fromCache: true });
          break;
        case "attached":
          set({ status: "ready", phase: "ready", fromCache: false, lyricsVersion: get().lyricsVersion + 1 });
          break;
        case "needs-selection":
          set({ status: "needs-selection", phase: "not-found", candidates: result.candidates });
          break;
        case "not-found":
        case "skipped-recently":
          set({ status: "not-found", phase: "not-found" });
          break;
        case "offline":
          set({ status: "offline", phase: "offline" });
          break;
        case "error":
          set({ status: "error", phase: "error", errorMessage: result.message });
          break;
      }
    } catch (error) {
      if (token !== resolutionToken) return;
      // Aborted resolutions belong to a superseded track; never surface them.
      if ((error as { kind?: string })?.kind === "aborted" || (error as DOMException)?.name === "AbortError") return;
      set({ status: "error", phase: "error", errorMessage: describeLrcmuxError(error) });
    }
  };

  return {
    trackId: null,
    status: "idle",
    phase: "idle",
    lyricsVersion: 0,
    candidates: [],
    errorMessage: null,
    fromCache: false,

    resolveForTrack: async (track, options) => {
      const state = get();
      const force = options?.force ?? false;
      // Deduplicate: same track already resolving or resolved → nothing to do,
      // unless the user explicitly asked for a fresh lookup. An "error" status
      // is terminal here too: re-running automatically would loop check→error
      // forever (the view re-triggers on every status change) and hammer the
      // provider. Recovery is user-initiated via retry()/searchAgain().
      if (!force && state.trackId === track.id && state.status !== "idle") return;
      await run(track, force);
    },

    pickCandidate: async (candidate) => {
      const trackId = get().trackId;
      if (!trackId) return;
      const track = trackLookup(trackId);
      if (!track) return;
      try {
        await attachLrclibRecord(track, candidate.record);
        set({ status: "ready", phase: "ready", candidates: [], lyricsVersion: get().lyricsVersion + 1, fromCache: false });
      } catch {
        set({ status: "error", phase: "error", errorMessage: "Could not save the selected lyrics." });
      }
    },

    retry: async (track) => {
      await resetLyricsCacheMeta(track.id);
      await run(track, true);
    },

    searchAgain: async (track) => {
      await run(track, true);
    },

    clearCandidates: () => set({ candidates: [] }),
  };
});

/**
 * Wired at startup so the lyrics store can resolve the current track without
 * importing the library store (avoids a cycle).
 */
let trackLookup: (id: string) => Track | undefined = () => undefined;

export function bindLyricsTrackLookup(lookup: (id: string) => Track | undefined): void {
  trackLookup = lookup;
}

/**
 * Auto-discovery bridge: when a track starts and the user allows online
 * lookups, ensure lyrics are resolved. Playback is never awaited or blocked.
 */
export function startLyricsPrefetch(): () => void {
  const maybeResolve = () => {
    const playback = usePlaybackStore.getState();
    if (!playback.currentTrackId) return;
    const track = trackLookup(playback.currentTrackId);
    if (!track) return;
    const { prefs } = useSettingsStore.getState();
    if (!prefs.autoFetchLyrics) return;
    void useLyricsStore.getState().resolveForTrack(track);
  };

  const unsubscribe = usePlaybackStore.subscribe((state, previous) => {
    if (state.currentTrackId !== previous.currentTrackId) maybeResolve();
  });
  return unsubscribe;
}
