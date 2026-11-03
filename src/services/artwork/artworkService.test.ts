import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetArtworkServiceForTests,
  getAlbumArtworkCacheKey,
  getArtworkCacheKey,
  getCachedArtworkEntry,
  NEGATIVE_CACHE_TTL_MS,
  POSITIVE_CACHE_TTL_MS,
  resolveArtworkForAlbumBatch,
  resolveArtworkForTrack,
} from "./artworkService";
import { __configureMusicBrainzForTests } from "./musicbrainzClient";
import { repository } from "../indexeddb/LibraryRepository";
import { searchItunesArtwork } from "./itunesClient";

vi.mock("../indexeddb/LibraryRepository", () => ({
  repository: {
    getArtwork: vi.fn(),
  },
}));

vi.mock("./itunesClient", () => ({
  searchItunesArtwork: vi.fn(),
}));

const RG_MBID = "11111111-2222-3333-4444-555555555555";
const REL_MBID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("artworkService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    localStorage.clear();
    __resetArtworkServiceForTests();
    __configureMusicBrainzForTests({ rateLimitMs: 0 });
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    URL.createObjectURL = vi.fn(() => "blob:mock-url");
  });

  describe("getArtworkCacheKey & getAlbumArtworkCacheKey", () => {
    it("normalizes artist, album, and title to build consistent keys", () => {
      const k1 = getArtworkCacheKey({
        title: "Blinding Lights (Official Video)",
        artist: "The Weeknd feat. Rosalia",
      });
      const k2 = getArtworkCacheKey({
        title: "blinding lights",
        artist: "the weeknd",
      });
      expect(k1).toBe(k2);
      expect(k1).toBe("the weeknd::blinding lights");

      const a1 = getAlbumArtworkCacheKey({
        title: "Get Lucky",
        artist: "Daft Punk feat. Pharrell",
        album: "Random Access Memories",
      });
      const a2 = getAlbumArtworkCacheKey({
        title: "Instant Crush",
        artist: "Daft Punk",
        album: "random access memories",
      });
      expect(a1).toBe(a2);
      expect(a1).toBe("album::daft punk::random access memories");
    });
  });

  describe("resolveArtworkForTrack", () => {
    it("prioritizes embedded IndexedDB artwork over cache and online providers", async () => {
      const fakeBlob = new Blob(["img"], { type: "image/jpeg" });
      vi.mocked(repository.getArtwork).mockResolvedValue(fakeBlob);

      const res = await resolveArtworkForTrack({
        id: "t1",
        title: "Song",
        artist: "Artist",
        album: "Album",
      });
      expect(res).toEqual({ url: "blob:mock-url", source: "embedded" });
      expect(searchItunesArtwork).not.toHaveBeenCalled();
    });

    it("returns cached remote artwork URL when local blob does not exist", async () => {
      vi.mocked(repository.getArtwork).mockResolvedValue(undefined);
      const key = getArtworkCacheKey({ title: "Song", artist: "Artist" });
      localStorage.setItem(
        `artwork_cache_v1:${key}`,
        JSON.stringify({ url: "https://is1-ssl.mzstatic.com/cached.jpg", timestamp: Date.now() }),
      );

      const res = await resolveArtworkForTrack({ id: "t1", title: "Song", artist: "Artist" });
      expect(res.url).toBe("https://is1-ssl.mzstatic.com/cached.jpg");
      expect(res.source).toBe("cache");
      expect(searchItunesArtwork).not.toHaveBeenCalled();
    });

    it("resolves primary online artwork via MusicBrainz Release Group + Cover Art Archive", async () => {
      vi.mocked(repository.getArtwork).mockResolvedValue(undefined);

      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/release-group?")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              "release-groups": [
                {
                  id: RG_MBID,
                  title: "Random Access Memories",
                  "primary-type": "Album",
                  "artist-credit": [{ name: "Daft Punk" }],
                },
              ],
            }),
          } as Response;
        }
        if (url.includes(`coverartarchive.org/release-group/${RG_MBID}`)) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              release: `https://musicbrainz.org/ws/2/release/${REL_MBID}`,
              images: [
                {
                  front: true,
                  thumbnails: {
                    "500": `https://coverartarchive.org/release-group/${RG_MBID}/front-500`,
                  },
                },
              ],
            }),
          } as Response;
        }
        return { ok: false, status: 404 } as Response;
      });
      vi.stubGlobal("fetch", fetchMock);

      const res = await resolveArtworkForTrack({
        id: "t-ram",
        title: "Get Lucky",
        artist: "Daft Punk",
        album: "Random Access Memories",
      });

      expect(res.source).toBe("musicbrainz-caa");
      expect(res.url).toBe(`https://coverartarchive.org/release-group/${RG_MBID}/front-500`);
      expect(res.releaseGroupMbid).toBe(RG_MBID);
      expect(res.releaseMbid).toBe(REL_MBID);
      expect(searchItunesArtwork).not.toHaveBeenCalled();

      // Verify unified cache entry was written with 30-day metadata
      const cached = getCachedArtworkEntry({
        title: "Instant Crush",
        artist: "Daft Punk",
        album: "Random Access Memories",
      });
      expect(cached?.provider).toBe("musicbrainz-caa");
      expect(cached?.releaseGroupMbid).toBe(RG_MBID);
      expect(cached?.url).toBe(`https://coverartarchive.org/release-group/${RG_MBID}/front-500`);
    });

    it("falls back to individual Release Cover Art when Release Group CAA returns 404", async () => {
      vi.mocked(repository.getArtwork).mockResolvedValue(undefined);

      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/release-group?")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              "release-groups": [
                {
                  id: RG_MBID,
                  title: "Discovery",
                  "primary-type": "Album",
                  "artist-credit": [{ name: "Daft Punk" }],
                  releases: [{ id: REL_MBID, title: "Discovery", status: "Official" }],
                },
              ],
            }),
          } as Response;
        }
        if (url.includes(`coverartarchive.org/release-group/${RG_MBID}`)) {
          return { ok: false, status: 404 } as Response;
        }
        if (url.includes(`coverartarchive.org/release/${REL_MBID}`)) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              images: [
                {
                  front: true,
                  thumbnails: {
                    "500": `https://coverartarchive.org/release/${REL_MBID}/front-500`,
                  },
                },
              ],
            }),
          } as Response;
        }
        return { ok: false, status: 404 } as Response;
      });
      vi.stubGlobal("fetch", fetchMock);

      const res = await resolveArtworkForTrack({
        id: "t-disc",
        title: "One More Time",
        artist: "Daft Punk",
        album: "Discovery",
      });

      expect(res.source).toBe("musicbrainz-caa");
      expect(res.url).toBe(`https://coverartarchive.org/release/${REL_MBID}/front-500`);
      expect(res.releaseGroupMbid).toBe(RG_MBID);
      expect(res.releaseMbid).toBe(REL_MBID);
      expect(searchItunesArtwork).not.toHaveBeenCalled();
    });

    it("falls back to iTunes Search API when MusicBrainz / CAA has no match", async () => {
      vi.mocked(repository.getArtwork).mockResolvedValue(undefined);
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ "release-groups": [], releases: [] }),
      });
      vi.stubGlobal("fetch", fetchMock);
      vi.mocked(searchItunesArtwork).mockResolvedValue("https://is1-ssl.mzstatic.com/itunes-fallback.jpg");

      const res = await resolveArtworkForTrack({
        id: "t-itunes",
        title: "Rare Track",
        artist: "Indie Artist",
        album: "Indie EP",
      });

      expect(res).toEqual({
        url: "https://is1-ssl.mzstatic.com/itunes-fallback.jpg",
        source: "itunes",
        releaseGroupMbid: null,
        releaseMbid: null,
        confidence: 70,
      });
      expect(searchItunesArtwork).toHaveBeenCalledWith({
        title: "Rare Track",
        artist: "Indie Artist",
        album: "Indie EP",
        durationMs: undefined,
      });
    });

    it("respects 30-day positive cache TTL and 24-hour negative cache TTL", () => {
      const track = { title: "Song", artist: "Artist", album: "Album" };
      const key = getAlbumArtworkCacheKey(track);

      // Expired negative entry (> 24h old)
      localStorage.setItem(
        `artwork_cache_v2:${key}`,
        JSON.stringify({
          key,
          artist: "Artist",
          album: "Album",
          releaseGroupMbid: null,
          releaseMbid: null,
          url: null,
          provider: "none",
          confidence: 0,
          timestamp: Date.now() - (NEGATIVE_CACHE_TTL_MS + 5000),
          negative: true,
        }),
      );
      expect(getCachedArtworkEntry(track)).toBeUndefined();

      // Fresh positive entry (10 days old, < 30 days TTL)
      localStorage.setItem(
        `artwork_cache_v2:${key}`,
        JSON.stringify({
          key,
          artist: "Artist",
          album: "Album",
          releaseGroupMbid: RG_MBID,
          releaseMbid: null,
          url: `https://coverartarchive.org/release-group/${RG_MBID}/front-500`,
          provider: "musicbrainz-caa",
          confidence: 92,
          timestamp: Date.now() - Math.floor(POSITIVE_CACHE_TTL_MS / 3),
          negative: false,
        }),
      );
      expect(getCachedArtworkEntry(track)?.url).toBe(
        `https://coverartarchive.org/release-group/${RG_MBID}/front-500`,
      );
    });

    it("does not write a 24-hour negative cache entry on transient 503 / network failures", async () => {
      vi.mocked(repository.getArtwork).mockResolvedValue(undefined);
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
      vi.stubGlobal("fetch", fetchMock);
      vi.mocked(searchItunesArtwork).mockRejectedValue(new Error("Network error"));

      const track = { id: "t-err", title: "Song", artist: "Artist", album: "Transient Album" };
      const res = await resolveArtworkForTrack(track);
      expect(res.source).toBe("none");

      const key = getAlbumArtworkCacheKey(track);
      expect(localStorage.getItem(`artwork_cache_v2:${key}`)).toBeNull();
    });

    it("deduplicates concurrent requests for the same album", async () => {
      vi.mocked(repository.getArtwork).mockResolvedValue(undefined);
      vi.mocked(searchItunesArtwork).mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve("https://is1-ssl.mzstatic.com/dedup.jpg"), 20),
          ),
      );

      const [r1, r2] = await Promise.all([
        resolveArtworkForTrack({ id: "t1", title: "Track 1", artist: "Artist", album: "Shared Album" }),
        resolveArtworkForTrack({ id: "t2", title: "Track 2", artist: "Artist", album: "Shared Album" }),
      ]);

      expect(r1.url).toBe("https://is1-ssl.mzstatic.com/dedup.jpg");
      expect(r2.url).toBe("https://is1-ssl.mzstatic.com/dedup.jpg");
      expect(searchItunesArtwork).toHaveBeenCalledTimes(1);
    });

    it("performs only one discovery request for bulk imports from the same album and notifies all tracks", async () => {
      vi.mocked(repository.getArtwork).mockResolvedValue(undefined);
      vi.mocked(searchItunesArtwork).mockResolvedValue("https://is1-ssl.mzstatic.com/album-batch.jpg");

      const resolvedNotifications: Array<{ trackId: string; url: string }> = [];
      await resolveArtworkForAlbumBatch(
        [
          { id: "tr-1", title: "Intro", artist: "Daft Punk", album: "Homework" },
          { id: "tr-2", title: "Da Funk", artist: "Daft Punk", album: "Homework" },
          { id: "tr-3", title: "Around the World", artist: "Daft Punk", album: "Homework" },
        ],
        {
          onTrackArtworkResolved: (trackId, url) => {
            resolvedNotifications.push({ trackId, url });
          },
        },
      );

      expect(searchItunesArtwork).toHaveBeenCalledTimes(1);
      expect(resolvedNotifications).toEqual([
        { trackId: "tr-1", url: "https://is1-ssl.mzstatic.com/album-batch.jpg" },
        { trackId: "tr-2", url: "https://is1-ssl.mzstatic.com/album-batch.jpg" },
        { trackId: "tr-3", url: "https://is1-ssl.mzstatic.com/album-batch.jpg" },
      ]);
    });

    it("does not make network calls when offline", async () => {
      vi.mocked(repository.getArtwork).mockResolvedValue(undefined);
      Object.defineProperty(navigator, "onLine", { value: false, configurable: true });

      const res = await resolveArtworkForTrack({ id: "t1", title: "Song", artist: "Artist" });
      expect(res).toEqual({ url: undefined, source: "none" });
      expect(searchItunesArtwork).not.toHaveBeenCalled();
    });
  });
});
