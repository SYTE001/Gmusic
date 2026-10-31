import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../../types";
import { repository } from "../indexeddb/LibraryRepository";
import {
  hasSessionFile,
  revalidateAccess,
  rememberSessionFile,
  resolveTrackSource,
} from "./FileAccessService";

/**
 * Resolution order is the core of the offline-first contract: local bytes
 * always win, the cloud is a fallback, and a cloud track with no local copy
 * must report an honest offline state rather than failing silently.
 */
const playUrls = vi.hoisted(() => ({
  keyToUrl: new Map<string, string>(),
  refreshCount: 0,
  failFor: null as string | null,
}));

vi.mock("../cloud/r2StorageService", () => ({
  getPlayUrl: async (objectKey: string) => {
    playUrls.refreshCount += 1;
    if (playUrls.failFor === objectKey) {
      throw new Error("network failed");
    }
    const url = playUrls.keyToUrl.get(objectKey);
    if (!url) throw new Error("no url configured");
    return url;
  },
  invalidatePlayUrl: () => undefined,
}));

/**
 * File System Access handles are platform objects that cannot be built
 * directly in tests, so handle-backed paths spy on the repository accessor
 * with a minimal stand-in instead of persisting a real handle.
 */
function stubHandle(permission: "granted" | "prompt" | "denied", getFile: () => Promise<File>): FileSystemFileHandle {
  return {
    queryPermission: async () => permission,
    getFile,
  } as unknown as FileSystemFileHandle;
}

function brokenHandle(permission: "granted" | "prompt" | "denied"): FileSystemFileHandle {
  return stubHandle(permission, async () => {
    throw new DOMException("The file could not be found.", "NotFoundError");
  });
}

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: `t-${Math.random().toString(36).slice(2, 8)}`,
    title: "Song",
    artist: "Artist",
    album: "Album",
    trackNumber: null,
    albumTrackCount: null,
    durationMs: 60000,
    fileName: "song.mp3",
    fileSize: 1000,
    mimeType: "audio/mpeg",
    addedAt: Date.now(),
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

function setOnline(online: boolean): void {
  Object.defineProperty(navigator, "onLine", { value: online, configurable: true });
}

describe("resolution order (local first, cloud as fallback)", () => {
  beforeEach(async () => {
    await repository.clearAllData();
    playUrls.keyToUrl.clear();
    playUrls.refreshCount = 0;
    playUrls.failFor = null;
    setOnline(true);
  });

  it("uses a local stored copy even when a cloud copy exists", async () => {
    const track = makeTrack({
      id: "both",
      accessMode: "stored-copy",
      objectKey: "users/u-1/tracks/both/audio.mp3",
      cloudStatus: "ready",
    });
    await repository.putTracks([track]);
    await repository.putAudioBlob(track.id, new Blob([new Uint8Array(8)], { type: "audio/mpeg" }));

    const resolved = await resolveTrackSource(track);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.url).toContain("blob:");
      // The cloud was never contacted: local bytes win and no refresh ran.
      expect(playUrls.refreshCount).toBe(0);
    }
  });

  it("falls back to the cloud when no local copy exists", async () => {
    const track = makeTrack({ id: "cloud-only", accessMode: "cloud", objectKey: "users/u-1/tracks/cloud-only/audio.mp3" });
    await repository.putTracks([track]);
    playUrls.keyToUrl.set(track.objectKey!, "https://r2/get?sig=a");

    const resolved = await resolveTrackSource(track);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.url).toBe("https://r2/get?sig=a");
  });

  it("reports a clear offline state for an uncached cloud track", async () => {
    setOnline(false);
    const track = makeTrack({ id: "offline-cloud", accessMode: "cloud", objectKey: "users/u-1/tracks/offline-cloud/audio.mp3" });
    await repository.putTracks([track]);

    const resolved = await resolveTrackSource(track);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.reason).toBe("offline");
      expect(resolved.detail).toMatch(/cloud/i);
    }
    expect(playUrls.refreshCount).toBe(0);
  });

  it("survives a cloud fetch failure with a recoverable missing state", async () => {
    const track = makeTrack({ id: "cloud-broken", accessMode: "cloud", objectKey: "users/u-1/tracks/cloud-broken/audio.mp3" });
    await repository.putTracks([track]);
    playUrls.failFor = track.objectKey ?? null;

    const resolved = await resolveTrackSource(track);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toBe("missing");
  });

  it("keeps working for pre-cloud libraries: session file, no cloud key", async () => {
    const track = makeTrack({ id: "legacy", accessMode: "session-only" });
    const file = new File([new Uint8Array(8)], "song.mp3", { type: "audio/mpeg" });
    rememberSessionFile(track.id, file);

    const resolved = await resolveTrackSource(track);
    expect(resolved.ok).toBe(true);
    expect(hasSessionFile(track.id)).toBe(true);
  });

  it("keeps working for pre-cloud libraries: stored copy, no cloud key", async () => {
    const track = makeTrack({ id: "legacy-stored", accessMode: "stored-copy" });
    await repository.putTracks([track]);
    await repository.putAudioBlob(track.id, new Blob([new Uint8Array(8)], { type: "audio/mpeg" }));

    const resolved = await resolveTrackSource(track);
    expect(resolved.ok).toBe(true);
  });

  it("reports missing when a legacy track has nothing reachable", async () => {
    const track = makeTrack({ id: "legacy-gone", accessMode: "session-only" });
    const resolved = await resolveTrackSource(track);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toBe("missing");
  });
});

describe("broken handle fallback (a stale handle never masks a playable copy)", () => {
  beforeEach(async () => {
    await repository.clearAllData();
    playUrls.keyToUrl.clear();
    playUrls.refreshCount = 0;
    playUrls.failFor = null;
    setOnline(true);
    vi.restoreAllMocks();
  });

  it("plays from the stored copy when the granted handle's file is gone", async () => {
    const track = makeTrack({ id: "stale-handle", accessMode: "handle" });
    await repository.putTracks([track]);
    await repository.putAudioBlob(track.id, new Blob([new Uint8Array(8)], { type: "audio/mpeg" }));
    vi.spyOn(repository, "getHandle").mockResolvedValue(brokenHandle("granted"));

    const resolved = await resolveTrackSource(track);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.url).toContain("blob:");
  });

  it("plays from the cloud when the handle's file is gone and nothing is stored", async () => {
    const track = makeTrack({
      id: "stale-handle-cloud",
      accessMode: "handle",
      objectKey: "users/u-1/tracks/stale-handle-cloud/audio.mp3",
      cloudStatus: "ready",
    });
    await repository.putTracks([track]);
    playUrls.keyToUrl.set(track.objectKey!, "https://r2/get?sig=b");
    vi.spyOn(repository, "getHandle").mockResolvedValue(brokenHandle("granted"));

    const resolved = await resolveTrackSource(track);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.url).toBe("https://r2/get?sig=b");
      expect(playUrls.refreshCount).toBe(1);
    }
  });

  it("plays the stored copy without any permission when the handle is not granted", async () => {
    const track = makeTrack({ id: "prompt-handle", accessMode: "handle" });
    await repository.putTracks([track]);
    await repository.putAudioBlob(track.id, new Blob([new Uint8Array(8)]));
    vi.spyOn(repository, "getHandle").mockResolvedValue(stubHandle("prompt", async () => new File([new Uint8Array(4)], "song.mp3")));

    const resolved = await resolveTrackSource(track);
    expect(resolved.ok).toBe(true);
  });

  it("still reports permission-required when the handle is ungranted and no other copy exists", async () => {
    const track = makeTrack({ id: "prompt-only", accessMode: "handle" });
    vi.spyOn(repository, "getHandle").mockResolvedValue(stubHandle("prompt", async () => new File([new Uint8Array(4)], "song.mp3")));

    const resolved = await resolveTrackSource(track);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.reason).toBe("permission-required");
      expect(resolved.detail).toMatch(/permission|access/i);
    }
  });
});

describe("availability revalidation", () => {
  beforeEach(async () => {
    await repository.clearAllData();
    setOnline(true);
    vi.restoreAllMocks();
  });

  it("marks a cloud-only track available while online, offline while offline", async () => {
    const track = makeTrack({ id: "cloud-revalidate", accessMode: "cloud", objectKey: "users/u-1/tracks/cloud-revalidate/audio.mp3" });
    await repository.putTracks([track]);

    const online = await revalidateAccess([track]);
    expect(online.get(track.id)).toBe("available");

    setOnline(false);
    const offline = await revalidateAccess([track]);
    expect(offline.get(track.id)).toBe("offline");
  });

  it("keeps validating pre-cloud access modes exactly as before", async () => {
    const stored = makeTrack({ id: "stored", accessMode: "stored-copy" });
    const handleless = makeTrack({ id: "handleless", accessMode: "handle" });
    const sessionless = makeTrack({ id: "sessionless", accessMode: "session-only" });
    await repository.putTracks([stored, handleless, sessionless]);
    await repository.putAudioBlob(stored.id, new Blob([new Uint8Array(4)]));

    const updates = await revalidateAccess([stored, handleless, sessionless]);
    expect(updates.get(stored.id)).toBe("available");
    expect(updates.get(handleless.id)).toBe("missing"); // no handle persisted
    expect(updates.get(sessionless.id)).toBe("missing"); // no session file
  });

  it("does not treat a cloud track as offline when a local copy exists", async () => {
    const track = makeTrack({
      id: "hybrid",
      accessMode: "stored-copy",
      objectKey: "users/u-1/tracks/hybrid/audio.mp3",
      cloudStatus: "ready",
    });
    await repository.putTracks([track]);
    await repository.putAudioBlob(track.id, new Blob([new Uint8Array(4)]));

    setOnline(false);
    const updates = await revalidateAccess([track]);
    expect(updates.get(track.id)).toBe("available");
  });

  it("keeps a handle track playable from its stored copy despite a pending permission", async () => {
    const track = makeTrack({ id: "revalidate-prompt", accessMode: "handle" });
    await repository.putTracks([track]);
    await repository.putAudioBlob(track.id, new Blob([new Uint8Array(4)]));
    vi.spyOn(repository, "getHandle").mockResolvedValue(stubHandle("prompt", async () => new File([new Uint8Array(4)], "song.mp3")));

    const updates = await revalidateAccess([track]);
    expect(updates.get(track.id)).toBe("available");
  });

  it("keeps reporting permission-required when the ungranted handle is the only source", async () => {
    const track = makeTrack({ id: "revalidate-prompt-only", accessMode: "handle" });
    vi.spyOn(repository, "getHandle").mockResolvedValue(stubHandle("prompt", async () => new File([new Uint8Array(4)], "song.mp3")));

    const updates = await revalidateAccess([track]);
    expect(updates.get(track.id)).toBe("permission-required");
  });

  it("marks a gone handle record available when a stored copy can still play", async () => {
    const track = makeTrack({ id: "revalidate-gone-handle", accessMode: "handle" });
    await repository.putTracks([track]);
    await repository.putAudioBlob(track.id, new Blob([new Uint8Array(4)]));

    const updates = await revalidateAccess([track]);
    expect(updates.get(track.id)).toBe("available");
  });

  it("treats a session-only track's cloud copy by connectivity after a reload", async () => {
    const track = makeTrack({
      id: "session-cloud",
      accessMode: "session-only",
      objectKey: "users/u-1/tracks/session-cloud/audio.mp3",
      cloudStatus: "ready",
    });

    const online = await revalidateAccess([track]);
    expect(online.get(track.id)).toBe("available");

    setOnline(false);
    const offline = await revalidateAccess([track]);
    expect(offline.get(track.id)).toBe("offline");
  });
});
