import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePlaybackStore, bindPlaybackHelpers } from "../../stores/playbackStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { useDynamicIslandStore } from "../../stores/dynamicIslandStore";
import { revalidateAccess } from "../../services/file-access/FileAccessService";
import { repository } from "../../services/indexeddb/LibraryRepository";
import type { Track } from "../../types";

function createMockTrack(id: string, overrides: Partial<Track> = {}): Track {
  return {
    id,
    title: `Track ${id}`,
    artist: "Test Artist",
    album: "Test Album",
    trackNumber: 1,
    albumTrackCount: 1,
    durationMs: 180000,
    fileName: `${id}.mp3`,
    fileSize: 1024,
    mimeType: "audio/mpeg",
    addedAt: Date.now(),
    lastPlayedAt: null,
    playCount: 0,
    isLiked: false,
    availability: "available",
    accessMode: "stored-copy",
    fingerprint: `fp-${id}`,
    metadataFromFilename: false,
    ...overrides,
  };
}

describe("Playback error classification, Broken track detection & Dynamic Island notifications", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    useDynamicIslandStore.getState().reset();
    usePlaybackStore.setState({
      currentTrackId: null,
      isPlaying: false,
      status: "idle",
      error: null,
      autoplayBlocked: false,
    });
    await repository.clearAllData();
  });

  afterEach(() => {
    vi.useRealTimers();
    useDynamicIslandStore.getState().reset();
  });

  it("classifies unsupported audio format (MediaError code 4) as permanent broken track and shows notification", () => {
    const track = createMockTrack("unsupported-1");
    let brokenMarked: { category: string; description: string; originalMessage?: string; errorCode?: string } | null = null;

    bindPlaybackHelpers({
      currentTrack: () => track,
      markTrackBroken: async (_id, info) => {
        brokenMarked = info;
      },
    });

    usePlaybackStore.getState().handleEngineError({ code: 4, message: "Format not supported" });

    expect(brokenMarked).toEqual({
      category: "unsupported",
      description: "This audio format is not supported.",
      summary: "This audio format is not supported.",
      originalMessage: "MEDIA_ERR_SRC_NOT_SUPPORTED (4): Format not supported",
      errorCode: "MEDIA_ERR_SRC_NOT_SUPPORTED (4)",
    });

    const notif = useDynamicIslandStore.getState().current;
    expect(notif).not.toBeNull();
    expect(notif?.title).toBe("Unsupported audio");
    expect(notif?.description).toBe("This audio format is not supported.");
    expect(notif?.category).toBe("unsupported");
    expect(notif?.song).toBe("Track unsupported-1 — Test Artist");
  });

  it("classifies audio decoding failure (MediaError code 3) as permanent broken track", () => {
    const track = createMockTrack("decode-fail-1");
    let brokenMarked: { category: string; description: string; originalMessage?: string; errorCode?: string } | null = null;

    bindPlaybackHelpers({
      currentTrack: () => track,
      markTrackBroken: async (_id, info) => {
        brokenMarked = info;
      },
    });

    usePlaybackStore.getState().handleEngineError({ code: 3, message: "Decode error" });

    expect(brokenMarked).toEqual({
      category: "decoding",
      description: "The audio file could not be decoded.",
      summary: "The audio file could not be decoded.",
      originalMessage: "MEDIA_ERR_DECODE (3): Decode error",
      errorCode: "MEDIA_ERR_DECODE (3)",
    });

    const notif = useDynamicIslandStore.getState().current;
    expect(notif).not.toBeNull();
    expect(notif?.title).toBe("Playback failed");
    expect(notif?.description).toBe("The audio file could not be decoded.");
    expect(notif?.category).toBe("decoding");
  });

  it("classifies corrupted audio (code 0 / general permanent error) as broken", () => {
    const track = createMockTrack("corrupt-1");
    let brokenMarked: { category: string; description: string; originalMessage?: string; errorCode?: string } | null = null;

    bindPlaybackHelpers({
      currentTrack: () => track,
      markTrackBroken: async (_id, info) => {
        brokenMarked = info;
      },
    });

    usePlaybackStore.getState().handleEngineError({ code: 0, message: "File data corrupted" });

    expect(brokenMarked).toEqual({
      category: "corrupted",
      description: "This audio file appears to be damaged.",
      summary: "This audio file appears to be damaged.",
      originalMessage: "MEDIA_ERR (0): File data corrupted",
      errorCode: "MEDIA_ERR (0)",
    });

    const notif = useDynamicIslandStore.getState().current;
    expect(notif?.title).toBe("Damaged audio");
    expect(notif?.description).toBe("This audio file appears to be damaged.");
    expect(notif?.category).toBe("corrupted");
  });

  it("classifies missing local audio source as broken missing category", async () => {
    const track = createMockTrack("missing-src-1", { accessMode: "stored-copy" });
    let brokenMarked: { category: string; description: string; originalMessage?: string; errorCode?: string } | null = null;

    bindPlaybackHelpers({
      getTrackForPlayback: async () => track,
      resolveSource: async () => ({
        ok: false as const,
        reason: "missing" as const,
        detail: "The audio file is not available in this session.",
      }),
      markTrackBroken: async (_id, info) => {
        brokenMarked = info;
      },
      markTrackAvailability: async () => {},
    });

    await usePlaybackStore.getState().startTrack(track.id, { autoplay: true });

    expect(brokenMarked).toEqual({
      category: "missing",
      description: "The audio file could not be found or opened.",
      summary: "The audio file could not be found or opened.",
      originalMessage: "The audio file is not available in this session.",
      errorCode: "NotFoundError",
    });

    const notif = useDynamicIslandStore.getState().current;
    expect(notif?.title).toBe("Audio not found");
    expect(notif?.description).toBe("The audio file could not be found or opened.");
    expect(notif?.category).toBe("missing");
  });

  it("treats network errors (code 2) as transient and does NOT mark track as broken", () => {
    const track = createMockTrack("net-fail-1", { accessMode: "cloud", objectKey: "some/key" });
    let brokenMarked = false;

    bindPlaybackHelpers({
      currentTrack: () => track,
      markTrackBroken: async () => {
        brokenMarked = true;
      },
    });

    usePlaybackStore.getState().handleEngineError({ code: 2, message: "Network error" });

    expect(brokenMarked).toBe(false);
    const notif = useDynamicIslandStore.getState().current;
    expect(notif?.title).toBe("Network error");
    expect(notif?.description).toBe("A network error interrupted loading.");
  });

  it("treats browser autoplay rejection as transient and does NOT mark track as broken", async () => {
    const track = createMockTrack("autoplay-1");
    let brokenMarked = false;

    const { AutoplayBlockedError } = await import("../../services/audio/engine");

    bindPlaybackHelpers({
      getTrackForPlayback: async () => track,
      resolveSource: async () => ({
        ok: true as const,
        url: "blob:mock",
        release: () => {},
      }),
      markTrackBroken: async () => {
        brokenMarked = true;
      },
      markTrackAvailability: async () => {},
      notifyTrackStarted: async () => {},
    });

    usePlaybackStore.getState().setEngineForTests({
      element: null,
      setSource: () => {},
      play: async () => {
        throw new AutoplayBlockedError();
      },
      pause: () => {},
      currentTimeSec: 0,
      seekSec: () => {},
      durationSec: 180,
      setVolume: () => {},
      setMuted: () => {},
      dispose: () => {},
    });

    await usePlaybackStore.getState().startTrack(track.id, { autoplay: true });

    expect(brokenMarked).toBe(false);
    expect(usePlaybackStore.getState().autoplayBlocked).toBe(true);

    const notif = useDynamicIslandStore.getState().current;
    expect(notif?.title).toBe("Autoplay blocked");
  });

  it("persists broken status across page reloads via revalidateAccess and store", async () => {
    const brokenTrack: Track = createMockTrack("persisted-broken", {
      availability: "broken",
      broken: {
        isBroken: true,
        category: "corrupted",
        description: "File corrupted",
        failedAt: Date.now(),
        retryCount: 1,
      },
    });

    const updates = await revalidateAccess([brokenTrack]);
    expect(updates.get(brokenTrack.id)).toBe("broken");

    await repository.putTracks([brokenTrack]);
    const stored = await repository.getTrack(brokenTrack.id);
    expect(stored?.availability).toBe("broken");
    expect(stored?.broken?.isBroken).toBe(true);
    expect(stored?.broken?.category).toBe("corrupted");
  });

  it("recovers broken status when playback succeeds", async () => {
    const brokenTrack = createMockTrack("recover-1", {
      availability: "broken",
      broken: {
        isBroken: true,
        category: "corrupted",
        description: "Previously broken",
        failedAt: Date.now(),
        retryCount: 1,
      },
    });

    useLibraryStore.setState({
      tracks: [brokenTrack],
      status: "ready",
    });

    let restoredId: string | null = null;
    bindPlaybackHelpers({
      getTrackForPlayback: async () => brokenTrack,
      resolveSource: async () => ({
        ok: true as const,
        url: "blob:mock",
        release: () => {},
      }),
      restoreBrokenTrack: async (id) => {
        restoredId = id;
      },
      markTrackAvailability: async () => {},
      notifyTrackStarted: async () => {},
    });

    usePlaybackStore.getState().setEngineForTests({
      element: null,
      setSource: () => {},
      play: async () => {},
      pause: () => {},
      currentTimeSec: 0,
      seekSec: () => {},
      durationSec: 180,
      setVolume: () => {},
      setMuted: () => {},
      dispose: () => {},
    });

    await usePlaybackStore.getState().startTrack(brokenTrack.id, { autoplay: true });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(restoredId).toBe("recover-1");
  });

  it("suppresses duplicate notifications for the same track and error", () => {
    const store = useDynamicIslandStore.getState();

    store.showNotification({
      title: "Playback failed",
      description: "Corrupted file",
      trackId: "t1",
    });

    const first = useDynamicIslandStore.getState().current;
    expect(first).not.toBeNull();
    expect(useDynamicIslandStore.getState().queue).toHaveLength(0);

    // Identical error for same track
    store.showNotification({
      title: "Playback failed",
      description: "Corrupted file",
      trackId: "t1",
    });

    // Still only the first notification, queue is still empty
    expect(useDynamicIslandStore.getState().current?.id).toBe(first?.id);
    expect(useDynamicIslandStore.getState().queue).toHaveLength(0);
  });

  it("queues distinct errors up to bounded capacity", () => {
    const store = useDynamicIslandStore.getState();

    store.showNotification({ title: "Error 1", description: "Desc 1", trackId: "t1" });
    store.showNotification({ title: "Error 2", description: "Desc 2", trackId: "t2" });
    store.showNotification({ title: "Error 3", description: "Desc 3", trackId: "t3" });
    store.showNotification({ title: "Error 4", description: "Desc 4", trackId: "t4" });

    // Current is Error 1, queue holds at most 3 items
    expect(useDynamicIslandStore.getState().current?.title).toBe("Error 1");
    expect(useDynamicIslandStore.getState().queue.length).toBeLessThanOrEqual(3);
  });

  it("handles auto-dismiss after 3000ms and advances queue", () => {
    vi.useFakeTimers();
    try {
      const store = useDynamicIslandStore.getState();

      store.showNotification({ title: "First error", description: "Desc", trackId: "t1" });
      store.showNotification({ title: "Second error", description: "Desc", trackId: "t2" });

      // Transition from initial to expanded (60ms)
      vi.advanceTimersByTime(60);
      expect(useDynamicIslandStore.getState().stage).toBe("expanded");

      // Auto-dismiss timeout (3000ms)
      vi.advanceTimersByTime(3000);
      expect(useDynamicIslandStore.getState().stage).toBe("collapsing");

      // Collapse animation duration (240ms)
      vi.advanceTimersByTime(240);
      // Dequeued next notification!
      expect(useDynamicIslandStore.getState().current?.title).toBe("Second error");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up timers and state when manually dismissed", () => {
    vi.useFakeTimers();
    try {
      const store = useDynamicIslandStore.getState();

      store.showNotification({ title: "Manual dismiss error", description: "Desc", trackId: "t1" });
      vi.advanceTimersByTime(60);
      expect(useDynamicIslandStore.getState().stage).toBe("expanded");

      store.dismissNotification();
      expect(useDynamicIslandStore.getState().stage).toBe("collapsing");

      vi.advanceTimersByTime(240);
      expect(useDynamicIslandStore.getState().current).toBeNull();
      expect(useDynamicIslandStore.getState().stage).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up on unmount / reset", () => {
    const store = useDynamicIslandStore.getState();

    store.showNotification({ title: "Timer error", description: "Desc", trackId: "t1" });
    expect(useDynamicIslandStore.getState().current).not.toBeNull();

    store.reset();
    expect(useDynamicIslandStore.getState().current).toBeNull();
    expect(useDynamicIslandStore.getState().stage).toBe("idle");
    expect(useDynamicIslandStore.getState().queue).toHaveLength(0);
  });

  it("surfaces specific 'Grant access to this audio file.' notification on permission-required without marking track broken", async () => {
    const track = createMockTrack("perm-track", { accessMode: "handle", availability: "permission-required" });
    let brokenMarked = false;
    let availabilityMarked: string | null = null;

    bindPlaybackHelpers({
      getTrackForPlayback: async () => track,
      resolveSource: async () => ({
        ok: false as const,
        reason: "permission-required" as const,
        detail: "Grant access to this audio file.",
        originalError: "PermissionState: prompt",
      }),
      markTrackBroken: async () => {
        brokenMarked = true;
      },
      markTrackAvailability: async (_id, avail) => {
        availabilityMarked = avail;
      },
    });

    await usePlaybackStore.getState().startTrack(track.id, { autoplay: true });

    expect(brokenMarked).toBe(false);
    expect(availabilityMarked).toBe("permission-required");
    const notif = useDynamicIslandStore.getState().current;
    expect(notif?.title).toBe("Grant access to this audio file.");
    expect(notif?.category).toBe("permission");
  });

  it("requests handle permission within the Play gesture for handle-backed tracks and plays when granted", async () => {
    const track = createMockTrack("handle-recover", { accessMode: "handle", availability: "permission-required" });
    let permissionState: "prompt" | "granted" = "prompt";
    const requestPermission = vi.fn(async () => {
      permissionState = "granted";
      return "granted" as const;
    });
    vi.spyOn(repository, "getHandle").mockResolvedValue({
      queryPermission: async () => permissionState,
      requestPermission,
      getFile: async () => new File([new Uint8Array(8)], "song.mp3", { type: "audio/mpeg" }),
    } as unknown as FileSystemFileHandle);

    let availabilityMarked: string | null = null;
    bindPlaybackHelpers({
      getTrackForPlayback: async () => track,
      resolveSource: async () => ({
        ok: permissionState === "granted",
        url: "blob:recovered",
        release: () => {},
      } as never),
      markTrackAvailability: async (_id, avail) => {
        availabilityMarked = avail;
      },
      notifyTrackStarted: async () => {},
    });

    usePlaybackStore.getState().setEngineForTests({
      element: null,
      setSource: () => {},
      play: async () => {},
      pause: () => {},
      currentTimeSec: 0,
      seekSec: () => {},
      durationSec: 180,
      setVolume: () => {},
      setMuted: () => {},
      dispose: () => {},
    });

    await usePlaybackStore.getState().startTrack(track.id, { autoplay: true });

    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(availabilityMarked).toBe("available");
    expect(usePlaybackStore.getState().isPlaying).toBe(true);
    vi.restoreAllMocks();
  });

  it("surfaces 'Could not retrieve the cloud audio.' when cloud source fails without marking track broken", async () => {
    const track = createMockTrack("cloud-err", {
      accessMode: "cloud",
      objectKey: "users/u-1/tracks/cloud-err/audio.mp3",
      cloudStatus: "ready",
    });
    let brokenMarked = false;

    bindPlaybackHelpers({
      getTrackForPlayback: async () => track,
      resolveSource: async () => ({
        ok: false as const,
        reason: "missing" as const,
        detail: "Could not retrieve the cloud audio.",
        originalError: "Error: network failed",
      }),
      markTrackBroken: async () => {
        brokenMarked = true;
      },
      markTrackAvailability: async () => {},
    });

    await usePlaybackStore.getState().startTrack(track.id, { autoplay: true });

    expect(brokenMarked).toBe(false);
    const notif = useDynamicIslandStore.getState().current;
    expect(notif?.title).toBe("Could not retrieve the cloud audio.");
    expect(notif?.category).toBe("network");
  });
});
