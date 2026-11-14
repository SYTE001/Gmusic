import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetArtworkCacheForTests,
  clearArtworkCache,
  evictArtworkUrlCache,
  getArtworkUrl,
  handleArtworkImageError,
  inspectTrackArtworkHealth,
  loadArtworkUrl,
  reloadMissingArtwork,
  setCachedArtworkForTrack,
  subscribeArtwork,
  upgradeArtworkToPersisted,
  validateArtworkBlob,
} from "./artworkCache";
import { repository } from "../indexeddb/LibraryRepository";
import { getPlayUrl } from "../cloud/r2StorageService";
import {
  clearNegativeArtworkCacheForTrack,
  invalidateArtworkCacheForTrack,
  markArtworkUrlFailed,
  resolveArtworkForTrack,
} from "./artworkService";
import type { Track } from "../../types";

vi.mock("../indexeddb/LibraryRepository", () => ({
  repository: {
    getArtwork: vi.fn(),
    putArtwork: vi.fn(),
    deleteArtwork: vi.fn(),
    getTrack: vi.fn(),
    listArtworkTrackIds: vi.fn(),
  },
}));

vi.mock("../cloud/r2StorageService", () => ({
  getPlayUrl: vi.fn(),
}));

const failedUrlsMock = vi.hoisted(() => new Set<string>());

vi.mock("./artworkService", () => ({
  resolveArtworkForTrack: vi.fn(),
  invalidateArtworkCacheForTrack: vi.fn(),
  clearNegativeArtworkCacheForTrack: vi.fn(),
  markArtworkUrlFailed: vi.fn((url: string | null | undefined) => {
    if (url) failedUrlsMock.add(url);
  }),
  isArtworkUrlFailed: vi.fn((url: string | null | undefined) => Boolean(url && failedUrlsMock.has(url))),
  hasMeaningfulAlbum: vi.fn((album: string | null | undefined) =>
    Boolean(album && album.trim() && !["single", "unknown", "unknown album", "various artists"].includes(album.trim().toLowerCase())),
  ),
  getAlbumArtworkCacheKey: vi.fn((track: { title: string; artist: string; album?: string }) =>
    track.album && track.album.trim()
      ? `album::${track.artist.trim().toLowerCase()}::${track.album.trim().toLowerCase()}`
      : `${track.artist.trim().toLowerCase()}::${track.title.trim().toLowerCase()}`,
  ),
}));

const makeImageBlob = (): Blob =>
  new Blob([new Uint8Array(128).fill(1)], { type: "image/jpeg" });

const makeTrack = (id: string, overrides?: Partial<Track>): Track => ({
  id,
  title: "Song",
  artist: "Artist",
  album: "",
  fileName: `${id}.mp3`,
  addedAt: 0,
  availability: "available",
  broken: null,
  liked: false,
  playCount: 0,
  lastPlayedAt: null,
  ...overrides,
} as unknown as Track);

let objectUrlCounter = 0;

async function flushAsync(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("artworkCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    failedUrlsMock.clear();
    window.localStorage.clear();
    __resetArtworkCacheForTests();
    objectUrlCounter = 0;
    URL.createObjectURL = vi.fn(() => `blob:mock-${++objectUrlCounter}`) as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ close: vi.fn() })));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, blob: async () => new Blob() }) as unknown as Response));
    vi.mocked(repository.putArtwork).mockResolvedValue(undefined);
    vi.mocked(repository.deleteArtwork).mockResolvedValue(undefined);
    vi.mocked(repository.getTrack).mockResolvedValue(undefined);
    vi.mocked(repository.listArtworkTrackIds).mockResolvedValue(new Set());
    vi.mocked(invalidateArtworkCacheForTrack).mockReturnValue(undefined);
    vi.mocked(clearNegativeArtworkCacheForTrack).mockReturnValue(undefined);
    vi.mocked(markArtworkUrlFailed).mockReturnValue(undefined);
    vi.mocked(getPlayUrl).mockRejectedValue(new Error("not configured"));
  });

  describe("validateArtworkBlob", () => {
    it("accepts a decodable image blob", async () => {
      expect(await validateArtworkBlob(makeImageBlob())).toBe(true);
    });

    it("rejects non-image content types", async () => {
      const blob = new Blob([new Uint8Array(128).fill(1)], { type: "text/html" });
      expect(await validateArtworkBlob(blob)).toBe(false);
      expect(createImageBitmap).not.toHaveBeenCalled();
    });

    it("rejects blobs that fail to decode", async () => {
      vi.stubGlobal("createImageBitmap", vi.fn(async () => {
        throw new Error("decode failed");
      }));
      expect(await validateArtworkBlob(makeImageBlob())).toBe(false);
    });

    it("rejects undersized and oversized blobs", async () => {
      expect(await validateArtworkBlob(new Blob([new Uint8Array(4)], { type: "image/png" }))).toBe(false);
      expect(await validateArtworkBlob(new Blob([new Uint8Array(6 * 1024 * 1024)], { type: "image/png" }))).toBe(false);
    });
  });

  describe("loadArtworkUrl", () => {
    it("serves persisted embedded artwork from IndexedDB without going online", async () => {
      vi.mocked(repository.getArtwork).mockResolvedValue(makeImageBlob());

      const url = await loadArtworkUrl("t1");
      expect(url).toBe("blob:mock-1");
      expect(resolveArtworkForTrack).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });

    it("uses the memory cache on replay without re-reading IndexedDB", async () => {
      vi.mocked(repository.getArtwork).mockResolvedValue(makeImageBlob());

      await loadArtworkUrl("t1");
      const url = await loadArtworkUrl("t1");
      expect(url).toBe("blob:mock-1");
      expect(repository.getArtwork).toHaveBeenCalledTimes(1);
    });

    it("resolves and persists cloud artwork via artworkObjectKey before querying external providers", async () => {
      vi.mocked(repository.getArtwork).mockResolvedValue(undefined);
      const cloudTrack = makeTrack("t-cloud", {
        artworkObjectKey: "users/u1/tracks/t-cloud/artwork.jpg",
      });
      vi.mocked(repository.getTrack).mockResolvedValue(cloudTrack);
      vi.mocked(getPlayUrl).mockResolvedValue("https://r2.signed.example/artwork.jpg?sig=123");
      const blob = makeImageBlob();
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, blob: async () => blob }) as unknown as Response));

      const url = await loadArtworkUrl("t-cloud");
      expect(url).toBe("blob:mock-1");
      expect(getPlayUrl).toHaveBeenCalledWith("users/u1/tracks/t-cloud/artwork.jpg");
      expect(repository.putArtwork).toHaveBeenCalledWith("t-cloud", blob);
      expect(resolveArtworkForTrack).not.toHaveBeenCalled();
    });

    it("downloads, validates and persists remote provider artwork for the stable track ID", async () => {
      vi.mocked(repository.getArtwork).mockResolvedValue(undefined);
      vi.mocked(repository.getTrack).mockResolvedValue(makeTrack("t1"));
      vi.mocked(resolveArtworkForTrack).mockResolvedValue({
        url: "https://is1-ssl.mzstatic.com/cover.jpg",
        source: "itunes",
        confidence: 80,
      });
      const blob = makeImageBlob();
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, blob: async () => blob }) as unknown as Response));

      const url = await loadArtworkUrl("t1");
      expect(url).toBe("https://is1-ssl.mzstatic.com/cover.jpg");
      expect(resolveArtworkForTrack).toHaveBeenCalledWith(makeTrack("t1"));

      // Background persistence upgrades the cache to a local blob URL
      await flushAsync();
      expect(repository.putArtwork).toHaveBeenCalledWith("t1", blob);
      expect(getArtworkUrl("t1")).toBe("blob:mock-1");
    });

    it("keeps the remote URL when the download fails, without persisting anything", async () => {
      vi.mocked(repository.getArtwork).mockResolvedValue(undefined);
      vi.mocked(repository.getTrack).mockResolvedValue(makeTrack("t1"));
      vi.mocked(resolveArtworkForTrack).mockResolvedValue({ url: "https://cdn.example/cover.jpg", source: "itunes" });
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, blob: async () => new Blob() }) as unknown as Response));

      const url = await loadArtworkUrl("t1");
      expect(url).toBe("https://cdn.example/cover.jpg");
      await flushAsync();
      expect(repository.putArtwork).not.toHaveBeenCalled();
      expect(getArtworkUrl("t1")).toBe("https://cdn.example/cover.jpg");
    });

    it("never persists content that is not a valid image", async () => {
      vi.mocked(repository.getArtwork).mockResolvedValue(undefined);
      vi.mocked(repository.getTrack).mockResolvedValue(makeTrack("t1"));
      vi.mocked(resolveArtworkForTrack).mockResolvedValue({ url: "https://cdn.example/cover.jpg", source: "itunes" });
      const htmlBlob = new Blob([new Uint8Array(128).fill(2)], { type: "text/html" });
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, blob: async () => htmlBlob }) as unknown as Response));

      const url = await loadArtworkUrl("t1");
      expect(url).toBe("https://cdn.example/cover.jpg");
      await flushAsync();
      expect(repository.putArtwork).not.toHaveBeenCalled();
    });

    it("keeps display responsive when persistence fails (quota/IDB error)", async () => {
      vi.mocked(repository.getArtwork).mockResolvedValue(undefined);
      vi.mocked(repository.getTrack).mockResolvedValue(makeTrack("t1"));
      vi.mocked(resolveArtworkForTrack).mockResolvedValue({ url: "https://cdn.example/cover.jpg", source: "itunes" });
      const blob = makeImageBlob();
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, blob: async () => blob }) as unknown as Response));
      vi.mocked(repository.putArtwork).mockRejectedValue(new Error("quota"));

      const url = await loadArtworkUrl("t1");
      expect(url).toBe("https://cdn.example/cover.jpg");
      await flushAsync();
      expect(getArtworkUrl("t1")).toBe("https://cdn.example/cover.jpg");
    });

    it("does not re-download a URL that failed recently (negative download cache)", async () => {
      vi.mocked(repository.getArtwork).mockResolvedValue(undefined);
      vi.mocked(repository.getTrack).mockResolvedValue(makeTrack("t1"));
      vi.mocked(resolveArtworkForTrack).mockResolvedValue({ url: "https://cdn.example/cover.jpg", source: "itunes" });
      const fetchMock = vi.fn(async () => ({ ok: false, blob: async () => new Blob() }) as unknown as Response);
      vi.stubGlobal("fetch", fetchMock);

      await loadArtworkUrl("t1");
      await flushAsync();
      const downloadsAfterFirst = fetchMock.mock.calls.length;

      // Simulate a remount: memory cache still holds the remote URL, so no new download
      await loadArtworkUrl("t1");
      await flushAsync();
      expect(fetchMock.mock.calls.length).toBe(downloadsAfterFirst);

      // Even after invalidation, the failed URL is not retried within the TTL
      setCachedArtworkForTrack("t1", "https://cdn.example/cover.jpg");
      upgradeArtworkToPersisted("t1", "https://cdn.example/cover.jpg");
      await flushAsync();
      expect(fetchMock.mock.calls.length).toBe(downloadsAfterFirst);
    });

    it("correctly loads and caches artwork when switching across 20 tracks and replaying", async () => {
      vi.mocked(repository.getArtwork).mockImplementation(async (id: string) => {
        if (id.startsWith("track-")) return makeImageBlob();
        return undefined;
      });

      const resolvedUrls = new Map<string, string | undefined>();
      for (let i = 1; i <= 20; i++) {
        const id = `track-${i}`;
        const url = await loadArtworkUrl(id);
        expect(url).toBe(`blob:mock-${i}`);
        resolvedUrls.set(id, url);
      }

      // Replay tracks 1..20: served from memory cache without extra IndexedDB reads
      expect(repository.getArtwork).toHaveBeenCalledTimes(20);
      for (let i = 1; i <= 20; i++) {
        const id = `track-${i}`;
        const replayUrl = await loadArtworkUrl(id);
        expect(replayUrl).toBe(resolvedUrls.get(id));
      }
      expect(repository.getArtwork).toHaveBeenCalledTimes(20);
    });

    it("survives application refresh / restart by restoring from IndexedDB and works offline", async () => {
      const persistedStore = new Map<string, Blob>();
      vi.mocked(repository.getArtwork).mockImplementation(async (id) => persistedStore.get(id));
      vi.mocked(repository.putArtwork).mockImplementation(async (id, blob) => {
        persistedStore.set(id, blob);
      });
      vi.mocked(repository.getTrack).mockResolvedValue(makeTrack("t-persist"));
      vi.mocked(resolveArtworkForTrack).mockResolvedValue({
        url: "https://is1-ssl.mzstatic.com/persist.jpg",
        source: "itunes",
      });
      const blob = makeImageBlob();
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, blob: async () => blob }) as unknown as Response));

      // First session: loads remote and persists to IndexedDB
      await loadArtworkUrl("t-persist");
      await flushAsync();
      expect(persistedStore.has("t-persist")).toBe(true);

      // Simulate application refresh / reopen while offline
      __resetArtworkCacheForTests();
      Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
      vi.mocked(resolveArtworkForTrack).mockClear();

      const afterRestartUrl = await loadArtworkUrl("t-persist");
      expect(afterRestartUrl).toBe("blob:mock-2");
      expect(resolveArtworkForTrack).not.toHaveBeenCalled();
    });
  });

  describe("handleArtworkImageError", () => {
    it("keeps cached artwork when offline (transient connectivity loss)", async () => {
      setCachedArtworkForTrack("t1", "https://cdn.example/cover.jpg");
      Object.defineProperty(navigator, "onLine", { value: false, configurable: true });

      await handleArtworkImageError("t1", "https://cdn.example/cover.jpg");

      expect(getArtworkUrl("t1")).toBe("https://cdn.example/cover.jpg");
      expect(invalidateArtworkCacheForTrack).not.toHaveBeenCalled();
      expect(repository.deleteArtwork).not.toHaveBeenCalled();
    });

    it("marks broken remote URL as failed, invalidates once, and retries when online", async () => {
      vi.mocked(repository.getArtwork).mockResolvedValue(undefined);
      vi.mocked(repository.getTrack).mockResolvedValue(makeTrack("t1"));
      vi.mocked(resolveArtworkForTrack).mockResolvedValue({ url: "https://cdn.example/better.jpg", source: "itunes" });
      setCachedArtworkForTrack("t1", "https://cdn.example/broken.jpg");

      await handleArtworkImageError("t1", "https://cdn.example/broken.jpg");
      await flushAsync();

      expect(markArtworkUrlFailed).toHaveBeenCalledWith("https://cdn.example/broken.jpg");
      expect(invalidateArtworkCacheForTrack).toHaveBeenCalledTimes(1);
      expect(getArtworkUrl("t1")).toBe("https://cdn.example/better.jpg");
    });

    it("does not loop retries for a permanently broken URL (cooldown)", async () => {
      vi.mocked(repository.getTrack).mockResolvedValue(makeTrack("t1"));
      setCachedArtworkForTrack("t1", "https://cdn.example/broken.jpg");

      await handleArtworkImageError("t1", "https://cdn.example/broken.jpg");
      const callsAfterFirst = vi.mocked(invalidateArtworkCacheForTrack).mock.calls.length;

      await handleArtworkImageError("t1", "https://cdn.example/broken.jpg");
      await handleArtworkImageError("t1", "https://cdn.example/broken.jpg");
      expect(vi.mocked(invalidateArtworkCacheForTrack).mock.calls.length).toBe(callsAfterFirst);
    });

    it("skips recovery when a different URL already replaced the failed one", async () => {
      setCachedArtworkForTrack("t1", "https://cdn.example/new.jpg");

      await handleArtworkImageError("t1", "https://cdn.example/old.jpg");

      expect(invalidateArtworkCacheForTrack).not.toHaveBeenCalled();
      expect(getArtworkUrl("t1")).toBe("https://cdn.example/new.jpg");
    });

    it("deletes a corrupt persisted blob before retrying, but keeps it for remote-URL failures", async () => {
      vi.mocked(repository.getTrack).mockResolvedValue(makeTrack("t1"));
      vi.mocked(repository.getArtwork).mockResolvedValue(undefined);

      setCachedArtworkForTrack("t1", "blob:mock-corrupt");
      await handleArtworkImageError("t1", "blob:mock-corrupt");
      expect(repository.deleteArtwork).toHaveBeenCalledWith("t1");

      vi.mocked(repository.deleteArtwork).mockClear();
      setCachedArtworkForTrack("t2", "https://cdn.example/cover.jpg");
      await handleArtworkImageError("t2", "https://cdn.example/cover.jpg");
      expect(repository.deleteArtwork).not.toHaveBeenCalled();
    });

    it("never deletes a valid persisted IndexedDB blob when a revoked or evicted blob URL errors", async () => {
      const validBlob = makeImageBlob();
      vi.mocked(repository.getArtwork).mockResolvedValue(validBlob);

      // Load initial blob URL (blob:mock-1), then clear in-memory cache (revoking blob:mock-1)
      const initialUrl = await loadArtworkUrl("t1");
      expect(initialUrl).toBe("blob:mock-1");
      clearArtworkCache();

      // Stale <img> fires onError with the revoked blob:mock-1 URL
      await handleArtworkImageError("t1", "blob:mock-1");

      // Valid persisted blob in IndexedDB must NEVER be deleted; a fresh blob URL is minted instead
      expect(repository.deleteArtwork).not.toHaveBeenCalled();
      expect(getArtworkUrl("t1")).toBe("blob:mock-2");
    });
  });

  describe("listener isolation (no stale cross-track updates)", () => {
    it("only delivers notifications for the subscribed track", async () => {
      const listenerA = vi.fn();
      const listenerB = vi.fn();
      const unsubA = subscribeArtwork("track-a", listenerA);
      const unsubB = subscribeArtwork("track-b", listenerB);

      setCachedArtworkForTrack("track-a", "blob:mock-a");
      setCachedArtworkForTrack("track-b", "https://cdn.example/b.jpg");

      expect(listenerA).toHaveBeenCalledWith("blob:mock-a");
      expect(listenerA).not.toHaveBeenCalledWith("https://cdn.example/b.jpg");
      expect(listenerB).toHaveBeenCalledWith("https://cdn.example/b.jpg");
      expect(listenerB).not.toHaveBeenCalledWith("blob:mock-a");

      unsubA();
      unsubB();
    });

    it("stops delivering after unsubscribe (no leaks)", () => {
      const listener = vi.fn();
      const unsubscribe = subscribeArtwork("track-a", listener);
      unsubscribe();

      setCachedArtworkForTrack("track-a", "blob:mock-a");
      expect(listener).not.toHaveBeenCalled();
    });

    it("resolves concurrent loads for different tracks independently", async () => {
      const deferred: Array<(value: Blob | undefined) => void> = [];
      vi.mocked(repository.getArtwork).mockImplementation(
        () => new Promise<Blob | undefined>((resolve) => deferred.push(resolve)),
      );

      const promiseA = loadArtworkUrl("track-a");
      const promiseB = loadArtworkUrl("track-b");
      expect(deferred.length).toBe(2);

      deferred[1](makeImageBlob());
      deferred[0](undefined);

      const urlB = await promiseB;
      const urlA = await promiseA;
      expect(urlA).toBeUndefined();
      expect(urlB).toBe("blob:mock-1");
    });
  });

  describe("inspectTrackArtworkHealth & reloadMissingArtwork", () => {
    it("1 & 7: preserves valid IndexedDB blobs and valid memory-cached artwork untouched", async () => {
      const validBlob = makeImageBlob();
      const trackPersisted = makeTrack("t-persisted", { title: "Has IDB Blob", artist: "Artist 1" });
      const trackMem = makeTrack("t-mem", { title: "Has Memory URL", artist: "Artist 2" });
      const trackMissing = makeTrack("t-missing", { title: "Missing Art", artist: "Artist 3" });

      setCachedArtworkForTrack("t-mem", "blob:existing-mem");
      vi.mocked(repository.getArtwork).mockImplementation(async (id) =>
        id === "t-persisted" ? validBlob : undefined,
      );
      vi.mocked(resolveArtworkForTrack).mockResolvedValue({
        url: "https://cdn.example/restored.jpg",
        source: "itunes",
      });

      const imgBlob = makeImageBlob();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => {
          if (input === "https://cdn.example/restored.jpg") {
            return { ok: true, blob: async () => imgBlob } as unknown as Response;
          }
          return { ok: false, status: 404, blob: async () => new Blob() } as unknown as Response;
        }),
      );

      const listenerMissing = vi.fn();
      const listenerMem = vi.fn();
      const unsubMissing = subscribeArtwork("t-missing", listenerMissing);
      const unsubMem = subscribeArtwork("t-mem", listenerMem);

      const progressPhases: string[] = [];
      const result = await reloadMissingArtwork([trackPersisted, trackMem, trackMissing], {
        onProgress: (p) => progressPhases.push(`${p.phase}:${p.done}/${p.total}`),
      });

      expect(result).toMatchObject({
        totalTracks: 3,
        validPreserved: 2,
        missingDetected: 1,
        corruptedDetected: 0,
        brokenUrlDetected: 0,
        staleDetected: 0,
        restored: 1,
        stillMissing: 0,
        providerFailures: 0,
        offline: false,
      });

      expect(clearNegativeArtworkCacheForTrack).toHaveBeenCalledTimes(1);
      expect(clearNegativeArtworkCacheForTrack).toHaveBeenCalledWith(trackMissing);
      expect(resolveArtworkForTrack).toHaveBeenCalledTimes(1);
      expect(resolveArtworkForTrack).toHaveBeenCalledWith(
        trackMissing,
        expect.objectContaining({ forceRefresh: true }),
      );
      expect(repository.putArtwork).toHaveBeenCalledTimes(1);
      expect(repository.putArtwork).toHaveBeenCalledWith("t-missing", imgBlob);
      expect(repository.deleteArtwork).not.toHaveBeenCalled();

      expect(getArtworkUrl("t-mem")).toBe("blob:existing-mem");
      expect(getArtworkUrl("t-missing")).toBe("blob:mock-1");
      expect(listenerMem).not.toHaveBeenCalled();
      expect(listenerMissing).toHaveBeenCalledWith("blob:mock-1");
      expect(progressPhases.some((p) => p.startsWith("scanning:"))).toBe(true);
      expect(progressPhases.some((p) => p.startsWith("recovering:"))).toBe(true);

      unsubMissing();
      unsubMem();
    });

    it("2: detects corrupted IndexedDB blob, deletes only corrupt record, and replaces it with fresh provider artwork", async () => {
      const validBlob = makeImageBlob();
      const corruptBlob = new Blob([new Uint8Array(128).fill(9)], { type: "image/jpeg" });
      const goodTrack = makeTrack("t-good", { title: "Good", artist: "A" });
      const corruptTrack = makeTrack("t-corrupt", { title: "Corrupt", artist: "B" });

      vi.mocked(createImageBitmap).mockImplementation(async (blob: ImageBitmapSource) => {
        if (blob === corruptBlob) {
          throw new Error("corrupt image");
        }
        return { close: vi.fn() } as unknown as ImageBitmap;
      });

      vi.mocked(repository.getArtwork).mockImplementation(async (id) => {
        if (id === "t-good") return validBlob;
        if (id === "t-corrupt") return corruptBlob;
        return undefined;
      });

      vi.mocked(resolveArtworkForTrack).mockResolvedValue({
        url: "https://is1-ssl.mzstatic.com/healed.jpg",
        source: "itunes",
      });
      const restoredBlob = makeImageBlob();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: true, blob: async () => restoredBlob }) as unknown as Response),
      );

      const result = await reloadMissingArtwork([goodTrack, corruptTrack]);

      expect(result).toMatchObject({
        totalTracks: 2,
        validPreserved: 1,
        corruptedDetected: 1,
        missingDetected: 0,
        restored: 1,
        stillMissing: 0,
      });
      expect(repository.deleteArtwork).toHaveBeenCalledTimes(1);
      expect(repository.deleteArtwork).toHaveBeenCalledWith("t-corrupt");
      expect(repository.putArtwork).toHaveBeenCalledWith("t-corrupt", restoredBlob);
      expect(getArtworkUrl("t-corrupt")).toBe("blob:mock-1");
    });

    it("3: recovers a revoked Blob URL directly from a valid persisted IndexedDB blob without network calls", async () => {
      const validBlob = makeImageBlob();
      const track = makeTrack("t-revoked");
      vi.mocked(repository.getArtwork).mockResolvedValue(validBlob);

      // Load and then evict so blob:mock-1 is asynchronously revoked after delay
      vi.useFakeTimers();
      try {
        const initialUrl = await loadArtworkUrl(track);
        expect(initialUrl).toBe("blob:mock-1");
        evictArtworkUrlCache("t-revoked");
        await vi.advanceTimersByTimeAsync(61_000);
        setCachedArtworkForTrack("t-revoked", "blob:mock-1");
        expect(getArtworkUrl("t-revoked")).toBeUndefined(); // getArtworkUrl rejects revoked URL

        // Re-insert revoked URL to inspect health directly
        setCachedArtworkForTrack("t-revoked", "blob:mock-1");
        const listener = vi.fn();
        const unsub = subscribeArtwork("t-revoked", listener);

        const health = await inspectTrackArtworkHealth(track);
        expect(health.state).toBe("VALID");
        expect(health.url).toBe("blob:mock-2");
        expect(listener).toHaveBeenCalledWith("blob:mock-2");
        expect(resolveArtworkForTrack).not.toHaveBeenCalled();

        unsub();
      } finally {
        vi.useRealTimers();
      }
    });

    it("4: detects a broken remote URL in memory cache and replaces it with working provider artwork", async () => {
      const track = makeTrack("t-broken-url", { title: "Track", artist: "Artist" });
      vi.mocked(repository.getArtwork).mockResolvedValue(undefined);
      setCachedArtworkForTrack("t-broken-url", "https://cdn.example/dead-old.jpg");

      vi.mocked(resolveArtworkForTrack)
        .mockResolvedValueOnce({ url: "https://cdn.example/dead-retry.jpg", source: "musicbrainz-caa" })
        .mockResolvedValueOnce({ url: "https://is1-ssl.mzstatic.com/working.jpg", source: "itunes" });

      const goodBlob = makeImageBlob();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => {
          if (input === "https://is1-ssl.mzstatic.com/working.jpg") {
            return { ok: true, blob: async () => goodBlob } as unknown as Response;
          }
          return { ok: false, status: 404, blob: async () => new Blob() } as unknown as Response;
        }),
      );

      const result = await reloadMissingArtwork([track]);

      expect(result).toMatchObject({
        totalTracks: 1,
        validPreserved: 0,
        brokenUrlDetected: 1,
        restored: 1,
        stillMissing: 0,
      });
      expect(markArtworkUrlFailed).toHaveBeenCalledWith("https://cdn.example/dead-old.jpg");
      expect(markArtworkUrlFailed).toHaveBeenCalledWith("https://cdn.example/dead-retry.jpg");
      expect(repository.putArtwork).toHaveBeenCalledWith("t-broken-url", goodBlob);
      expect(getArtworkUrl("t-broken-url")).toBe("blob:mock-1");
    });

    it("respects CORS-blocked remote URLs when <img> loads successfully without marking them broken", async () => {
      const track = makeTrack("t-cors", { title: "Cors", artist: "Artist" });
      vi.mocked(repository.getArtwork).mockResolvedValue(undefined);
      setCachedArtworkForTrack("t-cors", "https://archive.org/cors-only.jpg");

      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("Failed to fetch");
        }),
      );

      const originalImage = globalThis.Image;
      class MockLoadableImage {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        naturalWidth = 500;
        naturalHeight = 500;
        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      }
      vi.stubGlobal("Image", MockLoadableImage);

      try {
        const result = await reloadMissingArtwork([track]);
        expect(result).toMatchObject({
          totalTracks: 1,
          validPreserved: 1,
          brokenUrlDetected: 0,
          missingFound: 0,
        });
        expect(markArtworkUrlFailed).not.toHaveBeenCalled();
        expect(getArtworkUrl("t-cors")).toBe("https://archive.org/cors-only.jpg");
      } finally {
        vi.stubGlobal("Image", originalImage);
      }
    });

    it("8: shares discovery and download across multiple tracks from the same album, and reuses valid sibling IDB blobs", async () => {
      const validSibling = makeTrack("t-sib-valid", { title: "Track 1", artist: "Daft Punk", album: "Discovery" });
      const missingFromSameAlbum = makeTrack("t-sib-miss", { title: "Track 2", artist: "Daft Punk", album: "Discovery" });
      const albumA1 = makeTrack("t-alb-1", { title: "Song A", artist: "Artist X", album: "Album One" });
      const albumA2 = makeTrack("t-alb-2", { title: "Song B", artist: "Artist X", album: "Album One" });

      const siblingBlob = makeImageBlob();
      const downloadedBlob = makeImageBlob();
      vi.mocked(repository.getArtwork).mockImplementation(async (id) =>
        id === "t-sib-valid" ? siblingBlob : undefined,
      );

      vi.mocked(resolveArtworkForTrack).mockResolvedValue({
        url: "https://is1-ssl.mzstatic.com/album-one.jpg",
        source: "itunes",
      });
      const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => downloadedBlob }) as unknown as Response);
      vi.stubGlobal("fetch", fetchMock);

      const result = await reloadMissingArtwork([validSibling, missingFromSameAlbum, albumA1, albumA2]);

      expect(result).toMatchObject({
        totalTracks: 4,
        validPreserved: 1,
        missingDetected: 3,
        restored: 3,
        stillMissing: 0,
      });

      // Only Album One triggers online discovery + 1 image download; sibling reuses local IDB blob
      expect(resolveArtworkForTrack).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      expect(repository.putArtwork).toHaveBeenCalledWith("t-sib-miss", siblingBlob);
      expect(repository.putArtwork).toHaveBeenCalledWith("t-alb-1", downloadedBlob);
      expect(repository.putArtwork).toHaveBeenCalledWith("t-alb-2", downloadedBlob);
      expect(getArtworkUrl("t-sib-miss")).toBeTruthy();
      expect(getArtworkUrl("t-alb-1")).toBeTruthy();
      expect(getArtworkUrl("t-alb-2")).toBeTruthy();
    });

    it("9: preserves valid local artwork and caches without deleting anything when offline", async () => {
      const validTrack = makeTrack("t-ok");
      const missingTrack = makeTrack("t-offline");
      const validBlob = makeImageBlob();

      vi.mocked(repository.getArtwork).mockImplementation(async (id) =>
        id === "t-ok" ? validBlob : undefined,
      );
      setCachedArtworkForTrack("t-offline", "https://cdn.example/cached-remote.jpg");
      Object.defineProperty(navigator, "onLine", { value: false, configurable: true });

      const result = await reloadMissingArtwork([validTrack, missingTrack]);

      expect(result).toMatchObject({
        totalTracks: 2,
        validPreserved: 1,
        missingFound: 1,
        restored: 0,
        stillMissing: 1,
        offline: true,
      });
      expect(repository.deleteArtwork).not.toHaveBeenCalled();
      expect(invalidateArtworkCacheForTrack).not.toHaveBeenCalled();
      expect(resolveArtworkForTrack).not.toHaveBeenCalled();
      expect(getArtworkUrl("t-offline")).toBe("https://cdn.example/cached-remote.jpg");
    });

    it("11: tracks provider failures cleanly without reporting false success", async () => {
      const track = makeTrack("t-fail", { title: "Song", artist: "Artist" });
      vi.mocked(repository.getArtwork).mockResolvedValue(undefined);
      vi.mocked(resolveArtworkForTrack).mockResolvedValue({
        url: undefined,
        source: "none",
        transientFailure: true,
      });

      const result = await reloadMissingArtwork([track]);

      expect(result).toMatchObject({
        totalTracks: 1,
        validPreserved: 0,
        missingDetected: 1,
        restored: 0,
        stillMissing: 1,
        providerFailures: 1,
        offline: false,
      });
      expect(repository.putArtwork).not.toHaveBeenCalled();
    });

    it("12: deduplicates concurrent reload operations into a single recovery run", async () => {
      const t1 = makeTrack("t-conc-1", { title: "One", artist: "Artist" });
      const t2 = makeTrack("t-conc-2", { title: "Two", artist: "Artist" });
      vi.mocked(repository.getArtwork).mockResolvedValue(undefined);

      vi.mocked(resolveArtworkForTrack).mockImplementation(
        () =>
          new Promise((resolve) => {
            queueMicrotask(() => resolve({ url: "https://cdn.example/shared.jpg", source: "itunes" }));
          }),
      );
      const blob = makeImageBlob();
      const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => blob }) as unknown as Response);
      vi.stubGlobal("fetch", fetchMock);

      const p1 = vi.fn();
      const p2 = vi.fn();
      const [res1, res2] = await Promise.all([
        reloadMissingArtwork([t1, t2], { onProgress: p1 }),
        reloadMissingArtwork([t1, t2], { onProgress: p2 }),
      ]);

      expect(res1).toEqual(res2);
      expect(res1.restored).toBe(2);
      expect(resolveArtworkForTrack).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(p1.mock.calls.length).toBeGreaterThan(0);
      expect(p2.mock.calls.length).toBeGreaterThan(0);
    });
  });
});
