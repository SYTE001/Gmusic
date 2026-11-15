import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePlaybackStore, bindPlaybackHelpers } from "./playbackStore";
import type { AudioEngine, EngineEvents, MediaFailure } from "../services/audio/engine";
import { resolveTrackSource } from "../services/file-access/FileAccessService";
import { repository } from "../services/indexeddb/LibraryRepository";
import type { Track } from "../types";

/**
 * Media Session integration contract: the playback store bridges the shared
 * audio engine's state to the OS media notification (lock-screen controls).
 * The bridge must be honest — metadata matches the started track, position
 * state reflects the real engine clock (never stale store time), OS handler
 * invocations route into the store actions, stale track/artwork updates are
 * ignored, and the automatic ended -> next path never waits on timers.
 *
 * Everything at the browser boundary is faked: navigator.mediaSession,
 * MediaMetadata, Image and the artwork cache — no real network, no real audio.
 */

// ---- artwork cache mock (no real network, fully controllable) ----

const artworkMock = vi.hoisted(() => {
  const state = {
    /** URL served synchronously by getArtworkUrl, per track. */
    cachedUrls: new Map<string, string | undefined>(),
    /** Deferred loadArtworkUrl promises, resolvable per track by the test. */
    loadResolvers: new Map<string, (url: string | undefined) => void>(),
    /** Per-track listeners registered through subscribeArtwork. */
    trackListeners: new Map<string, Set<(url: string | undefined) => void>>(),
  };
  return state;
});

vi.mock("../services/artwork/artworkCache", () => ({
  getArtworkUrl: (trackId: string) => artworkMock.cachedUrls.get(trackId),
  loadArtworkUrl: (track: string | { id: string }) => {
    const id = typeof track === "string" ? track : track.id;
    return new Promise<string | undefined>((resolve) => {
      artworkMock.loadResolvers.set(id, resolve);
    });
  },
  subscribeArtwork: (trackId: string, listener: (url: string | undefined) => void) => {
    const set = artworkMock.trackListeners.get(trackId) ?? new Set<(url: string | undefined) => void>();
    artworkMock.trackListeners.set(trackId, set);
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  },
}));

// ---- Media Session browser doubles ----

/** Every constructed instance is recorded so tests can observe re-publication. */
let metadataLog: FakeMediaMetadata[] = [];

class FakeMediaMetadata {
  title: string;
  artist: string;
  album: string;
  artwork: MediaImage[];
  constructor(init: MediaMetadataInit = {}) {
    this.title = init.title ?? "";
    this.artist = init.artist ?? "";
    this.album = init.album ?? "";
    this.artwork = init.artwork ? [...init.artwork] : [];
    metadataLog.push(this);
  }
}

/** An Image that never loads or fails — artwork conversion stays pending, harmlessly. */
class NeverLoadingImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  src = "";
}

type MockSession = {
  metadata: MediaMetadata | null;
  playbackState: MediaSessionPlaybackState;
  setActionHandler: (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => void;
  setPositionState: (state?: MediaPositionState) => void;
};

function installMediaSessionMock(): {
  session: MockSession;
  handlers: Map<MediaSessionAction, MediaSessionActionHandler | null>;
  positionStates: (MediaPositionState | undefined)[];
} {
  const handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>();
  const positionStates: (MediaPositionState | undefined)[] = [];
  const session: MockSession = {
    metadata: null,
    playbackState: "none",
    setActionHandler: (action, handler) => {
      handlers.set(action, handler);
    },
    setPositionState: (state) => {
      positionStates.push(state);
    },
  };
  Object.defineProperty(navigator, "mediaSession", { value: session, configurable: true });
  return { session, handlers, positionStates };
}

function fireHandler(
  handlers: Map<MediaSessionAction, MediaSessionActionHandler | null>,
  action: MediaSessionAction,
  details?: Partial<MediaSessionActionDetails>,
): void {
  const handler = handlers.get(action);
  expect(handler, `expected a registered ${action} handler`).not.toBeNull();
  handler?.({ action, ...details } as MediaSessionActionDetails);
}

// ---- Engine double with deferrable play() promises ----

class MediaFakeEngine implements AudioEngine {
  element: HTMLAudioElement | null = null;
  src: string | null = null;
  playing = false;
  time = 0;
  duration = 120;
  volume = 1;
  muted = false;
  sourceGen = 0;
  playError: unknown = null;
  /** When set, play() parks its promise here instead of resolving immediately. */
  deferPlay = false;
  pendingPlays: Array<{ resolve: () => void; reject: (error?: unknown) => void }> = [];
  #events: EngineEvents;

  constructor(events: EngineEvents) {
    this.#events = events;
  }

  get sourceGeneration(): number {
    return this.sourceGen;
  }

  setSource(url: string | null) {
    this.sourceGen += 1;
    this.src = url;
    if (url !== null) this.#events.onDurationChange(this.duration);
  }

  play(): Promise<void> {
    if (this.playError !== null) throw this.playError;
    if (this.deferPlay) {
      return new Promise<void>((resolve, reject) => {
        this.pendingPlays.push({ resolve, reject });
      });
    }
    this.playing = true;
    this.#events.onPlayStateChange(true);
    return Promise.resolve();
  }

  pause() {
    this.playing = false;
    this.#events.onPlayStateChange(false);
  }

  get currentTimeSec() {
    return this.time;
  }

  seekSec(seconds: number) {
    this.time = seconds;
    this.#events.onTimeUpdate(seconds);
  }

  get durationSec() {
    return this.duration;
  }

  setVolume(volume: number) {
    this.volume = volume;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
  }

  dispose() {
    this.playing = false;
  }

  // Test helpers
  advance(seconds: number) {
    this.time += seconds;
    this.#events.onTimeUpdate(this.time);
  }

  /** Resolves the deferred play() at `index` without firing any media event. */
  resolvePendingPlay(index = 0) {
    const pending = this.pendingPlays.splice(index, 1)[0];
    expect(pending, "expected a pending deferred play()").toBeDefined();
    pending?.resolve();
  }

  finish() {
    this.#events.onEnded();
  }

  fail(code: number) {
    this.#events.onError({ code, message: "fake" } satisfies MediaFailure);
  }
}

function makeEngineEvents(): EngineEvents {
  return {
    onTimeUpdate: (sec) => usePlaybackStore.setState({ currentTimeMs: sec * 1000 }),
    onDurationChange: (sec) => usePlaybackStore.setState({ durationMs: sec !== null ? sec * 1000 : null }),
    onPlayStateChange: (isPlaying) => {
      if (isPlaying) usePlaybackStore.setState({ isPlaying: true, autoplayBlocked: false, status: "ready" });
      else if (usePlaybackStore.getState().status !== "loading") usePlaybackStore.setState({ isPlaying: false });
    },
    onBufferingChange: (isBuffering) => usePlaybackStore.setState({ isBuffering }),
    onSeeked: () => usePlaybackStore.getState().syncFromEngine(),
    onEnded: () => usePlaybackStore.getState().handleEngineEnded(),
    onError: (failure) => usePlaybackStore.getState().handleEngineError(failure),
  };
}

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: `t${Math.random().toString(36).slice(2, 8)}`,
    title: "Song",
    artist: "Artist",
    album: "",
    trackNumber: null,
    albumTrackCount: null,
    durationMs: 120000,
    fileName: "song.mp3",
    fileSize: 1,
    mimeType: "audio/mpeg",
    addedAt: 1,
    lastPlayedAt: null,
    playCount: 0,
    isLiked: false,
    availability: "available",
    accessMode: "stored-copy",
    fingerprint: null,
    metadataFromFilename: false,
    ...overrides,
  };
}

// ---- Fixtures and helpers ----

let engine: MediaFakeEngine;
const tracks: Track[] = [];

async function flushMicrotasks(turns = 40): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

async function waitForStore(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Store condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function lastPositionState(positionStates: (MediaPositionState | undefined)[]): MediaPositionState | undefined {
  expect(positionStates.length, "expected at least one setPositionState call").toBeGreaterThan(0);
  return positionStates[positionStates.length - 1];
}

describe("playback store Media Session integration", () => {
  let session: MockSession;
  let handlers: Map<MediaSessionAction, MediaSessionActionHandler | null>;
  let positionStates: (MediaPositionState | undefined)[];

  beforeEach(async () => {
    await repository.clearAllData();
    artworkMock.cachedUrls.clear();
    artworkMock.loadResolvers.clear();
    artworkMock.trackListeners.clear();
    metadataLog = [];

    ({ session, handlers, positionStates } = installMediaSessionMock());
    vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
    vi.stubGlobal("Image", NeverLoadingImage);

    tracks.length = 0;
    const a = makeTrack({ id: "a", title: "A", artist: "Artist A", album: "Nightdrive" });
    const b = makeTrack({ id: "b", title: "B", artist: "Artist B", album: "Nightdrive" });
    const c = makeTrack({ id: "c", title: "C", artist: "Artist C", album: "Other" });
    tracks.push(a, b, c);
    for (const track of [a, b, c]) {
      await repository.putAudioBlob(track.id, new Blob(["audio-bytes"]));
    }
    await repository.putTracks(tracks);

    bindPlaybackHelpers({
      getTrackForPlayback: async (id) => tracks.find((track) => track.id === id),
      currentTrack: () => undefined,
      notifyTrackStarted: async () => undefined,
      syncTrackDuration: async () => undefined,
      markTrackAvailability: async () => undefined,
      markTrackBroken: async () => undefined,
      restoreBrokenTrack: async () => undefined,
      persistPrefs: () => undefined,
      persistPosition: () => undefined,
      resolveSource: resolveTrackSource,
    });

    engine = new MediaFakeEngine(makeEngineEvents());
    usePlaybackStore.getState().setEngineForTests(engine);
    // init() -> getEngine() initializes the MediaSessionController against the
    // mocked navigator.mediaSession and registers all action handlers.
    usePlaybackStore.getState().init();

    usePlaybackStore.setState({
      currentTrackId: null,
      currentTimeMs: 0,
      durationMs: null,
      isPlaying: false,
      isBuffering: false,
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
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (navigator as unknown as { mediaSession?: unknown }).mediaSession;
  });

  it("registers handlers and publishes honest metadata on a successful start", async () => {
    usePlaybackStore.getState().playContext(["a"], 0, { type: "library", label: "L" });
    await waitForStore(() => usePlaybackStore.getState().isPlaying);

    // All OS controls were registered through the store's getEngine() init.
    for (const action of ["play", "pause", "previoustrack", "nexttrack", "seekto", "seekbackward", "seekforward"] as const) {
      expect(handlers.get(action), `missing ${action} handler`).not.toBeNull();
    }

    const metadata = session.metadata as FakeMediaMetadata | null;
    expect(metadata).toBeInstanceOf(FakeMediaMetadata);
    expect(metadata?.title).toBe("A");
    expect(metadata?.artist).toBe("Artist A");
    expect(metadata?.album).toBe("Nightdrive");
    // No artwork URL is cached for this track, so text-only metadata is published.
    expect(metadata?.artwork).toEqual([]);

    // Playback state follows the engine's actual playing state.
    expect(session.playbackState).toBe("playing");

    // Position state comes from the engine clock, not the store's displayed time.
    const position = lastPositionState(positionStates);
    expect(position).toEqual({ duration: 120, position: 0, playbackRate: 1 });
  });

  it("routes play, pause, next and previous handlers into the store actions", async () => {
    usePlaybackStore.getState().playContext(["a", "b", "c"], 0, { type: "library", label: "L" });
    await waitForStore(() => usePlaybackStore.getState().isPlaying);

    fireHandler(handlers, "pause");
    expect(usePlaybackStore.getState().isPlaying).toBe(false);
    expect(engine.playing).toBe(false);

    fireHandler(handlers, "play");
    expect(usePlaybackStore.getState().isPlaying).toBe(true);
    expect(engine.playing).toBe(true);

    fireHandler(handlers, "nexttrack");
    await waitForStore(() => usePlaybackStore.getState().currentTrackId === "b" && usePlaybackStore.getState().isPlaying);
    expect(usePlaybackStore.getState().queueIndex).toBe(1);

    // "b" just started at 0s, so previous goes back a track instead of seeking.
    fireHandler(handlers, "previoustrack");
    await waitForStore(() => usePlaybackStore.getState().currentTrackId === "a" && usePlaybackStore.getState().isPlaying);
    expect(usePlaybackStore.getState().queueIndex).toBe(0);
  });

  it("seek handlers resolve against the real engine clock, not stale store time", async () => {
    usePlaybackStore.getState().playContext(["a", "b"], 0, { type: "library", label: "L" });
    await waitForStore(() => usePlaybackStore.getState().isPlaying);

    // Absolute seekto: seconds in, milliseconds out.
    fireHandler(handlers, "seekto", { seekTime: 45 });
    expect(engine.time).toBe(45);
    expect(usePlaybackStore.getState().currentTimeMs).toBe(45000);

    // The store's displayed time goes stale/corrupt while the engine keeps the
    // truth at 50s; a relative seek must anchor on the engine clock.
    engine.advance(5); // engine at 50s, store at 50000
    usePlaybackStore.setState({ currentTimeMs: 123456789 });
    fireHandler(handlers, "seekbackward"); // no seekOffset -> 10s default step
    expect(engine.time).toBe(40);
    expect(usePlaybackStore.getState().currentTimeMs).toBe(40000);

    fireHandler(handlers, "seekforward", { seekOffset: 5 });
    expect(engine.time).toBe(45);
    expect(usePlaybackStore.getState().currentTimeMs).toBe(45000);
  });

  it("position state tracks the engine duration and time, even when store time is stale", async () => {
    usePlaybackStore.getState().playContext(["a"], 0, { type: "library", label: "L" });
    await waitForStore(() => usePlaybackStore.getState().isPlaying);

    engine.advance(30);
    let position = lastPositionState(positionStates);
    expect(position).toEqual({ duration: 120, position: 30, playbackRate: 1 });

    // Poison the store's displayed time: sync must still publish the engine's
    // actual position, never the stale number.
    usePlaybackStore.setState({ currentTimeMs: 7 });
    position = lastPositionState(positionStates);
    expect(position).toEqual({ duration: 120, position: 30, playbackRate: 1 });

    // Pausing flips the OS playback state without fabricating a position.
    usePlaybackStore.getState().pause();
    expect(session.playbackState).toBe("paused");
  });

  it("clears metadata and playback state when the current track is reset to null", async () => {
    usePlaybackStore.getState().playContext(["a"], 0, { type: "library", label: "L" });
    await waitForStore(() => usePlaybackStore.getState().isPlaying);
    expect(session.metadata).not.toBeNull();

    usePlaybackStore.setState({ currentTrackId: null });

    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe("none");
  });

  it("setEngineForTests disposes the previous controller: handlers removed and state cleared", async () => {
    usePlaybackStore.getState().playContext(["a"], 0, { type: "library", label: "L" });
    await waitForStore(() => usePlaybackStore.getState().isPlaying);
    expect(session.metadata).not.toBeNull();
    expect(handlers.get("play")).not.toBeNull();

    usePlaybackStore.getState().setEngineForTests(new MediaFakeEngine(makeEngineEvents()));

    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe("none");
    for (const action of ["play", "pause", "previoustrack", "nexttrack", "seekto", "seekbackward", "seekforward"] as const) {
      expect(handlers.get(action), `${action} handler must be detached`).toBeNull();
    }
  });

  it("ignores stale artwork subscription updates from a superseded track", async () => {
    usePlaybackStore.getState().playContext(["a"], 0, { type: "library", label: "L" });
    await waitForStore(() => usePlaybackStore.getState().isPlaying);

    // Capture track "a"'s artwork listener while it is current.
    const listenerA = [...(artworkMock.trackListeners.get("a") ?? [])][0];
    expect(listenerA).toBeDefined();

    // Switch to "b": a's artwork updates are now stale.
    await usePlaybackStore.getState().startTrack("b", { autoplay: true });
    await waitForStore(() => usePlaybackStore.getState().currentTrackId === "b" && usePlaybackStore.getState().isPlaying);
    const metadataBefore = session.metadata;

    // A stale artwork update for "a" must not touch the media notification...
    listenerA!("blob:stale-a-artwork");
    expect(session.metadata).toBe(metadataBefore);

    // ...while the current track's artwork update is applied.
    const listenerB = [...(artworkMock.trackListeners.get("b") ?? [])][0];
    expect(listenerB).toBeDefined();
    listenerB!("blob:b-artwork");
    expect(session.metadata).not.toBe(metadataBefore);
    expect((session.metadata as FakeMediaMetadata).title).toBe("B");
  });

  it("ignores a late-resolving artwork load from a superseded track", async () => {
    usePlaybackStore.getState().playContext(["a"], 0, { type: "library", label: "L" });
    await waitForStore(() => usePlaybackStore.getState().isPlaying);

    // "a"'s loadArtworkUrl promise is parked unresolved; move to "b" first.
    await usePlaybackStore.getState().startTrack("b", { autoplay: true });
    await waitForStore(() => usePlaybackStore.getState().currentTrackId === "b" && usePlaybackStore.getState().isPlaying);
    const metadataBefore = session.metadata;

    // "a"'s artwork resolves late — it belongs to a superseded load token.
    artworkMock.loadResolvers.get("a")!("blob:a-late-artwork");
    await flushMicrotasks();
    expect(session.metadata).toBe(metadataBefore);

    // "b"'s own artwork resolution still applies.
    artworkMock.loadResolvers.get("b")!("blob:b-late-artwork");
    await flushMicrotasks();
    expect(session.metadata).not.toBe(metadataBefore);
    expect((session.metadata as FakeMediaMetadata).title).toBe("B");
  });

  it("the automatic ended -> next path resolves without advancing timers (coalesce bypass)", async () => {
    vi.useFakeTimers();
    try {
      bindPlaybackHelpers({
        resolveSource: async (track) => ({
          ok: true as const,
          url: `blob:fake-${track.id}`,
          release: () => undefined,
        }),
      });

      usePlaybackStore.getState().playContext(["a", "b"], 0, { type: "library", label: "L" });
      await flushMicrotasks();
      expect(usePlaybackStore.getState().currentTrackId).toBe("a");
      expect(usePlaybackStore.getState().isPlaying).toBe(true);

      // Natural end: the store must advance to "b" using only microtasks —
      // the ended path passes coalesce: false, so no debounce timer is ever
      // awaited and timers stay untouched.
      engine.finish();
      await flushMicrotasks();

      expect(usePlaybackStore.getState().currentTrackId).toBe("b");
      expect(usePlaybackStore.getState().isPlaying).toBe(true);
      expect(engine.src).toBe("blob:fake-b");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a play promise that resolves after pause cannot mark the store playing", async () => {
    usePlaybackStore.getState().playContext(["a"], 0, { type: "library", label: "L" });
    await waitForStore(() => usePlaybackStore.getState().isPlaying);

    usePlaybackStore.getState().pause();
    expect(usePlaybackStore.getState().isPlaying).toBe(false);

    // Play is issued but its promise stays pending, then pause interrupts it.
    engine.deferPlay = true;
    usePlaybackStore.getState().play();
    usePlaybackStore.getState().pause();
    expect(usePlaybackStore.getState().isPlaying).toBe(false);

    // The interrupted request's promise resolves late: the stale token must
    // prevent it from overriding the newer pause intent.
    engine.resolvePendingPlay(0);
    await flushMicrotasks();

    expect(usePlaybackStore.getState().isPlaying).toBe(false);
    expect(engine.playing).toBe(false);
  });

  it("an old play promise is ignored after a track switch", async () => {
    usePlaybackStore.getState().playContext(["a"], 0, { type: "library", label: "L" });
    await waitForStore(() => usePlaybackStore.getState().isPlaying);
    usePlaybackStore.getState().pause();

    engine.deferPlay = true;
    usePlaybackStore.getState().play(); // pending play for "a"

    // Switch tracks while that play request is still pending.
    void usePlaybackStore.getState().startTrack("b", { autoplay: true });
    // "b" reached its own engine.play(): two deferred plays are parked.
    await waitForStore(() => engine.pendingPlays.length === 2);
    expect(usePlaybackStore.getState().currentTrackId).toBe("b");
    expect(usePlaybackStore.getState().isPlaying).toBe(false);

    // The old play promise resolves: it must not mark the new track playing.
    engine.resolvePendingPlay(0);
    await flushMicrotasks();
    expect(usePlaybackStore.getState().isPlaying).toBe(false);

    // The current track's own play promise is the one that counts.
    engine.resolvePendingPlay(0);
    await flushMicrotasks();
    expect(usePlaybackStore.getState().isPlaying).toBe(true);
  });
});
