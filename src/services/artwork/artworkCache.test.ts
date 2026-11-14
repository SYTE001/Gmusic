import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetArtworkCacheForTests,
  clearArtworkCache,
  getArtworkUrl,
  handleArtworkImageError,
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

vi.mock("./artworkService", () => ({
  resolveArtworkForTrack: vi.fn(),
  invalidateArtworkCacheForTrack: vi.fn(),
  clearNegativeArtworkCacheForTrack: vi.fn(),
  markArtworkUrlFailed: vi.fn(),
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

  describe("reloadMissingArtwork", () => {
    it("skips tracks with persisted IndexedDB blobs and memory-cached artwork untouched", async () => {
      const trackPersisted = makeTrack("t-persisted", { title: "Has IDB Blob", artist: "Artist 1" });
      const trackMem = makeTrack("t-mem", { title: "Has Memory URL", artist: "Artist 2" });
      const trackMissing = makeTrack("t-missing", { title: "Missing Art", artist: "Artist 3" });

      setCachedArtworkForTrack("t-mem", "blob:existing-mem");
      vi.mocked(repository.listArtworkTrackIds).mockResolvedValue(new Set(["t-persisted"]));
      vi.mocked(repository.getArtwork).mockResolvedValue(undefined);
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
          return { ok: false, blob: async () => new Blob() } as unknown as Response;
        }),
      );

      const listenerMissing = vi.fn();
      const listenerMem = vi.fn();
      const unsubMissing = subscribeArtwork("t-missing", listenerMissing);
      const unsubMem = subscribeArtwork("t-mem", listenerMem);

      const progressEvents: Array<{ done: number; total: number; restored: number }> = [];
      const result = await reloadMissingArtwork([trackPersisted, trackMem, trackMissing], {
        onProgress: (p) => progressEvents.push(p),
      });

      expect(result).toEqual({
        totalTracks: 3,
        alreadyHaveArtwork: 2,
        missingFound: 1,
        restored: 1,
        stillMissing: 0,
        offline: false,
      });

      // Only the missing track was cleared/resolved/persisted
      expect(clearNegativeArtworkCacheForTrack).toHaveBeenCalledTimes(1);
      expect(clearNegativeArtworkCacheForTrack).toHaveBeenCalledWith(trackMissing);
      expect(resolveArtworkForTrack).toHaveBeenCalledTimes(1);
      expect(resolveArtworkForTrack).toHaveBeenCalledWith(trackMissing);
      expect(repository.putArtwork).toHaveBeenCalledTimes(1);
      expect(repository.putArtwork).toHaveBeenCalledWith("t-missing", imgBlob);
      expect(repository.deleteArtwork).not.toHaveBeenCalled();

      // Existing memory-cached artwork remains untouched; missing track gets local blob URL
      expect(getArtworkUrl("t-mem")).toBe("blob:existing-mem");
      expect(getArtworkUrl("t-missing")).toBe("blob:mock-1");
      expect(listenerMem).not.toHaveBeenCalled();
      expect(listenerMissing).toHaveBeenCalledWith("blob:mock-1");
      expect(progressEvents).toEqual([{ done: 1, total: 1, restored: 1 }]);

      unsubMissing();
      unsubMem();
    });

    it("falls back to a secondary URL if the first candidate image fails download/validation", async () => {
      const trackMissing = makeTrack("t-retry", { title: "Retry Track", artist: "Artist" });

      vi.mocked(repository.listArtworkTrackIds).mockResolvedValue(new Set());
      vi.mocked(repository.getArtwork).mockResolvedValue(undefined);
      vi.mocked(resolveArtworkForTrack)
        .mockResolvedValueOnce({ url: "https://cdn.example/broken.jpg", source: "musicbrainz-caa" })
        .mockResolvedValueOnce({ url: "https://cdn.example/working.jpg", source: "itunes" });

      const goodBlob = makeImageBlob();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => {
          if (input === "https://cdn.example/working.jpg") {
            return { ok: true, blob: async () => goodBlob } as unknown as Response;
          }
          return { ok: false, blob: async () => new Blob() } as unknown as Response;
        }),
      );

      const result = await reloadMissingArtwork([trackMissing]);

      expect(result).toEqual({
        totalTracks: 1,
        alreadyHaveArtwork: 0,
        missingFound: 1,
        restored: 1,
        stillMissing: 0,
        offline: false,
      });
      expect(markArtworkUrlFailed).toHaveBeenCalledWith("https://cdn.example/broken.jpg");
      expect(repository.putArtwork).toHaveBeenCalledWith("t-retry", goodBlob);
      expect(getArtworkUrl("t-retry")).toBe("blob:mock-1");
    });

    it("does nothing and returns offline: true when disconnected", async () => {
      Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
      const trackMissing = makeTrack("t-offline");
      vi.mocked(repository.listArtworkTrackIds).mockResolvedValue(new Set());

      const result = await reloadMissingArtwork([trackMissing]);

      expect(result).toEqual({
        totalTracks: 1,
        alreadyHaveArtwork: 0,
        missingFound: 1,
        restored: 0,
        stillMissing: 1,
        offline: true,
      });
      expect(clearNegativeArtworkCacheForTrack).not.toHaveBeenCalled();
      expect(resolveArtworkForTrack).not.toHaveBeenCalled();
    });

    it("returns immediately without network calls when all tracks already have artwork", async () => {
      const track1 = makeTrack("t-1");
      const track2 = makeTrack("t-2");
      setCachedArtworkForTrack("t-1", "blob:mem-1");
      vi.mocked(repository.listArtworkTrackIds).mockResolvedValue(new Set(["t-2"]));

      const result = await reloadMissingArtwork([track1, track2]);

      expect(result).toEqual({
        totalTracks: 2,
        alreadyHaveArtwork: 2,
        missingFound: 0,
        restored: 0,
        stillMissing: 0,
        offline: false,
      });
      expect(resolveArtworkForTrack).not.toHaveBeenCalled();
      expect(clearNegativeArtworkCacheForTrack).not.toHaveBeenCalled();
    });
  });
});
