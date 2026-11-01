import { create } from "zustand";
import type { PlaybackContext, RepeatMode, Track } from "../types";
import { clamp } from "../utils/misc";
import {
  appendToQueue,
  clearUpcoming,
  insertNext,
  moveQueueItem,
  nextIndex,
  previousIndex,
  removeQueueAt,
  shuffledQueue,
} from "../features/player/queue";
import { invalidatePlayUrl } from "../services/cloud/r2StorageService";
import {
  AutoplayBlockedError,
  describeMediaError,
  type AudioEngine,
  HtmlAudioEngine,
  type EngineEvents,
  type MediaFailure,
} from "../services/audio/engine";
import { regainHandleAccess, resolveTrackSource } from "../services/file-access/FileAccessService";

/**
 * PlaybackStore — the single global playback state (PRD §7.6). One audio
 * element owned by one engine; the audio clock is the timing authority.
 */

export type PlaybackStatus = "idle" | "loading" | "ready" | "error" | "ended";

export type PlaybackErrorInfo = {
  title: string;
  detail: string;
  /** Suggested user action, when one exists. */
  action: "grant-permission" | "relink" | "retry" | "none";
};

type PlaybackState = {
  currentTrackId: string | null;
  currentTimeMs: number;
  durationMs: number | null;
  isPlaying: boolean;
  isBuffering: boolean;
  volume: number;
  isMuted: boolean;
  shuffleEnabled: boolean;
  repeatMode: RepeatMode;
  queueTrackIds: string[];
  queueIndex: number;
  contextTrackIds: string[];
  context: PlaybackContext | null;
  status: PlaybackStatus;
  error: PlaybackErrorInfo | null;
  autoplayBlocked: boolean;
  /** Short human sentence for the polite aria-live region (rules §11). */
  announcement: string;

  // Internal engine plumbing (not for direct UI consumption)
  engine: AudioEngine | null;
};

type PlaybackActions = {
  init(): void;
  setEngineForTests(engine: AudioEngine): void;
  getEngine(): AudioEngine;

  playContext(trackIds: string[], startIndex: number, context: PlaybackContext): void;
  playTrackFromContext(trackId: string, contextTrackIds: string[], context: PlaybackContext): void;
  startTrack(trackId: string, options?: { startPositionMs?: number; autoplay?: boolean; requestPermission?: boolean }): Promise<void>;
  togglePlay(): void;
  play(): void;
  pause(): void;
  next(userInitiated: boolean): void;
  previous(): void;
  seek(ms: number): void;
  seekBy(deltaMs: number): void;
  /** Re-reads the audio clock into the store — used when the tab becomes
   * visible again and before persisting, so displays and saved positions
   * never lag behind real playback. */
  syncFromEngine(): void;
  setVolume(volume: number): void;
  toggleMute(): void;
  toggleShuffle(): void;
  cycleRepeat(): void;
  playNext(trackId: string): void;
  enqueue(trackId: string): void;
  removeFromQueue(index: number): void;
  moveInQueue(from: number, to: number): void;
  clearUpcomingQueue(): void;
  clearQueueKeepCurrent(): void;
  dismissAutoplayNotice(): void;
  clearError(): void;

  // Engine event sinks
  handleEngineEnded(): void;
  handleEngineError(failure: MediaFailure): void;

  // Restoration
  restoreQueue(payload: {
    queueTrackIds: string[];
    queueIndex: number;
    contextTrackIds: string[];
    context: PlaybackContext | null;
    currentTrackId: string;
    positionMs: number;
  }): void;
};

export type PlaybackStore = PlaybackState & PlaybackActions;

const SEEK_PREVIOUS_THRESHOLD_MS = 3000;

let loadToken = 0;
let pendingSeekMs: number | null = null;

/**
 * Generation-based stale-event guard. `acceptedSourceGeneration` is the
 * engine generation the store currently believes the element's source is on
 * (or the one the in-flight startTrack is about to load). A media error
 * whose generation differs belongs to a replaced source and must never
 * affect the current track (PRD §7.6: one shared element, no stale races).
 */
let acceptedSourceGeneration: number | null = null;

function expectNextSourceGeneration(): number | null {
  const engine = usePlaybackStore.getState().engine;
  return typeof engine?.sourceGeneration === "number" ? engine.sourceGeneration + 1 : null;
}

function recordActiveSourceGeneration(): void {
  const engine = usePlaybackStore.getState().engine;
  acceptedSourceGeneration = typeof engine?.sourceGeneration === "number" ? engine.sourceGeneration : null;
}

function makeEngineEvents(get: () => PlaybackStore): EngineEvents {
  return {
    onTimeUpdate: (sec) => {
      // While a new source is still loading, a trailing timeupdate from the
      // previous source would poison the fresh track's position.
      if (usePlaybackStore.getState().status === "loading") return;
      usePlaybackStore.setState({ currentTimeMs: sec * 1000 });
    },
    onDurationChange: (sec) => {
      // Apply a one-time resume seek once duration is known.
      if (pendingSeekMs !== null) {
        const seekMs = pendingSeekMs;
        pendingSeekMs = null;
        get().getEngine().seekSec(seekMs / 1000);
        usePlaybackStore.setState({ currentTimeMs: seekMs });
      }
      usePlaybackStore.setState({ durationMs: sec !== null ? sec * 1000 : null });
    },
    onPlayStateChange: (isPlaying) => {
      if (isPlaying) {
        usePlaybackStore.setState({ isPlaying: true, autoplayBlocked: false, status: "ready" });
      } else if (usePlaybackStore.getState().status !== "loading") {
        usePlaybackStore.setState({ isPlaying: false });
      }
    },
    onBufferingChange: (isBuffering) => {
      usePlaybackStore.setState({ isBuffering });
    },
    // A completed seek is the moment of truth: re-read the element so a
    // clamped or dropped seek can never leave the store showing a position
    // the audio is not actually at.
    onSeeked: () => get().syncFromEngine(),
    onEnded: () => get().handleEngineEnded(),
    onError: (failure) => get().handleEngineError(failure),
  };
}

function describeFailureForTrack(failure: MediaFailure, track: Track | undefined): PlaybackErrorInfo {
  if (failure.code === 4) {
    return {
      title: track ? `Can't play "${track.title}"` : "Unsupported audio",
      detail: `${describeMediaError(failure.code)} You can keep the track in your library, but this browser cannot decode it.`,
      action: "none",
    };
  }
  if (failure.code === 3) {
    return {
      title: track ? `Couldn't decode "${track.title}"` : "Decoding failed",
      detail: describeMediaError(failure.code),
      action: "relink",
    };
  }
  if (failure.code === 2 && track?.objectKey) {
    return {
      title: track ? `Couldn't load "${track.title}" from the cloud` : "Network error",
      detail: "The playback link may have expired or the connection dropped. Try again — a fresh link is fetched automatically.",
      action: "retry",
    };
  }
  return {
    title: "Playback problem",
    detail: describeMediaError(failure.code),
    action: "none",
  };
}

/**
 * Re-resolves the current track with a guaranteed-fresh cloud URL after a
 * network-class failure, resuming at the position the clock last reported.
 * Bounded to one attempt per track start so a genuinely unreachable source
 * surfaces as an error rather than a loop.
 */
async function retryWithFreshSource(): Promise<void> {
  const state = usePlaybackStore.getState();
  const track = playbackHelpers.currentTrack();
  if (!track) return;
  if (!track.objectKey) return;
  if (!state.isPlaying && state.status !== "error") return;

  invalidatePlayUrl(track.objectKey);
  const resolved = await resolveTrackSource({ ...track });
  if (!resolved.ok) return; // let the existing error stand

  const resumeAtMs = state.currentTimeMs;
  const engine = state.getEngine();
  engine.setSource(resolved.url);
  recordActiveSourceGeneration();
  if (state.isPlaying) {
    try {
      await engine.play();
      if (resumeAtMs > 0) engine.seekSec(resumeAtMs / 1000);
      usePlaybackStore.setState({ status: "ready", error: null });
    } catch {
      // Fall back to the paused state with the source loaded.
      usePlaybackStore.setState({ status: "ready" });
    }
  }
}

export const usePlaybackStore = create<PlaybackStore>((set, get) => ({
  currentTrackId: null,
  currentTimeMs: 0,
  durationMs: null,
  isPlaying: false,
  isBuffering: false,
  volume: 0.9,
  isMuted: false,
  shuffleEnabled: false,
  repeatMode: "off",
  queueTrackIds: [],
  queueIndex: -1,
  contextTrackIds: [],
  context: null,
  status: "idle",
  error: null,
  autoplayBlocked: false,
  announcement: "",
  engine: null,

  init: () => {
    const engine = get().getEngine();
    engine.setVolume(get().volume);
    engine.setMuted(get().isMuted);
  },

  setEngineForTests: (engine) => {
    const current = get().engine;
    current?.dispose();
    acceptedSourceGeneration = null; // fresh engine, fresh generation space
    set({ engine });
  },

  getEngine: () => {
    let engine = get().engine;
    if (!engine) {
      engine = new HtmlAudioEngine(makeEngineEvents(get));
      engine.setVolume(get().volume);
      engine.setMuted(get().isMuted);
      acceptedSourceGeneration = null;
      set({ engine });
    }
    return engine;
  },

  playContext: (trackIds, startIndex, context) => {
    if (trackIds.length === 0) return;
    const state = get();
    const first = trackIds[startIndex] ?? trackIds[0];
    if (state.shuffleEnabled) {
      const queue = shuffledQueue(trackIds, first);
      set({ contextTrackIds: trackIds, context, queueTrackIds: queue, queueIndex: 0 });
    } else {
      set({ contextTrackIds: trackIds, context, queueTrackIds: [...trackIds], queueIndex: startIndex });
    }
    void get().startTrack(first, { autoplay: true });
  },

  playTrackFromContext: (trackId, contextTrackIds, context) => {
    const index = contextTrackIds.indexOf(trackId);
    get().playContext(contextTrackIds, Math.max(0, index), context);
  },

  startTrack: async (trackId, options) => {
    const token = ++loadToken;
    // From this moment, any media event from the still-loaded previous
    // source is stale: this attempt owns the engine's next generation.
    acceptedSourceGeneration = expectNextSourceGeneration();
    const { autoplay = true, startPositionMs, requestPermission } = options ?? {};
    pendingSeekMs = startPositionMs ?? null;
    // Any explicit start consumes a pending session-resume so a later Play
    // cannot resurrect a stale position for a different attempt.
    pendingResumeMs = null;
    set({
      currentTrackId: trackId,
      status: "loading",
      error: null,
      isPlaying: false,
      currentTimeMs: startPositionMs ?? 0,
      durationMs: null,
    });

    const { getTrackForPlayback } = playbackHelpers;
    const track = await getTrackForPlayback(trackId);
    if (token !== loadToken) return; // user moved on before resolution finished

    if (!track) {
      pendingSeekMs = null; // don't leak this resume seek onto a later track
      set({ status: "error", error: { title: "Track not found", detail: "This track is no longer in your library.", action: "none" } });
      return;
    }

    // A permission re-request must happen inside the user gesture that
    // triggered this start (Chromium requires activation for the prompt).
    if (requestPermission) {
      const regained = await regainHandleAccess(track);
      if (token !== loadToken) return;
      if (regained === "denied") {
        set({
          status: "error",
          isPlaying: false,
          error: {
            title: `Access not granted for "${track.title}"`,
            detail: "The browser did not grant file access. Press play to try again, or re-link the file from its ⋯ menu.",
            action: "grant-permission",
          },
        });
        void playbackHelpers.markTrackAvailability(track.id, "permission-required");
        return;
      }
    }

    const resolved = await playbackHelpers.resolveSource(track);
    if (token !== loadToken) return;

    if (!resolved.ok) {
      pendingSeekMs = null; // don't leak this resume seek onto a later track
      const action =
        resolved.reason === "permission-required"
          ? "grant-permission"
          : resolved.reason === "missing"
            ? "relink"
            : "none";
      set({
        status: "error",
        isPlaying: false,
        error: { title: `Can't play "${track.title}"`, detail: resolved.detail, action },
      });
      if (resolved.reason === "permission-required" || resolved.reason === "missing") {
        void playbackHelpers.markTrackAvailability(track.id, resolved.reason);
      } else if (resolved.reason === "offline") {
        void playbackHelpers.markTrackAvailability(track.id, "offline");
      }
      return;
    }

    const engine = get().getEngine();
    engine.setSource(resolved.url);
    recordActiveSourceGeneration();

    // A successful resolution is the ground truth for availability: if an
    // earlier attempt (or a stale startup check) marked the track missing or
    // permission-required but a fallback source just played, heal the badge.
    void playbackHelpers.markTrackAvailability(track.id, "available");

    void playbackHelpers.notifyTrackStarted(trackId);

    if (autoplay) {
      try {
        await engine.play();
        if (token !== loadToken) return;
        set({
          isPlaying: true,
          status: "ready",
          announcement: `Playing ${track.title} by ${track.artist || "unknown artist"}`,
        });
      } catch (error) {
        if (token !== loadToken) return;
        if (error instanceof AutoplayBlockedError) {
          set({
            autoplayBlocked: true,
            isPlaying: false,
            status: "ready",
            announcement: "Playback blocked by the browser. Press play to start.",
          });
        } else if (error instanceof DOMException && error.name === "AbortError") {
          // play() was interrupted by a load() or pause() — a transition, not
          // a playback failure. The element's own events keep state honest.
          set({ isPlaying: false, status: "ready" });
        } else {
          get().handleEngineError({ code: 0, message: error instanceof Error ? error.message : String(error) });
        }
      }
    } else {
      set({ status: "ready" });
    }
  },

  togglePlay: () => {
    const state = get();
    if (!state.currentTrackId) return;
    if (state.isPlaying) {
      get().pause();
    } else {
      get().play();
    }
  },

  play: () => {
    const state = get();
    if (!state.currentTrackId) return;
    // An errored track must never fall through to a stale engine source.
    // Instead Play re-attempts the failed track — the problem may have been
    // fixed since (file re-linked, access granted, copy stored). A repeat
    // failure simply refreshes the error state.
    if (state.status === "error") {
      void get().startTrack(state.currentTrackId, {
        autoplay: true,
        requestPermission: state.error?.action === "grant-permission",
      });
      return;
    }
    // A restored session has queue state but no loaded source yet; the first
    // explicit play re-resolves the file and resumes at the saved position.
    if (peekPendingResume() !== null) {
      const positionMs = consumePendingResume();
      void get().startTrack(state.currentTrackId, { autoplay: true, startPositionMs: positionMs ?? undefined });
      return;
    }
    const engine = state.getEngine();
    set({ isPlaying: true, autoplayBlocked: false });
    void engine
      .play()
      .then(() => {
        set({ isPlaying: true, autoplayBlocked: false });
      })
      .catch((error: unknown) => {
        if (error instanceof AutoplayBlockedError) {
          set({ isPlaying: false, autoplayBlocked: true, announcement: "Playback blocked by the browser. Press play to start." });
        } else if (error instanceof DOMException && error.name === "AbortError") {
          // play() interrupted by a load()/pause() — a transition, not a
          // failure (e.g. pressing Play then Pause in quick succession).
          set({ isPlaying: false });
        } else {
          get().handleEngineError({ code: 0, message: error instanceof Error ? error.message : String(error) });
        }
      });
  },

  pause: () => {
    const state = get();
    if (!state.currentTrackId) return;
    state.getEngine().pause();
    set({ isPlaying: false });
    void playbackHelpers.persistPosition();
  },

  next: (userInitiated) => {
    const state = get();
    const queueShape = {
      queueTrackIds: state.queueTrackIds,
      queueIndex: state.queueIndex,
      repeatMode: userInitiated && state.repeatMode === "one" ? "all" : state.repeatMode,
    };
    const target = nextIndex(queueShape);
    if (target === null) {
      state.getEngine().pause();
      set({ isPlaying: false, status: "ended" });
      return;
    }
    set({ queueIndex: target });
    void get().startTrack(state.queueTrackIds[target], { autoplay: true });
  },

  previous: () => {
    const state = get();
    if (state.currentTimeMs > SEEK_PREVIOUS_THRESHOLD_MS) {
      get().seek(0);
      return;
    }
    const target = previousIndex({
      queueTrackIds: state.queueTrackIds,
      queueIndex: state.queueIndex,
      repeatMode: state.repeatMode,
    });
    if (target === null) return;
    if (target === state.queueIndex) {
      get().seek(0);
      return;
    }
    set({ queueIndex: target });
    void get().startTrack(state.queueTrackIds[target], { autoplay: true });
  },

  seek: (ms) => {
    const state = get();
    if (!state.currentTrackId || state.durationMs === null) return;
    const clamped = clamp(ms, 0, state.durationMs);
    state.getEngine().seekSec(clamped / 1000);
    set({ currentTimeMs: clamped });
    void playbackHelpers.persistPosition();
  },

  seekBy: (deltaMs) => {
    const state = get();
    get().seek(state.currentTimeMs + deltaMs);
  },

  syncFromEngine: () => {
    const state = get();
    if (!state.currentTrackId || state.status !== "ready") return;
    const engine = state.getEngine();
    if (!engine.element) return;
    const engineMs = engine.currentTimeSec * 1000;
    // Only correct meaningful drift: timeupdate already keeps this fresh.
    if (Math.abs(engineMs - state.currentTimeMs) > 750) {
      usePlaybackStore.setState({ currentTimeMs: engineMs });
    }
  },

  setVolume: (volume) => {
    const clamped = clamp(volume, 0, 1);
    get().getEngine().setVolume(clamped);
    set({ volume: clamped });
    if (clamped > 0 && get().isMuted) {
      get().getEngine().setMuted(false);
      set({ isMuted: false });
    }
    void playbackHelpers.persistPrefs();
  },

  toggleMute: () => {
    const muted = !get().isMuted;
    get().getEngine().setMuted(muted);
    set({ isMuted: muted });
    void playbackHelpers.persistPrefs();
  },

  toggleShuffle: () => {
    const state = get();
    const enabled = !state.shuffleEnabled;
    if (!state.contextTrackIds.length) {
      set({ shuffleEnabled: enabled });
      void playbackHelpers.persistPrefs();
      return;
    }
    if (enabled) {
      const queue = shuffledQueue(state.contextTrackIds, state.currentTrackId);
      set({ shuffleEnabled: true, queueTrackIds: queue, queueIndex: queue.indexOf(state.currentTrackId ?? "") });
    } else {
      const queue = [...state.contextTrackIds];
      set({ shuffleEnabled: false, queueTrackIds: queue, queueIndex: Math.max(0, queue.indexOf(state.currentTrackId ?? "")) });
    }
    void playbackHelpers.persistPrefs();
  },

  cycleRepeat: () => {
    const order: RepeatMode[] = ["off", "all", "one"];
    const current = get().repeatMode;
    const nextMode = order[(order.indexOf(current) + 1) % order.length];
    set({ repeatMode: nextMode });
    void playbackHelpers.persistPrefs();
  },

  playNext: (trackId) => {
    const state = get();
    if (!state.currentTrackId) {
      // Nothing playing yet: start a queue seeded with just this track.
      set({
        queueTrackIds: [trackId],
        queueIndex: 0,
        contextTrackIds: [trackId],
        context: { type: "queue", label: "Queue" },
      });
      void get().startTrack(trackId, { autoplay: true });
      return;
    }
    const result = insertNext(state.queueTrackIds, state.queueIndex, trackId);
    set({ queueTrackIds: result.queueTrackIds, queueIndex: result.queueIndex });
  },

  enqueue: (trackId) => {
    const state = get();
    if (!state.currentTrackId) {
      get().playNext(trackId);
      return;
    }
    set({ queueTrackIds: appendToQueue(state.queueTrackIds, trackId) });
  },

  removeFromQueue: (index) => {
    const state = get();
    const result = removeQueueAt(state.queueTrackIds, state.queueIndex, index);
    set({ queueTrackIds: result.queueTrackIds, queueIndex: result.queueIndex });
  },

  moveInQueue: (from, to) => {
    const state = get();
    const result = moveQueueItem(state.queueTrackIds, state.queueIndex, from, to);
    set({ queueTrackIds: result.queueTrackIds, queueIndex: result.queueIndex });
  },

  clearUpcomingQueue: () => {
    set({ queueTrackIds: clearUpcoming(get().queueTrackIds, get().queueIndex) });
  },

  clearQueueKeepCurrent: () => {
    const state = get();
    const current = state.queueTrackIds[state.queueIndex];
    if (!current) return;
    set({ queueTrackIds: [current], queueIndex: 0 });
  },

  dismissAutoplayNotice: () => set({ autoplayBlocked: false }),

  clearError: () => set({ error: null }),

  handleEngineEnded: () => {
    const state = get();
    if (state.repeatMode === "one") {
      state.getEngine().seekSec(0);
      void state.getEngine().play().catch(() => {
        set({ autoplayBlocked: true });
      });
      return;
    }
    // Landed on the true final position before deciding what's next, so the
    // bar rests at the end by construction instead of jumping there.
    get().syncFromEngine();
    get().next(false);
  },

  handleEngineError: (failure) => {
    // Code 1 (MEDIA_ERR_ABORTED) is how the shared element reports a load
    // aborted by the next setSource — a transition, never a failure. The
    // new source reports its own outcome.
    if (failure.code === 1) return;
    // Stale media event: the engine has already moved past the source this
    // failure belongs to, so it must not touch the current track's state.
    const engine = get().engine;
    if (
      engine?.sourceGeneration !== undefined &&
      acceptedSourceGeneration !== null &&
      engine.sourceGeneration !== acceptedSourceGeneration
    ) {
      return;
    }
    const track = playbackHelpers.currentTrack();
    loadToken += 1; // invalidate any in-flight loads
    set({
      isPlaying: false,
      status: "error",
      error: describeFailureForTrack(failure, track),
    });
    // A network failure on a cloud track is often just an expired signed URL.
    // One automatic refresh keeps playback alive; a second failure surfaces.
    if (failure.code === 2 && track?.objectKey) {
      void retryWithFreshSource();
    }
  },

  restoreQueue: ({ queueTrackIds, queueIndex, contextTrackIds, context, currentTrackId, positionMs }) => {
    if (!queueTrackIds.includes(currentTrackId)) return;
    loadToken += 1;
    pendingSeekMs = null;
    set({
      queueTrackIds,
      queueIndex,
      contextTrackIds,
      context,
      currentTrackId,
      currentTimeMs: positionMs,
      isPlaying: false,
      status: "ready",
    });
    // Remember the resume position without starting audio (autoplay needs a gesture).
    pendingResumeMs = positionMs;
  },
}));

/** Resume position captured by restoreQueue; consumed by the next explicit play(). */
let pendingResumeMs: number | null = null;

export function consumePendingResume(): number | null {
  const value = pendingResumeMs;
  pendingResumeMs = null;
  return value;
}

export function peekPendingResume(): number | null {
  return pendingResumeMs;
}

/**
 * Helpers that need other stores/repositories. Assigned at module load to keep
 * the playback store free of import cycles with the library store.
 */
const playbackHelpers: {
  getTrackForPlayback: (id: string) => Promise<Track | undefined>;
  currentTrack: () => Track | undefined;
  notifyTrackStarted: (trackId: string) => Promise<void>;
  markTrackAvailability: (
    trackId: string,
    availability: "available" | "permission-required" | "missing" | "offline",
  ) => Promise<void>;
  persistPrefs: () => void;
  persistPosition: () => void;
  resolveSource: typeof resolveTrackSource;
} = {
  getTrackForPlayback: async () => undefined,
  currentTrack: () => undefined,
  notifyTrackStarted: async () => undefined,
  markTrackAvailability: async () => undefined,
  persistPrefs: () => undefined,
  persistPosition: () => undefined,
  resolveSource: resolveTrackSource,
};

export function bindPlaybackHelpers(helpers: Partial<typeof playbackHelpers>): void {
  Object.assign(playbackHelpers, helpers);
}
