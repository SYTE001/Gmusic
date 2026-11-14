import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetArtworkServiceForTests,
  getAlbumArtworkCacheKey,
  getArtworkCacheKey,
  getCachedArtworkEntry,
  invalidateArtworkCacheForTrack,
  markArtworkUrlFailed,
  NEGATIVE_CACHE_TTL_MS,
  POSITIVE_CACHE_TTL_MS,
  resolveArtworkForAlbumBatch,
  resolveArtworkForTrack,
} from "./artworkService";
import { __configureMusicBrainzForTests } from "./musicbrainzClient";
import { repository } from "../indexeddb/LibraryRepository";
import { searchItunesArtwork, searchItunesArtworkDetails } from "./itunesClient";
import { notifyArtworkLoaded, subscribeArtwork } from "./artworkCache";
import { parseFlacTags } from "../metadata/flac";

vi.mock("../indexeddb/LibraryRepository", () => ({
  repository: {
    getArtwork: vi.fn(),
  },
}));

vi.mock("./itunesClient", () => {
  const searchItunesArtworkMock = vi.fn();
  const searchItunesArtworkDetailsMock = vi.fn(async (track: { title: string; artist?: string; album?: string; durationMs?: number | null }) => {
    const url = await searchItunesArtworkMock(track);
    if (!url) return null;
    return {
      artworkUrl: url,
      collectionName: track.album || "Mocked Album",
      artistName: track.artist || "Mocked Artist",
      score: 75,
    };
  });

  return {
    searchItunesArtwork: searchItunesArtworkMock,
    searchItunesArtworkDetails: searchItunesArtworkDetailsMock,
  };
});

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

    it("treats generic placeholder album names ('Single', 'Downloads', 'EP') as track-scoped to prevent cross-song collisions", () => {
      const kSingle1 = getAlbumArtworkCacheKey({
        title: "Song One",
        artist: "Indie Artist",
        album: "Single",
      });
      const kSingle2 = getAlbumArtworkCacheKey({
        title: "Song Two",
        artist: "Indie Artist",
        album: "Single",
      });
      expect(kSingle1).toBe("indie artist::song one");
      expect(kSingle2).toBe("indie artist::song two");
      expect(kSingle1).not.toBe(kSingle2);
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

    it("skips a broken Cover Art Archive URL marked as failed and falls back to iTunes Search API", async () => {
      vi.mocked(repository.getArtwork).mockResolvedValue(undefined);
      const brokenCaaUrl = `https://coverartarchive.org/release-group/${RG_MBID}/front-500`;
      markArtworkUrlFailed(brokenCaaUrl);

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
              images: [
                {
                  front: true,
                  thumbnails: {
                    "500": brokenCaaUrl,
                  },
                },
              ],
            }),
          } as Response;
        }
        return { ok: true, status: 200, json: async () => ({ releases: [] }) } as Response;
      });
      vi.stubGlobal("fetch", fetchMock);
      vi.mocked(searchItunesArtwork).mockResolvedValue("https://is1-ssl.mzstatic.com/itunes-recovered.jpg");

      const res = await resolveArtworkForTrack({
        id: "t-caa-broken",
        title: "One More Time",
        artist: "Daft Punk",
        album: "Discovery",
      });

      expect(res.source).toBe("itunes");
      expect(res.url).toBe("https://is1-ssl.mzstatic.com/itunes-recovered.jpg");
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

      expect(res).toEqual(
        expect.objectContaining({
          url: "https://is1-ssl.mzstatic.com/itunes-fallback.jpg",
          source: "itunes",
          releaseGroupMbid: null,
          releaseMbid: null,
        }),
      );
      expect(searchItunesArtwork).toHaveBeenCalledWith({
        title: "Rare Track",
        artist: "Indie Artist",
        album: "Indie EP",
        durationMs: undefined,
      });
    });

    it("passes normalized metadata to online providers when raw track has YouTube channel as artist and Artist - Title in title", async () => {
      vi.mocked(repository.getArtwork).mockResolvedValue(undefined);
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ "release-groups": [], releases: [] }),
      });
      vi.stubGlobal("fetch", fetchMock);
      vi.mocked(searchItunesArtwork).mockResolvedValue("https://is1-ssl.mzstatic.com/sexyback.jpg");

      const res = await resolveArtworkForTrack({
        id: "t-noisy",
        title: "Justin Timberlake - SexyBack (Audio)",
        artist: "7clouds",
      });

      expect(res.url).toBe("https://is1-ssl.mzstatic.com/sexyback.jpg");
      expect(searchItunesArtwork).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "SexyBack",
          artist: "Justin Timberlake",
        }),
      );
    });

    it("Scenario 6: MusicBrainz receives normalized metadata instead of raw YouTube noise", async () => {
      vi.mocked(repository.getArtwork).mockResolvedValue(undefined);
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/release-group?")) {
          // Verify URL query contains escaped normalized artist "Sade"
          expect(url).toContain("artist%3A%22Sade%22");
          expect(url).not.toContain("7clouds");
          return {
            ok: true,
            status: 200,
            json: async () => ({ "release-groups": [], releases: [] }),
          } as Response;
        }
        return { ok: false, status: 404 } as Response;
      });
      vi.stubGlobal("fetch", fetchMock);
      vi.mocked(searchItunesArtwork).mockResolvedValue(null);

      await resolveArtworkForTrack({
        id: "t-sade-mb",
        title: "Sade - Smooth Operator (Lyrics)",
        artist: "7clouds",
      });

      expect(fetchMock).toHaveBeenCalled();
    });

    it("Scenario 7: iTunes receives normalized metadata and records verified album", async () => {
      vi.mocked(repository.getArtwork).mockResolvedValue(undefined);
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ "release-groups": [], releases: [] }),
      });
      vi.stubGlobal("fetch", fetchMock);

      vi.mocked(searchItunesArtworkDetails).mockResolvedValue({
        artworkUrl: "https://is1-ssl.mzstatic.com/diamond-life.jpg",
        collectionName: "Diamond Life",
        artistName: "Sade",
        score: 95,
      });

      const res = await resolveArtworkForTrack({
        id: "t-sade-itunes",
        title: "Sade - Smooth Operator (Lyrics)",
        artist: "7clouds",
      });

      expect(res.url).toBe("https://is1-ssl.mzstatic.com/diamond-life.jpg");
      expect(res.album).toBe("Diamond Life");
      expect(searchItunesArtworkDetails).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Smooth Operator",
          artist: "Sade",
        }),
      );

      // Verify cached entry has verified album
      const cached = getCachedArtworkEntry({
        title: "Smooth Operator",
        artist: "Sade",
      });
      expect(cached?.album).toBe("Diamond Life");
      expect(cached?.url).toBe("https://is1-ssl.mzstatic.com/diamond-life.jpg");
    });

    it("Scenario 8: Alternate query is used when primary search fails", async () => {
      vi.mocked(repository.getArtwork).mockResolvedValue(undefined);
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ "release-groups": [], releases: [] }),
      });
      vi.stubGlobal("fetch", fetchMock);

      // Primary search fails, but alternate query (e.g. without featured artist) succeeds
      vi.mocked(searchItunesArtworkDetails).mockImplementation(async (query) => {
        if (query.artist === "Daft Punk feat. Pharrell Williams") {
          return null; // Primary fails
        }
        if (query.artist === "Daft Punk") {
          return {
            artworkUrl: "https://is1-ssl.mzstatic.com/get-lucky.jpg",
            collectionName: "Random Access Memories",
            artistName: "Daft Punk",
            score: 90,
          };
        }
        return null;
      });

      const res = await resolveArtworkForTrack({
        id: "t-alt",
        title: "Get Lucky",
        artist: "Daft Punk feat. Pharrell Williams",
      });

      expect(res.url).toBe("https://is1-ssl.mzstatic.com/get-lucky.jpg");
      expect(res.source).toBe("itunes");
    });

    it("Scenario 10: Negative cache does not prevent retry after metadata identity changes", async () => {
      vi.mocked(repository.getArtwork).mockResolvedValue(undefined);
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ "release-groups": [], releases: [] }),
      });
      vi.stubGlobal("fetch", fetchMock);

      // 1. Initial track lookup fails and gets negatively cached
      vi.mocked(searchItunesArtworkDetails).mockResolvedValue(null);
      const initial = await resolveArtworkForTrack({
        id: "t-neg",
        title: "Corrupted Title 123",
        artist: "Unknown Band",
      });
      expect(initial.source).toBe("none");

      // Verify negative cache is stored for the old key
      const oldKey = getArtworkCacheKey({ title: "Corrupted Title 123", artist: "Unknown Band" });
      const oldEntry = getCachedArtworkEntry({ title: "Corrupted Title 123", artist: "Unknown Band" });
      expect(oldEntry?.key).toBe(oldKey);
      expect(oldEntry?.negative).toBe(true);

      // 2. User edits/corrects metadata to the real song
      vi.mocked(searchItunesArtworkDetails).mockResolvedValue({
        artworkUrl: "https://is1-ssl.mzstatic.com/smooth-operator.jpg",
        collectionName: "Diamond Life",
        artistName: "Sade",
        score: 95,
      });

      const corrected = await resolveArtworkForTrack({
        id: "t-neg",
        title: "Smooth Operator",
        artist: "Sade",
      });

      // Corrected track gets resolved because canonical identity key is different!
      expect(corrected.source).toBe("itunes");
      expect(corrected.url).toBe("https://is1-ssl.mzstatic.com/smooth-operator.jpg");

      // 3. Invalidation clears cache properly
      invalidateArtworkCacheForTrack({ title: "Smooth Operator", artist: "Sade" });
      const afterInvalidation = getCachedArtworkEntry({ title: "Smooth Operator", artist: "Sade" });
      expect(afterInvalidation).toBeUndefined();
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

    it("isolates track-specific artwork subscriptions and cleans them up on unsubscribe", () => {
      const track1Events: Array<string | undefined> = [];
      const track2Events: Array<string | undefined> = [];

      const unsub1 = subscribeArtwork("track-1", (url) => track1Events.push(url));
      const unsub2 = subscribeArtwork("track-2", (url) => track2Events.push(url));

      notifyArtworkLoaded("track-1", "https://img.test/1.jpg");
      expect(track1Events).toEqual(["https://img.test/1.jpg"]);
      expect(track2Events).toEqual([]);

      notifyArtworkLoaded("track-2", "https://img.test/2.jpg");
      expect(track1Events).toEqual(["https://img.test/1.jpg"]);
      expect(track2Events).toEqual(["https://img.test/2.jpg"]);

      unsub1();
      notifyArtworkLoaded("track-1", "https://img.test/1-updated.jpg");
      expect(track1Events).toEqual(["https://img.test/1.jpg"]); // no new event

      unsub2();
    });
  });

  describe("parseFlacTags embedded PICTURE extraction", () => {
    it("extracts FLAC PICTURE blocks into an in-memory Blob even when the description exceeds 1024 bytes", async () => {
      const mimeBytes = new TextEncoder().encode("image/png");
      const descBytes = new Uint8Array(1500).fill(0x41); // > 1024 byte description
      const imagePayload = new Uint8Array(256).fill(0x89);

      const pictureBlockLen = 4 + 4 + mimeBytes.length + 4 + descBytes.length + 16 + 4 + imagePayload.length;
      const totalLen = 4 + 4 + pictureBlockLen;
      const buf = new ArrayBuffer(totalLen);
      const bytes = new Uint8Array(buf);
      const view = new DataView(buf);

      // "fLaC" magic
      bytes.set([0x66, 0x4c, 0x61, 0x43], 0);
      // Block header: isLast=1 (0x80) | blockType=6 (0x86), 24-bit big-endian length
      bytes[4] = 0x86;
      bytes[5] = (pictureBlockLen >> 16) & 0xff;
      bytes[6] = (pictureBlockLen >> 8) & 0xff;
      bytes[7] = pictureBlockLen & 0xff;

      let pos = 8;
      view.setUint32(pos, 3); // pictureType = 3 (Front Cover)
      pos += 4;
      view.setUint32(pos, mimeBytes.length);
      pos += 4;
      bytes.set(mimeBytes, pos);
      pos += mimeBytes.length;
      view.setUint32(pos, descBytes.length);
      pos += 4;
      bytes.set(descBytes, pos);
      pos += descBytes.length;
      pos += 16; // width, height, depth, colors
      view.setUint32(pos, imagePayload.length);
      pos += 4;
      bytes.set(imagePayload, pos);

      const file = new File([buf], "sample.flac", { type: "audio/flac" });
      const parsed = await parseFlacTags(file);

      expect(parsed.artwork).toBeDefined();
      expect(parsed.artwork?.size).toBe(imagePayload.length);
      expect(parsed.artwork?.type).toBe("image/png");
    });
  });
});
