import { summarizePlaybackError } from "../services/errors/summarizePlaybackError";
import { create } from "zustand";
import type { BrokenCategory, PlaybackContext, RepeatMode, Track } from "../types";
import { clamp } from "../utils/misc";
import { useDynamicIslandStore } from "./dynamicIslandStore";
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
import {
  clearPreloadedTrackSource,
  diagnoseTrackSource,
  preloadTrackSource,
  regainHandleAccess,
  releaseActiveTrackSource,
  resolveTrackSource,
} from "../services/file-access/FileAccessService";
import { perfMark, perfMeasure } from "../utils/perf";
import { MediaSessionController } from "../services/audio/mediaSession";
import { getArtworkUrl, loadArtworkUrl, subscribeArtwork } from "../services/artwork/artworkCache";

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
  startTrack(
    trackId: string,
    options?: { startPositionMs?: number; autoplay?: boolean; requestPermission?: boolean; queueIndex?: number; coalesce?: boolean },
  ): Promise<void>;
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
  syncFromEngine(exact?: boolean): void;
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
const RAPID_SKIP_COALESCE_WINDOW_MS = 35;
const RAPID_SKIP_DEBOUNCE_MS = 14;

let loadToken = 0;
let pendingSeekMs: number | null = null;
let lastStartTrackAt = 0;
let preloadedForTrackId: string | null = null;
let mediaSession: MediaSessionController | null = null;
let stopMediaSession: (() => void) | null = null;
let stopMediaArtwork: (() => void) | null = null;
let playRequestToken = 0;
let autoSourceRetryUsed = false;

function clearMediaArtwork(): void {
  stopMediaArtwork?.();
  stopMediaArtwork = null;
}

function syncMediaSession(): void {
  if (!mediaSession) return;
  const state = usePlaybackStore.getState();
  const engine = state.engine;
  const sourceIsCurrent = state.status !== "loading" || acceptedSourceGeneration === engine?.sourceGeneration;
  const duration = engine?.durationSec;
  mediaSession.syncPlayback(state.isPlaying, sourceIsCurrent && duration !== null && duration !== undefined
    ? { duration, position: engine?.currentTimeSec ?? 0, playbackRate: engine?.element?.playbackRate ?? 1 }
    : undefined);
}

function initMediaSession(): void {
  if (mediaSession) return;
  mediaSession = new MediaSessionController({
    play: () => usePlaybackStore.getState().play(),
    pause: () => usePlaybackStore.getState().pause(),
    previous: () => usePlaybackStore.getState().previous(),
    next: () => usePlaybackStore.getState().next(true),
    seek: (seconds) => usePlaybackStore.getState().seek(seconds * 1000),
    seekBy: (seconds) => usePlaybackStore.getState().seekBy(seconds * 1000),
  });
  stopMediaSession = usePlaybackStore.subscribe((state, previous) => {
    if (state.currentTrackId !== previous.currentTrackId || (state.status === "loading" && previous.status !== "loading")) {
      clearMediaArtwork();
      mediaSession?.clear();
    }
    if (!state.currentTrackId) {
      if (previous.currentTrackId) {
        clearMediaArtwork();
        mediaSession?.clear();
      }
      return;
    }
    if (state.isPlaying !== previous.isPlaying || state.status !== previous.status ||
      state.durationMs !== previous.durationMs || state.currentTimeMs !== previous.currentTimeMs) {
      syncMediaSession();
    }
  });
}

function disposeMediaSession(): void {
  clearMediaArtwork();
  stopMediaSession?.();
  stopMediaSession = null;
  mediaSession?.dispose();
  mediaSession = null;
}

function publishMediaTrack(track: Track, token: number): void {
  if (!mediaSession) return;
  clearMediaArtwork();
  mediaSession.setTrack(track, getArtworkUrl(track.id));
  stopMediaArtwork = subscribeArtwork(track.id, (url) => {
    if (token === loadToken && usePlaybackStore.getState().currentTrackId === track.id) mediaSession?.setArtwork(url);
  });
  // Artwork resolution never delays play() or the native ended -> next path.
  void loadArtworkUrl(track).then((url) => {
    if (token === loadToken && usePlaybackStore.getState().currentTrackId === track.id) mediaSession?.setArtwork(url);
  }).catch((error: unknown) => {
    console.warn("Could not load artwork for the media notification", error);
  });
  syncMediaSession();
}

function showMediaNotification(): void {
  const state = usePlaybackStore.getState();
  if (state.currentTrackId && state.status === "ready") {
    useDynamicIslandStore.getState().showMediaNotification(state.currentTrackId);
  }
}

function scheduleIdleSideEffect(task: () => void): void {
  if (typeof window !== "undefined" && "requestIdleCallback" in window) {
    (window as Window & { requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback(
      task,
      { timeout: 120 },
    );
  } else {
    setTimeout(task, 0);
  }
}

function maybePreloadNextTrack(): void {
  const state = usePlaybackStore.getState();
  if (!state.currentTrackId || state.status !== "ready") return;
  if (preloadedForTrackId === state.currentTrackId) return;
  preloadedForTrackId = state.currentTrackId;

  const target = nextIndex({
    queueTrackIds: state.queueTrackIds,
    queueIndex: state.queueIndex,
    repeatMode: state.repeatMode === "one" ? "all" : state.repeatMode,
  });
  if (target === null) return;
  const nextTrackId = state.queueTrackIds[target];
  if (!nextTrackId || nextTrackId === state.currentTrackId) return;

  scheduleIdleSideEffect(() => {
    const latest = usePlaybackStore.getState();
    if (latest.currentTrackId !== state.currentTrackId) return;
    void playbackHelpers.getTrackForPlayback(nextTrackId).then((nextTrack) => {
      if (!nextTrack || usePlaybackStore.getState().currentTrackId !== state.currentTrackId) return;
      void playbackHelpers.preloadSource(nextTrack);
    });
  });
}

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
      if (sec >= 3) {
        maybePreloadNextTrack();
      }
    },
    onDurationChange: (sec) => {
      // Apply a one-time resume seek once duration is known.
      if (pendingSeekMs !== null) {
        const seekMs = pendingSeekMs;
        pendingSeekMs = null;
        get().getEngine().seekSec(seekMs / 1000);
        usePlaybackStore.setState({ currentTimeMs: seekMs });
      }
      const durationMs = sec !== null && Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : null;
      usePlaybackStore.setState({ durationMs });
      const currentTrackId = usePlaybackStore.getState().currentTrackId;
      if (currentTrackId && durationMs !== null) {
        void playbackHelpers.syncTrackDuration(currentTrackId, durationMs);
      }
    },
    onPlayStateChange: (isPlaying) => {
      if (isPlaying) {
        usePlaybackStore.setState({ isPlaying: true, autoplayBlocked: false, status: "ready" });
      } else if (usePlaybackStore.getState().status !== "loading") {
        // pause can land between the element's coarse timeupdate events; copy
        // the authoritative media position before observers freeze their UI.
        get().syncFromEngine(true);
        usePlaybackStore.setState({ isPlaying: false });
      }
    },
    onBufferingChange: (isBuffering) => {
      usePlaybackStore.setState({ isBuffering });
    },
    // A completed seek is the moment of truth: re-read the element so a
    // clamped or dropped seek can never leave the store showing a position
    // the audio is not actually at.
    onSeeked: () => get().syncFromEngine(true),
    onEnded: () => get().handleEngineEnded(),
    onError: (failure) => get().handleEngineError(failure),
    onDispose: () => {
      disposeMediaSession();
      releaseActiveTrackSource();
    },
  };
}

function describeFailureForTrack(failure: MediaFailure, track: Track | undefined): PlaybackErrorInfo {
  if (failure.code === 4) {
    return {
      title: track ? `Can't play "${track.title}"` : "This browser cannot play this audio format.",
      detail: `This browser cannot play this audio format. ${describeMediaError(failure.code)} You can keep the track in your library, but this browser cannot decode it.`,
      action: "none",
    };
  }
  if (failure.code === 3) {
    return {
      title: track ? `Couldn't decode "${track.title}"` : "Decoding failed",
      detail: `Audio decoding failed. The file may be corrupted. ${describeMediaError(failure.code)}`,
      action: "relink",
    };
  }
  if (failure.code === 2 && track?.objectKey) {
    return {
      title: track ? `Couldn't load "${track.title}" from the cloud` : "Could not retrieve the cloud audio.",
      detail: "Could not retrieve the cloud audio. The playback link may have expired or the connection dropped. Try again — a fresh link is fetched automatically.",
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
function autoRetryIsCurrent(failedTrackId: string, retryToken: number): boolean {
  return (
    usePlaybackStore.getState().currentTrackId === failedTrackId &&
    loadToken === retryToken &&
    autoSourceRetryUsed
  );
}

async function retryWithFreshSource(
  resumePlayback: boolean,
  failedTrackId: string,
  resumeAtMs: number,
  retryToken: number,
  playToken: number,
): Promise<void> {
  const track = playbackHelpers.currentTrack();
  if (!track || track.id !== failedTrackId || !track.objectKey) return;

  invalidatePlayUrl(track.objectKey);
  const resolved = await resolveTrackSource(track).catch(() => null);
  if (!resolved) return;
  const latest = usePlaybackStore.getState();
  if (!autoRetryIsCurrent(failedTrackId, retryToken)) {
    if (resolved.ok) resolved.release();
    return;
  }
  if (!resolved.ok) return;

  const engine = latest.getEngine();
  engine.setSource(resolved.url);
  recordActiveSourceGeneration();
  if (resumeAtMs > 0) engine.seekSec(resumeAtMs / 1000);
  if (!resumePlayback || playToken !== playRequestToken) {
    usePlaybackStore.setState({ status: "ready", error: null, currentTimeMs: resumeAtMs });
    return;
  }

  try {
    await engine.play();
    if (!autoRetryIsCurrent(failedTrackId, retryToken) || playToken !== playRequestToken) return;
    usePlaybackStore.setState({ status: "ready", error: null, isPlaying: true });
  } catch (error) {
    if (!autoRetryIsCurrent(failedTrackId, retryToken) || playToken !== playRequestToken) return;
    if (error instanceof AutoplayBlockedError) {
      usePlaybackStore.setState({ status: "ready", error: null, isPlaying: false, autoplayBlocked: true });
      return;
    }
    if (error instanceof DOMException && error.name === "AbortError") return;
    usePlaybackStore.setState({
      status: "error",
      isPlaying: false,
      error: describeFailureForTrack({ code: 2, message: "Cloud playback could not resume" }, track),
    });
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
    disposeMediaSession();
    current?.dispose();
    releaseActiveTrackSource();
    acceptedSourceGeneration = null; // fresh engine, fresh generation space
    lastStartTrackAt = 0;
    preloadedForTrackId = null;
    autoSourceRetryUsed = false;
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
    initMediaSession();
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
    playRequestToken += 1;
    clearMediaArtwork();
    mediaSession?.clear();
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const isRapidSkip = options?.coalesce !== false && !options?.requestPermission && lastStartTrackAt > 0 && now - lastStartTrackAt < RAPID_SKIP_COALESCE_WINDOW_MS;
    lastStartTrackAt = now;
    preloadedForTrackId = null;
    autoSourceRetryUsed = false;

    perfMark(`skip:start:${token}`);
    perfMark(`skip:store-update:start:${token}`);
    // From this moment, any media event from the still-loaded previous
    // source is stale: this attempt owns the engine's next generation.
    acceptedSourceGeneration = expectNextSourceGeneration();
    const { autoplay = true, startPositionMs, requestPermission, queueIndex, coalesce = true } = options ?? {};
    pendingSeekMs = startPositionMs ?? null;
    // Any explicit start consumes a pending session-resume so a later Play
    // cannot resurrect a stale position for a different attempt.
    pendingResumeMs = null;
    set({
      ...(queueIndex !== undefined ? { queueIndex } : {}),
      currentTrackId: trackId,
      status: "loading",
      error: null,
      isPlaying: false,
      currentTimeMs: startPositionMs ?? 0,
      durationMs: null,
    });
    perfMeasure("skip:store-update", `skip:store-update:start:${token}`, `skip:store-update:end:${token}`);

    // Coalesce rapid consecutive skips so tapping Next 5-10 times quickly
    // updates the UI immediately but only resolves and loads the final track.
    if (isRapidSkip) {
      await new Promise((resolve) => setTimeout(resolve, RAPID_SKIP_DEBOUNCE_MS));
      if (token !== loadToken) return;
    }

    const { getTrackForPlayback } = playbackHelpers;
    const track = await getTrackForPlayback(trackId);
    if (token !== loadToken) return; // user moved on before resolution finished

    if (!track) {
      pendingSeekMs = null; // don't leak this resume seek onto a later track
      set({ status: "error", error: { title: "Track not found", detail: "This track is no longer in your library.", action: "none" } });
      useDynamicIslandStore.getState().showNotification({
        title: "Playback failed",
        description: "This track is no longer in your library.",
      });
      return;
    }

    // A permission re-request must happen inside the user gesture that
    // triggered this start (Chromium requires activation for the prompt).
    const shouldRequestPermission =
      requestPermission ??
      (coalesce && autoplay && !isRapidSkip && (track.accessMode === "handle" || track.availability === "permission-required"));
    if (shouldRequestPermission) {
      const regained = await regainHandleAccess(track);
      if (token !== loadToken) return;
      if (regained === "granted") {
        void playbackHelpers.markTrackAvailability(track.id, "available");
      } else if (regained === "denied" && requestPermission) {
        set({
          status: "error",
          isPlaying: false,
          error: {
            title: "Grant access to this audio file.",
            detail: "The browser did not grant file access. Press play to try again, or re-link the file from its ⋯ menu.",
            action: "grant-permission",
          },
        });
        useDynamicIslandStore.getState().showNotification({
          title: "Grant access to this audio file.",
          description: "The browser did not grant file access. Tap to grant access.",
          song: `${track.title} — ${track.artist || "Unknown Artist"}`,
          trackId: track.id,
          category: "permission",
          errorCode: "NotAllowedError",
        });
        void playbackHelpers.markTrackAvailability(track.id, "permission-required");
        void diagnoseTrackSource(track, "permission-required: File access was denied during permission request");
        return;
      }
    }

    perfMark(`skip:file-resolution:start:${token}`);
    const resolved = await playbackHelpers.resolveSource(track);
    perfMeasure("skip:file-resolution", `skip:file-resolution:start:${token}`, `skip:file-resolution:end:${token}`);
    if (token !== loadToken) {
      if (resolved.ok) resolved.release();
      return;
    }

    if (!resolved.ok) {
      pendingSeekMs = null; // don't leak this resume seek onto a later track
      clearPreloadedTrackSource();
      void diagnoseTrackSource(track, `${resolved.reason}: ${resolved.originalError ?? resolved.detail}`);
      const isCloudFailure = (resolved.reason === "missing" && Boolean(track.objectKey)) || resolved.reason === "cloud-unavailable";
      const action =
        resolved.reason === "permission-required"
          ? "grant-permission"
          : isCloudFailure
            ? "retry"
            : resolved.reason === "missing"
              ? "relink"
              : "none";
      if (resolved.reason === "permission-required") {
        void playbackHelpers.markTrackAvailability(track.id, "permission-required");
      } else if (resolved.reason === "missing" && !track.objectKey) {
        void playbackHelpers.markTrackAvailability(track.id, "missing");
      } else if (resolved.reason === "offline") {
        void playbackHelpers.markTrackAvailability(track.id, "offline");
      }
      set({
        status: "error",
        isPlaying: false,
        error: {
          title:
            resolved.reason === "permission-required"
              ? "Grant access to this audio file."
              : isCloudFailure
                ? "Could not retrieve the cloud audio."
                : `Can't play "${track.title}"`,
          detail: resolved.detail,
          action,
        },
      });
      if (resolved.reason === "permission-required") {
        // Temporary permission loss is recoverable — never mark as permanently broken.
        useDynamicIslandStore.getState().showNotification({
          title: "Grant access to this audio file.",
          description: resolved.detail || "Grant access to this audio file.",
          song: `${track.title} — ${track.artist || "Unknown Artist"}`,
          trackId: track.id,
          category: "permission",
          errorCode: resolved.originalError ?? "PermissionRequired",
        });
      } else if (isCloudFailure) {
        // Cloud retrieval failure is transient/network — never mark local track as broken.
        useDynamicIslandStore.getState().showNotification({
          title: "Could not retrieve the cloud audio.",
          description: resolved.detail || "Could not retrieve the cloud audio.",
          song: `${track.title} — ${track.artist || "Unknown Artist"}`,
          trackId: track.id,
          category: "network",
          errorCode: resolved.originalError ?? "CloudFetchError",
        });
      } else if (resolved.reason === "missing" && !track.objectKey) {
        // Permanent local source failure
        const missingSummary = summarizePlaybackError("Audio file not found: " + (resolved.detail || "The audio file could not be found or opened."));
        void playbackHelpers.markTrackBroken(track.id, {
          category: "missing",
          description: missingSummary.summary,
          summary: missingSummary.summary,
          originalMessage: resolved.detail || "The audio file could not be found or opened.",
          errorCode: "NotFoundError",
        });
        useDynamicIslandStore.getState().showNotification({
          title: missingSummary.title,
          description: missingSummary.summary,
          song: `${track.title} — ${track.artist || "Unknown Artist"}`,
          trackId: track.id,
          category: "missing",
          errorCode: "NotFoundError",
        });
      } else {
        const notifTitle =
          resolved.reason === "offline"
            ? "Playback offline"
            : resolved.reason === "unsupported"
              ? "This browser cannot play this audio format."
              : "Playback failed";
        useDynamicIslandStore.getState().showNotification({
          title: notifTitle,
          description: resolved.detail,
          song: `${track.title} — ${track.artist || "Unknown Artist"}`,
          trackId: track.id,
          category: resolved.reason === "offline" ? "network" : resolved.reason === "unsupported" ? "unsupported" : undefined,
        });
      }
      return;
    }

    perfMark(`skip:audio-src-to-canplay:start:${token}`);
    const engine = get().getEngine();
    engine.setSource(resolved.url);
    recordActiveSourceGeneration();
    publishMediaTrack(track, token);

    const commitPostStartSideEffects = () => {
      scheduleIdleSideEffect(() => {
        if (token !== loadToken) return;
        perfMark(`skip:db-writes:start:${token}`);
        if (track.broken?.isBroken || track.availability === "broken") {
          void playbackHelpers.restoreBrokenTrack(track.id);
        }
        void playbackHelpers.markTrackAvailability(track.id, "available");
        void playbackHelpers.notifyTrackStarted(trackId);
        perfMeasure("skip:db-writes-dispatch", `skip:db-writes:start:${token}`, `skip:db-writes:end:${token}`);
      });
    };

    if (autoplay) {
      const playToken = ++playRequestToken;
      try {
        await engine.play();
        perfMeasure("skip:audio-src-to-canplay", `skip:audio-src-to-canplay:start:${token}`, `skip:audio-src-to-canplay:end:${token}`);
        if (token !== loadToken) return;
        if (playToken !== playRequestToken) {
          set({ status: "ready" });
          commitPostStartSideEffects();
          return;
        }
        set({
          isPlaying: true,
          status: "ready",
          announcement: `Playing ${track.title} by ${track.artist || "unknown artist"}`,
        });
        showMediaNotification();
        perfMeasure("skip:total", `skip:start:${token}`, `skip:end:${token}`);
        commitPostStartSideEffects();
      } catch (error) {
        if (token !== loadToken) return;
        if (playToken !== playRequestToken) {
          set({ status: "ready" });
          return;
        }
        if (error instanceof AutoplayBlockedError) {
          set({
            autoplayBlocked: true,
            isPlaying: false,
            status: "ready",
            announcement: "Playback blocked by the browser. Press play to start.",
          });
          useDynamicIslandStore.getState().showNotification({
            title: "Autoplay blocked",
            description: "The browser blocked playback. Press play to start.",
            song: `${track.title} — ${track.artist || "Unknown Artist"}`,
            trackId: track.id,
          });
          commitPostStartSideEffects();
        } else if (error instanceof DOMException && error.name === "AbortError") {
          // play() was interrupted by a load() or pause() — a transition, not
          // a playback failure. The element's own events keep state honest.
          set({ isPlaying: false, status: "ready" });
          commitPostStartSideEffects();
        } else {
          get().handleEngineError({ code: 0, message: error instanceof Error ? error.message : String(error) });
        }
      }
    } else {
      set({ status: "ready" });
      commitPostStartSideEffects();
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
    const token = ++playRequestToken;
    const sourceToken = loadToken;
    void engine
      .play()
      .then(() => {
        if (token !== playRequestToken || sourceToken !== loadToken) return;
        set({ isPlaying: true, autoplayBlocked: false });
        showMediaNotification();
      })
      .catch((error: unknown) => {
        if (token !== playRequestToken || sourceToken !== loadToken) return;
        if (error instanceof AutoplayBlockedError) {
          set({ isPlaying: false, autoplayBlocked: true, announcement: "Playback blocked by the browser. Press play to start." });
          const currentTrack = playbackHelpers.currentTrack();
          useDynamicIslandStore.getState().showNotification({
            title: "Autoplay blocked",
            description: "The browser blocked playback. Press play to start.",
            song: currentTrack ? `${currentTrack.title} — ${currentTrack.artist || "Unknown Artist"}` : undefined,
            trackId: currentTrack?.id,
          });
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
    playRequestToken += 1;
    set({ isPlaying: false });
    showMediaNotification();
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
    void get().startTrack(state.queueTrackIds[target], { autoplay: true, queueIndex: target, coalesce: userInitiated });
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
    void get().startTrack(state.queueTrackIds[target], { autoplay: true, queueIndex: target });
  },

  seek: (ms) => {
    const state = get();
    if (!state.currentTrackId || state.status === "loading" || state.status === "error" || state.durationMs === null || !Number.isFinite(ms)) return;
    const clamped = clamp(ms, 0, state.durationMs);
    state.getEngine().seekSec(clamped / 1000);
    set({ currentTimeMs: clamped });
    syncMediaSession();
    showMediaNotification();
    void playbackHelpers.persistPosition();
  },

  seekBy: (deltaMs) => {
    const state = get();
    const positionMs = state.engine ? state.engine.currentTimeSec * 1000 : state.currentTimeMs;
    get().seek(positionMs + deltaMs);
  },

  syncFromEngine: (exact = false) => {
    const state = get();
    if (!state.currentTrackId || state.status !== "ready") return;
    const engine = state.getEngine();
    if (!engine.element) return;
    // A restored session intentionally has no media source until the next user
    // play gesture. Its newly created element reports 0, which must not erase
    // the saved resume position displayed by paused controls.
    if (
      typeof HTMLMediaElement !== "undefined" &&
      engine.element instanceof HTMLMediaElement &&
      !engine.element.currentSrc &&
      !engine.element.getAttribute("src")
    ) {
      return;
    }
    const engineMs = engine.currentTimeSec * 1000;
    if (!Number.isFinite(engineMs) || engineMs < 0) return;
    // The media clock is authoritative. Periodic playback checks retain a
    // tolerance to avoid redundant high-frequency store writes; settled
    // lifecycle boundaries request an exact snapshot.
    if (exact || Math.abs(engineMs - state.currentTimeMs) > 750) {
      usePlaybackStore.setState({ currentTimeMs: engineMs });
      syncMediaSession();
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
      syncMediaSession();
      const token = ++playRequestToken;
      const sourceToken = loadToken;
      void state.getEngine().play().catch((error: unknown) => {
        if (token !== playRequestToken || sourceToken !== loadToken) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (error instanceof AutoplayBlockedError) {
          set({ isPlaying: false, autoplayBlocked: true });
        } else {
          get().handleEngineError({ code: 0, message: error instanceof Error ? error.message : String(error) });
        }
      });
      return;
    }
    // Landed on the true final position before deciding what's next, so the
    // bar rests at the end by construction instead of jumping there.
    get().syncFromEngine();
    syncMediaSession();
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
    const resumePlayback = get().isPlaying;
    const resumeAtMs = get().engine ? get().engine!.currentTimeSec * 1000 : get().currentTimeMs;
    if (track) {
      void diagnoseTrackSource(track, `MediaError(${failure.code}): ${failure.message}`);
    }
    // MediaError code 1 is transition noise; all other failures invalidate playback promises.
    const playToken = ++playRequestToken;
    const retryToken = ++loadToken;
    const errorInfo = describeFailureForTrack(failure, track);
    set({
      isPlaying: false,
      status: "error",
      error: errorInfo,
    });

    const song = track ? `${track.title} — ${track.artist || "Unknown Artist"}` : undefined;

    const errorSummary = summarizePlaybackError(failure);

    if (failure.code === 2) {
      // Network error is transient
      useDynamicIslandStore.getState().showNotification({
        title: errorSummary.title,
        description: errorSummary.summary,
        song,
        trackId: track?.id,
        category: errorSummary.category,
        errorCode: errorSummary.errorCode,
      });
    } else {
      if (track) {
        void playbackHelpers.markTrackBroken(track.id, {
          category: (errorSummary.category === "playback" || errorSummary.category === "network" ? "corrupted" : errorSummary.category) as BrokenCategory,
          description: errorSummary.summary,
          summary: errorSummary.summary,
          originalMessage: errorSummary.originalMessage,
          errorCode: errorSummary.errorCode,
        });
      }
      useDynamicIslandStore.getState().showNotification({
        title: errorSummary.title,
        description: errorSummary.summary,
        song,
        trackId: track?.id,
        category: errorSummary.category,
        errorCode: errorSummary.errorCode,
      });
    }

    // A network failure on a cloud track is often just an expired signed URL.
    // One automatic refresh keeps playback alive; a second failure surfaces.
    if (failure.code === 2 && track?.objectKey && !autoSourceRetryUsed) {
      autoSourceRetryUsed = true;
      void retryWithFreshSource(resumePlayback, track.id, resumeAtMs, retryToken, playToken);
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

export function resetPlaybackRuntime(): void {
  loadToken += 1;
  playRequestToken += 1;
  pendingSeekMs = null;
  pendingResumeMs = null;
  lastStartTrackAt = 0;
  preloadedForTrackId = null;
  acceptedSourceGeneration = null;
  autoSourceRetryUsed = false;
  clearMediaArtwork();
  mediaSession?.clear();
  const state = usePlaybackStore.getState();
  state.engine?.pause();
  state.engine?.setSource(null);
  releaseActiveTrackSource();
  usePlaybackStore.setState({
    currentTrackId: null,
    currentTimeMs: 0,
    durationMs: null,
    isPlaying: false,
    isBuffering: false,
    queueTrackIds: [],
    queueIndex: -1,
    contextTrackIds: [],
    context: null,
    status: "idle",
    error: null,
    autoplayBlocked: false,
    announcement: "",
  });
}

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
  syncTrackDuration: (trackId: string, durationMs: number) => Promise<void>;
  markTrackAvailability: (
    trackId: string,
    availability: "available" | "permission-required" | "missing" | "offline",
  ) => Promise<void>;
  persistPrefs: () => void;
  persistPosition: () => void;
  resolveSource: typeof resolveTrackSource;
  preloadSource: typeof preloadTrackSource;
  markTrackBroken: (trackId: string, info: { category: BrokenCategory; description: string; summary?: string; originalMessage?: string; errorCode?: string }) => Promise<void>;
  restoreBrokenTrack: (trackId: string) => Promise<void>;
} = {
  getTrackForPlayback: async () => undefined,
  currentTrack: () => undefined,
  notifyTrackStarted: async () => undefined,
  syncTrackDuration: async () => undefined,
  markTrackAvailability: async () => undefined,
  persistPrefs: () => undefined,
  persistPosition: () => undefined,
  resolveSource: resolveTrackSource,
  preloadSource: preloadTrackSource,
  markTrackBroken: async () => undefined,
  restoreBrokenTrack: async () => undefined,
};

export function bindPlaybackHelpers(helpers: Partial<typeof playbackHelpers>): void {
  Object.assign(playbackHelpers, helpers);
}
