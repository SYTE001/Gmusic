import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearArtworkServiceCache,
  getArtworkCacheKey,
  resolveArtworkForTrack,
} from "./artworkService";
import { repository } from "../indexeddb/LibraryRepository";
import * as itunesClient from "./itunesClient";

describe("artworkService", () => {
  beforeEach(() => {
    clearArtworkServiceCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearArtworkServiceCache();
    vi.restoreAllMocks();
  });

  describe("getArtworkCacheKey", () => {
    it("normalizes artist and title consistently", () => {
      const key1 = getArtworkCacheKey({ title: "  Yellow  ", artist: "Coldplay" });
      const key2 = getArtworkCacheKey({ title: "yellow", artist: "coldplay" });
      expect(key1).toBe(key2);
      expect(key1).toBe("coldplay::yellow");
    });
  });

  describe("resolveArtworkForTrack priority and caching", () => {
    it("prioritizes embedded artwork in IndexedDB over iTunes", async () => {
      const getArtworkSpy = vi
        .spyOn(repository, "getArtwork")
        .mockResolvedValue(new Blob(["embedded-art"], { type: "image/jpeg" }));
      const itunesSpy = vi.spyOn(itunesClient, "searchItunesArtwork");

      const res = await resolveArtworkForTrack({ id: "track-1", title: "Yellow", artist: "Coldplay" });

      expect(getArtworkSpy).toHaveBeenCalledWith("track-1");
      expect(itunesSpy).not.toHaveBeenCalled();
      expect(res.source).toBe("embedded");
    });

    it("falls back to iTunes Search API when track has no embedded artwork", async () => {
      vi.spyOn(repository, "getArtwork").mockResolvedValue(undefined);
      const itunesSpy = vi
        .spyOn(itunesClient, "searchItunesArtwork")
        .mockResolvedValue("https://is1-ssl.mzstatic.com/image/thumb/123/600x600bb.jpg");

      const res = await resolveArtworkForTrack({ id: "track-2", title: "Yellow", artist: "Coldplay" });

      expect(itunesSpy).toHaveBeenCalledTimes(1);
      expect(res.source).toBe("itunes");
      expect(res.url).toBe("https://is1-ssl.mzstatic.com/image/thumb/123/600x600bb.jpg");
    });

    it("caches matching iTunes artwork locally and avoids repeat network requests on replay", async () => {
      vi.spyOn(repository, "getArtwork").mockResolvedValue(undefined);
      const itunesSpy = vi
        .spyOn(itunesClient, "searchItunesArtwork")
        .mockResolvedValue("https://is1-ssl.mzstatic.com/image/thumb/123/600x600bb.jpg");

      // First call: calls iTunes
      const res1 = await resolveArtworkForTrack({ id: "track-3", title: "Yellow", artist: "Coldplay" });
      expect(itunesSpy).toHaveBeenCalledTimes(1);
      expect(res1.url).toBe("https://is1-ssl.mzstatic.com/image/thumb/123/600x600bb.jpg");

      // Second call (replay): served from cache, no network call
      const res2 = await resolveArtworkForTrack({ id: "track-3", title: "Yellow", artist: "Coldplay" });
      expect(itunesSpy).toHaveBeenCalledTimes(1);
      expect(res2.url).toBe("https://is1-ssl.mzstatic.com/image/thumb/123/600x600bb.jpg");
    });

    it("caches negative (not-found) results and avoids repeated queries", async () => {
      vi.spyOn(repository, "getArtwork").mockResolvedValue(undefined);
      const itunesSpy = vi.spyOn(itunesClient, "searchItunesArtwork").mockResolvedValue(null);

      // First call
      const res1 = await resolveArtworkForTrack({ id: "track-4", title: "Unknown Song", artist: "Unknown Artist" });
      expect(itunesSpy).toHaveBeenCalledTimes(1);
      expect(res1.source).toBe("none");
      expect(res1.url).toBeUndefined();

      // Second call: served from negative cache
      const res2 = await resolveArtworkForTrack({ id: "track-4", title: "Unknown Song", artist: "Unknown Artist" });
      expect(itunesSpy).toHaveBeenCalledTimes(1);
      expect(res2.source).toBe("none");
      expect(res2.url).toBeUndefined();
    });

    it("deduplicates in-flight simultaneous requests for the same track", async () => {
      vi.spyOn(repository, "getArtwork").mockResolvedValue(undefined);
      let resolveFetch!: (url: string | null) => void;
      const delayedFetch = new Promise<string | null>((resolve) => {
        resolveFetch = resolve;
      });
      const itunesSpy = vi.spyOn(itunesClient, "searchItunesArtwork").mockReturnValue(delayedFetch);

      const p1 = resolveArtworkForTrack({ title: "Yellow", artist: "Coldplay" });
      const p2 = resolveArtworkForTrack({ title: "Yellow", artist: "Coldplay" });

      resolveFetch("https://is1-ssl.mzstatic.com/image/thumb/123/600x600bb.jpg");

      const [res1, res2] = await Promise.all([p1, p2]);
      expect(itunesSpy).toHaveBeenCalledTimes(1);
      expect(res1.url).toBe("https://is1-ssl.mzstatic.com/image/thumb/123/600x600bb.jpg");
      expect(res2.url).toBe("https://is1-ssl.mzstatic.com/image/thumb/123/600x600bb.jpg");
    });
  });
});
