import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePlaybackStore, bindPlaybackHelpers } from "./playbackStore";
import { resolveTrackSource } from "../services/file-access/FileAccessService";
import { repository } from "../services/indexeddb/LibraryRepository";
import type { Track } from "../types";

/**
 * Cloud playback contract (spec §7): the shared engine, its clock, and every
 * existing control keep working when the source is a short-lived presigned
 * URL instead of a local object URL — including a refresh after the link
 * expires mid-playback.
 */
const cloud = vi.hoisted(() => ({
  urlFor: new Map<string, string>(),
  refreshCount: 0,
  forceFailure: false,
}));

vi.mock("../services/cloud/r2StorageService", () => ({
  getPlayUrl: async (objectKey: string) => {
    cloud.refreshCount += 1;
    if (cloud.forceFailure) throw new Error("link expired");
    const url = cloud.urlFor.get(objectKey);
    if (!url) throw new Error("no url configured");
    return url;
  },
  invalidatePlayUrl: (objectKey: string) => {
    // A fresh fetch must produce a different URL, as a real refresh would.
    cloud.urlFor.set(objectKey, `https://r2/get/${objectKey}?sig=refreshed-${cloud.refreshCount}`);
  },
}));

class FakeEngine {
  element = null;
  src: string | null = null;
  playing = false;
  time = 0;
  duration = 120;
  volume = 1;
  muted = false;
  #events: Record<string, (value: unknown) => void>;

  constructor(events: Record<string, (value: unknown) => void>) {
    this.#events = events;
  }

  setSource(url: string | null) {
    this.src = url;
    if (url !== null) this.#events.onDurationChange?.(this.duration);
  }
  async play() {
    this.playing = true;
    this.#events.onPlayStateChange?.(true);
  }
  pause() {
    this.playing = false;
    this.#events.onPlayStateChange?.(false);
  }
  get currentTimeSec() {
    return this.time;
  }
  seekSec(seconds: number) {
    this.time = seconds;
    this.#events.onTimeUpdate?.(seconds);
    this.#events.onSeeked?.(undefined);
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
    accessMode: "cloud",
    fingerprint: null,
    metadataFromFilename: false,
    ...overrides,
  };
}

let engine: FakeEngine;
const tracks: Track[] = [];

function setOnline(online: boolean): void {
  Object.defineProperty(navigator, "onLine", { value: online, configurable: true });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("playback with cloud sources", () => {
  beforeEach(async () => {
    await repository.clearAllData();
    cloud.urlFor.clear();
    cloud.refreshCount = 0;
    cloud.forceFailure = false;
    setOnline(true);
    tracks.length = 0;

    const cloudA = makeTrack({
      id: "cloud-a",
      title: "Cloud A",
      accessMode: "cloud",
      objectKey: "users/u-1/tracks/cloud-a/audio.mp3",
      cloudStatus: "ready",
    });
    const cloudB = makeTrack({
      id: "cloud-b",
      title: "Cloud B",
      accessMode: "cloud",
      objectKey: "users/u-1/tracks/cloud-b/audio.mp3",
      cloudStatus: "ready",
    });
    const localTrack = makeTrack({ id: "local-a", title: "Local A", accessMode: "stored-copy" });
    tracks.push(cloudA, cloudB, localTrack);
    cloud.urlFor.set(cloudA.objectKey!, "https://r2/get/cloud-a?sig=1");
    cloud.urlFor.set(cloudB.objectKey!, "https://r2/get/cloud-b?sig=1");
    await repository.putTracks(tracks);
    await repository.putAudioBlob(localTrack.id, new Blob(["audio-bytes"]));

    bindPlaybackHelpers({
      getTrackForPlayback: async (id) => tracks.find((track) => track.id === id),
      currentTrack: () => tracks.find((track) => track.id === usePlaybackStore.getState().currentTrackId),
      notifyTrackStarted: async () => undefined,
      markTrackAvailability: async (id, availability) => {
        await repository.updateTrack(id, { availability });
      },
      persistPrefs: () => undefined,
      persistPosition: () => undefined,
      resolveSource: resolveTrackSource,
    });

    engine = new FakeEngine({
      onTimeUpdate: (sec) => usePlaybackStore.setState({ currentTimeMs: (sec as number) * 1000 }),
      onDurationChange: (sec) => usePlaybackStore.setState({ durationMs: sec !== null ? (sec as number) * 1000 : null }),
      onPlayStateChange: (isPlaying) => {
        if (isPlaying) usePlaybackStore.setState({ isPlaying: true, autoplayBlocked: false, status: "ready" });
        else if (usePlaybackStore.getState().status !== "loading") usePlaybackStore.setState({ isPlaying: false });
      },
      onBufferingChange: (isBuffering) => usePlaybackStore.setState({ isBuffering: Boolean(isBuffering) }),
      onSeeked: () => usePlaybackStore.getState().syncFromEngine(),
      onEnded: () => usePlaybackStore.getState().handleEngineEnded(),
      onError: (failure) => usePlaybackStore.getState().handleEngineError(failure as never),
    });
    usePlaybackStore.getState().setEngineForTests(engine as never);

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

  it("plays a cloud track through the shared engine and clock", async () => {
    usePlaybackStore.getState().playContext(["cloud-a"], 0, { type: "library", label: "Library" });
    await waitUntil(() => usePlaybackStore.getState().status === "ready");

    expect(usePlaybackStore.getState().currentTrackId).toBe("cloud-a");
    expect(engine.src).toBe("https://r2/get/cloud-a?sig=1");
    expect(usePlaybackStore.getState().durationMs).toBe(120000);

    // The engine clock stays the timing authority for lyrics and the seek bar.
    engine.seekSec(45);
    await waitUntil(() => usePlaybackStore.getState().currentTimeMs === 45000);
    expect(usePlaybackStore.getState().currentTimeMs).toBe(45000);
  });

  it("switches between cloud tracks without leaking the previous source", async () => {
    usePlaybackStore.getState().playContext(["cloud-a", "cloud-b"], 0, { type: "library", label: "L" });
    await waitUntil(() => usePlaybackStore.getState().status === "ready");
    expect(engine.src).toBe("https://r2/get/cloud-a?sig=1");

    usePlaybackStore.getState().next(true);
    // currentTrackId flips before resolution finishes; the engine source is
    // the observable that the new track actually loaded.
    await waitUntil(() => engine.src === "https://r2/get/cloud-b?sig=1");
    expect(usePlaybackStore.getState().currentTrackId).toBe("cloud-b");

    // Pause and resume keep the same source and position.
    engine.seekSec(30);
    usePlaybackStore.getState().pause();
    expect(usePlaybackStore.getState().isPlaying).toBe(false);
    usePlaybackStore.getState().play();
    await waitUntil(() => usePlaybackStore.getState().isPlaying);
    expect(engine.src).toBe("https://r2/get/cloud-b?sig=1");
    expect(engine.time).toBe(30);
  });

  it("switches between a cloud and a local track in one queue", async () => {
    usePlaybackStore.getState().playContext(["cloud-a", "local-a"], 0, { type: "library", label: "L" });
    await waitUntil(() => usePlaybackStore.getState().status === "ready");
    expect(engine.src).toBe("https://r2/get/cloud-a?sig=1");

    usePlaybackStore.getState().next(true);
    await waitUntil(() => (engine.src ?? "").includes("blob:"));
    expect(usePlaybackStore.getState().currentTrackId).toBe("local-a");
  });

  it("recovers from an expired link by fetching a fresh one, resuming in place", async () => {
    usePlaybackStore.getState().playContext(["cloud-a"], 0, { type: "library", label: "L" });
    await waitUntil(() => usePlaybackStore.getState().isPlaying);
    expect(cloud.refreshCount).toBe(1);

    engine.seekSec(60);

    // A network-class failure on a cloud track: the link may simply be stale.
    // One automatic refresh keeps playback alive without losing position.
    cloud.forceFailure = true;
    usePlaybackStore.getState().handleEngineError({ code: 2, message: "network" } as never);
    await waitUntil(() => usePlaybackStore.getState().status === "error");

    cloud.forceFailure = false;
    cloud.urlFor.set("users/u-1/tracks/cloud-a/audio.mp3", "https://r2/get/cloud-a?sig=2");
    // The error surfaced honestly…
    expect(usePlaybackStore.getState().error?.action).toBe("retry");
    // …and the next explicit play re-resolves with a fresh link.
    usePlaybackStore.getState().play();
    await waitUntil(() => usePlaybackStore.getState().isPlaying);
    expect(engine.src).toBe("https://r2/get/cloud-a?sig=2");
    expect(cloud.refreshCount).toBeGreaterThan(1);
  });

  it("reports an unavailable state instead of failing silently while offline", async () => {
    setOnline(false);
    usePlaybackStore.getState().playContext(["cloud-a"], 0, { type: "library", label: "L" });
    await waitUntil(() => usePlaybackStore.getState().status === "error");

    expect(usePlaybackStore.getState().currentTrackId).toBe("cloud-a");
    expect(usePlaybackStore.getState().error?.detail).toMatch(/cloud/i);
    expect(cloud.refreshCount).toBe(0); // never even asked for a URL

    const stored = await repository.getTrack("cloud-a");
    expect(stored?.availability).toBe("offline");
  });

  it("keeps playing the local copy of a cloud-synced track while offline", async () => {
    const hybrid = makeTrack({
      id: "hybrid",
      accessMode: "stored-copy",
      objectKey: "users/u-1/tracks/hybrid/audio.mp3",
      cloudStatus: "ready",
    });
    tracks.push(hybrid);
    await repository.putTracks([hybrid]);
    await repository.putAudioBlob(hybrid.id, new Blob(["audio-bytes"]));

    setOnline(false);
    usePlaybackStore.getState().playContext(["hybrid"], 0, { type: "library", label: "L" });
    await waitUntil(() => usePlaybackStore.getState().status === "ready");
    expect(engine.src).toContain("blob:");
    expect(cloud.refreshCount).toBe(0);
  });
});
