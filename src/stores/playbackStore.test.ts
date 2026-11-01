import { beforeEach, describe, expect, it } from "vitest";
import { usePlaybackStore, bindPlaybackHelpers } from "./playbackStore";
import type { AudioEngine, EngineEvents, MediaFailure } from "../services/audio/engine";
import { resolveTrackSource } from "../services/file-access/FileAccessService";
import { repository } from "../services/indexeddb/LibraryRepository";
import type { Track } from "../types";

/** Deterministic engine double — no real audio in jsdom. */
class FakeEngine implements AudioEngine {
  element: HTMLAudioElement | null = null;
  src: string | null = null;
  playing = false;
  time = 0;
  duration = 120;
  volume = 1;
  muted = false;
  /** Source generation, bumped on every setSource like the real engine. */
  sourceGen = 0;
  /** When set, play() rejects with this value (AbortError simulations). */
  playError: unknown = null;
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
  async play() {
    if (this.playError !== null) throw this.playError;
    this.playing = true;
    this.#events.onPlayStateChange(true);
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
  finish() {
    this.#events.onEnded();
  }
  fail(code: number) {
    this.#events.onError({ code, message: "fake" } satisfies MediaFailure);
  }
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

let engine: FakeEngine;
const tracks: Track[] = [];

describe("playback store", () => {
  beforeEach(async () => {
    await repository.clearAllData();
    tracks.length = 0;
    const a = makeTrack({ id: "a", title: "A" });
    const b = makeTrack({ id: "b", title: "B" });
    const c = makeTrack({ id: "c", title: "C" });
    const ghost = makeTrack({ id: "ghost", title: "Ghost" });
    tracks.push(a, b, c, ghost);
    for (const track of [a, b, c]) {
      await repository.putAudioBlob(track.id, new Blob(["audio-bytes"]));
    }
    // "ghost" gets metadata only — no stored audio and no handle — to exercise
    // the missing-source path.
    await repository.putTracks(tracks);

    bindPlaybackHelpers({
      getTrackForPlayback: async (id) => tracks.find((track) => track.id === id),
      currentTrack: () => undefined,
      notifyTrackStarted: async () => undefined,
      markTrackAvailability: async (id, availability) => {
        await repository.updateTrack(id, { availability });
      },
      persistPrefs: () => undefined,
      persistPosition: () => undefined,
      resolveSource: resolveTrackSource,
    });

    engine = new FakeEngine({
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
    });
    usePlaybackStore.getState().setEngineForTests(engine);

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
    });
  });

  it("plays a context starting at the chosen index", async () => {
    usePlaybackStore.getState().playContext(["a", "b", "c"], 1, { type: "library", label: "Library" });
    await waitForStore(() => usePlaybackStore.getState().status === "ready");
    const state = usePlaybackStore.getState();
    expect(state.currentTrackId).toBe("b");
    expect(state.queueIndex).toBe(1);
    expect(state.isPlaying).toBe(true);
    expect(engine.src).toContain("blob:");
  });

  it("advances, wraps, and stops per repeat mode", async () => {
    usePlaybackStore.getState().playContext(["a", "b"], 0, { type: "library", label: "L" });
    await waitForStore(() => usePlaybackStore.getState().status === "ready");

    usePlaybackStore.getState().next(true);
    await waitForStore(() => usePlaybackStore.getState().currentTrackId === "b");

    // off: stop at the end
    usePlaybackStore.getState().next(true);
    await Promise.resolve();
    expect(usePlaybackStore.getState().isPlaying).toBe(false);
    expect(usePlaybackStore.getState().status).toBe("ended");

    // all: wrap back to the first track
    usePlaybackStore.setState({ repeatMode: "all" });
    usePlaybackStore.getState().playContext(["a", "b"], 1, { type: "library", label: "L" });
    await waitForStore(() => usePlaybackStore.getState().status === "ready" && usePlaybackStore.getState().currentTrackId === "b");
    usePlaybackStore.getState().next(true);
    await waitForStore(() => usePlaybackStore.getState().currentTrackId === "a");

    // one: explicit next still advances
    usePlaybackStore.setState({ repeatMode: "one" });
    usePlaybackStore.getState().next(true);
    await waitForStore(() => usePlaybackStore.getState().currentTrackId === "b");
  });

  it("repeats the current track on natural end with repeat one", async () => {
    usePlaybackStore.setState({ repeatMode: "one" });
    usePlaybackStore.getState().playContext(["a", "b"], 0, { type: "library", label: "L" });
    await waitForStore(() => usePlaybackStore.getState().status === "ready");
    engine.seekSec(60);
    engine.finish();
    await Promise.resolve();
    expect(usePlaybackStore.getState().currentTrackId).toBe("a");
    expect(engine.time).toBe(0);
    expect(usePlaybackStore.getState().isPlaying).toBe(true);
  });

  it("lands the stored position on the true final time when the queue ends", async () => {
    usePlaybackStore.getState().playContext(["a"], 0, { type: "library", label: "L" });
    await waitForStore(() => usePlaybackStore.getState().status === "ready");
    engine.element = {} as HTMLAudioElement; // syncFromEngine reads the element
    // The last timeupdate before end may lag; engine reaches ~duration.
    usePlaybackStore.setState({ currentTimeMs: 110000 });
    engine.time = 120;
    engine.finish();
    await Promise.resolve();
    expect(usePlaybackStore.getState().status).toBe("ended");
    expect(usePlaybackStore.getState().isPlaying).toBe(false);
    expect(usePlaybackStore.getState().currentTimeMs).toBe(120000);
  });

  it("previous seeks to start when far into the track, otherwise goes back", async () => {
    usePlaybackStore.getState().playContext(["a", "b"], 1, { type: "library", label: "L" });
    await waitForStore(() => usePlaybackStore.getState().status === "ready" && usePlaybackStore.getState().currentTrackId === "b");
    engine.seekSec(10); // 10s in
    usePlaybackStore.getState().previous();
    expect(usePlaybackStore.getState().currentTrackId).toBe("b");
    expect(usePlaybackStore.getState().currentTimeMs).toBe(0);

    engine.seekSec(1);
    usePlaybackStore.getState().previous();
    await waitForStore(() => usePlaybackStore.getState().currentTrackId === "a" && usePlaybackStore.getState().status === "ready");
  });

  it("shuffle pins the current track and un-shuffle restores context order", async () => {
    usePlaybackStore.getState().playContext(["a", "b", "c"], 1, { type: "library", label: "L" });
    await waitForStore(() => usePlaybackStore.getState().currentTrackId === "b");

    usePlaybackStore.getState().toggleShuffle();
    const shuffled = usePlaybackStore.getState();
    expect(shuffled.shuffleEnabled).toBe(true);
    expect(shuffled.queueTrackIds[0]).toBe("b");
    expect(new Set(shuffled.queueTrackIds).size).toBe(3);

    usePlaybackStore.getState().toggleShuffle();
    const restored = usePlaybackStore.getState();
    expect(restored.shuffleEnabled).toBe(false);
    expect(restored.queueTrackIds).toEqual(["a", "b", "c"]);
    expect(restored.queueIndex).toBe(1);
  });

  it("play next and queue edits keep the current track stable", async () => {
    usePlaybackStore.getState().playContext(["a", "c"], 0, { type: "library", label: "L" });
    await waitForStore(() => usePlaybackStore.getState().currentTrackId === "a");

    usePlaybackStore.getState().playNext("b");
    expect(usePlaybackStore.getState().queueTrackIds).toEqual(["a", "b", "c"]);

    usePlaybackStore.getState().enqueue("x");
    expect(usePlaybackStore.getState().queueTrackIds).toEqual(["a", "b", "c", "x"]);

    usePlaybackStore.getState().removeFromQueue(2);
    expect(usePlaybackStore.getState().queueTrackIds).toEqual(["a", "b", "x"]);
    expect(usePlaybackStore.getState().queueIndex).toBe(0);
  });

  it("missing source marks the track and surfaces a recoverable error", async () => {
    usePlaybackStore.getState().playContext(["a", "ghost"], 0, { type: "library", label: "L" });
    await waitForStore(() => usePlaybackStore.getState().status === "ready");
    usePlaybackStore.getState().next(true);
    await waitForStore(() => usePlaybackStore.getState().status === "error");
    const state = usePlaybackStore.getState();
    expect(state.currentTrackId).toBe("ghost");
    expect(state.error?.action).toBe("relink");
    expect(state.isPlaying).toBe(false);
    // The store should mark the track unavailable for the library view.
    expect((await repository.getTrack("ghost"))?.availability).toBe("missing");
  });

  it("engine decode failures set an error state without throwing", async () => {
    usePlaybackStore.getState().playContext(["a"], 0, { type: "library", label: "L" });
    await waitForStore(() => usePlaybackStore.getState().status === "ready");
    engine.fail(3);
    const state = usePlaybackStore.getState();
    expect(state.status).toBe("error");
    expect(state.isPlaying).toBe(false);
    expect(state.error?.detail).toContain("decode");
  });

  it("play after a permission error re-attempts the same track instead of a stale source", async () => {
    let attempts = 0;
    bindPlaybackHelpers({
      resolveSource: async () => {
        attempts += 1;
        if (attempts === 1) {
          return { ok: false as const, reason: "permission-required" as const, detail: "needs permission again" };
        }
        return { ok: true as const, url: "blob:test-retry", release: () => undefined };
      },
    });

    usePlaybackStore.getState().playContext(["a", "b"], 0, { type: "library", label: "L" });
    await waitForStore(() => usePlaybackStore.getState().status === "error");

    const errored = usePlaybackStore.getState();
    expect(errored.error?.action).toBe("grant-permission");
    expect(errored.isPlaying).toBe(false);
    expect(errored.currentTrackId).toBe("a");
    expect(engine.src).toBeNull(); // no stale source was ever handed to the engine

    usePlaybackStore.getState().play();
    await waitForStore(() => usePlaybackStore.getState().status === "ready" && usePlaybackStore.getState().isPlaying);

    expect(attempts).toBe(2); // the failed track was retried, not skipped or faked
    expect(usePlaybackStore.getState().currentTrackId).toBe("a");
    expect(engine.src).toBe("blob:test-retry");
  });

  it("play during a non-recoverable error re-attempts resolution but never plays a stale source", async () => {
    let attempts = 0;
    bindPlaybackHelpers({
      resolveSource: async () => {
        attempts += 1;
        return { ok: false as const, reason: "missing" as const, detail: "file gone" };
      },
    });
    usePlaybackStore.getState().playContext(["a"], 0, { type: "library", label: "L" });
    await waitForStore(() => usePlaybackStore.getState().status === "error");
    expect(usePlaybackStore.getState().error?.action).toBe("relink");
    expect(attempts).toBe(1);

    engine.src = "blob:stale-leftover";
    engine.playing = false;
    usePlaybackStore.getState().play();
    await waitForStore(() => attempts === 2);
    expect(usePlaybackStore.getState().isPlaying).toBe(false);
    expect(usePlaybackStore.getState().status).toBe("error");
    // The engine was never told to play the stale source.
    expect(engine.playing).toBe(false);
    expect(engine.src).toBe("blob:stale-leftover");
  });

  it("syncFromEngine corrects store drift from the audio clock (tab-return resync)", () => {
    usePlaybackStore.setState({ currentTrackId: "a", status: "ready", currentTimeMs: 10000, durationMs: 120000 });
    engine.element = {} as HTMLAudioElement; // pretend the media element exists
    // Audio kept playing in a hidden tab: engine at 42.5s, store stuck at 10s.
    engine.time = 42.5;
    usePlaybackStore.getState().syncFromEngine();
    expect(usePlaybackStore.getState().currentTimeMs).toBe(42500);

    // Small drift (<750ms) is left alone — timeupdate stays authoritative.
    engine.time = 43.1;
    usePlaybackStore.getState().syncFromEngine();
    expect(usePlaybackStore.getState().currentTimeMs).toBe(42500);

    // No-ops when nothing is loaded.
    usePlaybackStore.setState({ currentTrackId: null, status: "idle" });
    engine.time = 99;
    usePlaybackStore.getState().syncFromEngine();
    expect(usePlaybackStore.getState().currentTimeMs).toBe(42500);
  });

  it("restores a saved queue without starting audio; the next play resumes", async () => {    usePlaybackStore.getState().restoreQueue({
      queueTrackIds: ["a", "b"],
      queueIndex: 1,
      contextTrackIds: ["a", "b"],
      context: { type: "library", label: "L" },
      currentTrackId: "b",
      positionMs: 42000,
    });
    let state = usePlaybackStore.getState();
    expect(state.currentTrackId).toBe("b");
    expect(state.isPlaying).toBe(false);
    expect(state.currentTimeMs).toBe(42000);
    expect(engine.src).toBeNull();

    usePlaybackStore.getState().play();
    await waitForStore(() => usePlaybackStore.getState().isPlaying);
    state = usePlaybackStore.getState();
    expect(state.currentTrackId).toBe("b");
    // The engine received the resume seek once duration was known.
    expect(usePlaybackStore.getState().currentTimeMs).toBeGreaterThanOrEqual(42000);
  });

  it("does not mark playback failed for an aborted load (code 1)", async () => {
    usePlaybackStore.getState().playContext(["a"], 0, { type: "library", label: "L" });
    await waitForStore(() => usePlaybackStore.getState().isPlaying);

    engine.fail(1);
    const state = usePlaybackStore.getState();
    expect(state.status).toBe("ready");
    expect(state.error).toBeNull();
    expect(state.isPlaying).toBe(true);
  });

  it("ignores a stale media error that fires while the next track is resolving", async () => {
    usePlaybackStore.getState().playContext(["a"], 0, { type: "library", label: "L" });
    await waitForStore(() => usePlaybackStore.getState().isPlaying);

    // startTrack("b") bumps the accepted generation synchronously, then
    // awaits resolution. An error from the still-loaded "a" source fires
    // inside that window and must not touch the new attempt.
    void usePlaybackStore.getState().startTrack("b", { autoplay: true });
    engine.fail(2);

    await waitForStore(() => usePlaybackStore.getState().currentTrackId === "b" && usePlaybackStore.getState().isPlaying);
    const state = usePlaybackStore.getState();
    expect(state.error).toBeNull();
    expect(state.status).toBe("ready");
    expect(engine.src).toContain("blob:");
  });

  it("ignores an error event from a superseded source generation", async () => {
    usePlaybackStore.getState().playContext(["a", "b"], 0, { type: "library", label: "L" });
    await waitForStore(() => usePlaybackStore.getState().isPlaying);
    usePlaybackStore.getState().next(true);
    await waitForStore(() => usePlaybackStore.getState().currentTrackId === "b" && usePlaybackStore.getState().isPlaying);
    const acceptedGeneration = engine.sourceGeneration;

    // An event stamped with the previous source's generation (as if the old
    // resource failed late) must not affect the current track.
    engine.sourceGen = acceptedGeneration - 1;
    engine.fail(3);
    engine.sourceGen = acceptedGeneration;

    const state = usePlaybackStore.getState();
    expect(state.error).toBeNull();
    expect(state.status).toBe("ready");
    expect(state.isPlaying).toBe(true);
  });

  it("still reports genuine decode and network errors on the active source", async () => {
    usePlaybackStore.getState().playContext(["a"], 0, { type: "library", label: "L" });
    await waitForStore(() => usePlaybackStore.getState().isPlaying);

    engine.fail(3);
    let state = usePlaybackStore.getState();
    expect(state.status).toBe("error");
    expect(state.isPlaying).toBe(false);
    expect(state.error?.title).toContain("Decod");

    usePlaybackStore.getState().clearError();
    usePlaybackStore.setState({ status: "ready" });
    engine.fail(2);
    state = usePlaybackStore.getState();
    expect(state.status).toBe("error");
    expect(state.error).not.toBeNull();
  });

  it("does not surface a playback error when play() is interrupted (AbortError)", async () => {
    usePlaybackStore.getState().playContext(["a"], 0, { type: "library", label: "L" });
    await waitForStore(() => usePlaybackStore.getState().isPlaying);

    // Start track b, then pause() interrupts the in-flight play() request.
    engine.playError = new DOMException("The play() request was interrupted", "AbortError");
    void usePlaybackStore.getState().startTrack("b", { autoplay: true });
    await waitForStore(() => usePlaybackStore.getState().currentTrackId === "b");
    engine.playError = null;
    await waitForStore(() => usePlaybackStore.getState().status !== "loading");

    const state = usePlaybackStore.getState();
    expect(state.status).toBe("ready");
    expect(state.error).toBeNull();
  });
});

function waitForStore(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("Store condition not met in time"));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}
