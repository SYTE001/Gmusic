import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeStringSimilarity,
  levenshteinDistance,
  searchItunesArtwork,
  validateAndRankItunesResults,
  type ItunesTrackResult,
} from "./itunesClient";

describe("itunesClient", () => {
  describe("string similarity and levenshtein", () => {
    it("computes exact match as 1", () => {
      expect(computeStringSimilarity("Yellow", "Yellow")).toBe(1);
      expect(computeStringSimilarity("Coldplay", "coldplay")).toBe(1);
    });

    it("handles empty strings", () => {
      expect(levenshteinDistance("", "abc")).toBe(3);
      expect(computeStringSimilarity("", "abc")).toBe(0);
    });

    it("gives high score for substring containment", () => {
      expect(computeStringSimilarity("Coldplay", "Coldplay - Live in Buenos Aires")).toBeGreaterThanOrEqual(0.9);
    });
  });

  describe("validateAndRankItunesResults", () => {
    const localTrack = {
      title: "Blinding Lights",
      artist: "The Weeknd",
      album: "After Hours",
      durationMs: 200000,
    };

    it("ranks the original track over remixes and live versions", () => {
      const results: ItunesTrackResult[] = [
        {
          trackId: 101,
          trackName: "Blinding Lights (Remix)",
          artistName: "The Weeknd & ROSALÍA",
          collectionName: "Blinding Lights (Remix) - Single",
          artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/1/100x100bb.jpg",
          trackTimeMillis: 200000,
        },
        {
          trackId: 102,
          trackName: "Blinding Lights",
          artistName: "The Weeknd",
          collectionName: "After Hours",
          artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/2/100x100bb.jpg",
          trackTimeMillis: 200000,
        },
      ];

      const ranked = validateAndRankItunesResults(localTrack, results);
      expect(ranked.length).toBeGreaterThan(0);
      expect(ranked[0].result.trackId).toBe(102);
      expect(ranked[0].artworkUrl).toBe("https://is1-ssl.mzstatic.com/image/thumb/2/600x600bb.jpg");
      expect(ranked[0].score).toBeGreaterThan(ranked[1]?.score ?? 0);
    });

    it("rejects results with mismatched artist when local track has artist", () => {
      const results: ItunesTrackResult[] = [
        {
          trackId: 999,
          trackName: "Blinding Lights",
          artistName: "Completely Different Artist",
          artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/9/100x100bb.jpg",
          trackTimeMillis: 200000,
        },
      ];

      const ranked = validateAndRankItunesResults(localTrack, results);
      expect(ranked.length).toBe(0);
    });

    it("rejects results with completely different title", () => {
      const results: ItunesTrackResult[] = [
        {
          trackId: 888,
          trackName: "Starboy",
          artistName: "The Weeknd",
          artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/8/100x100bb.jpg",
        },
      ];

      const ranked = validateAndRankItunesResults(localTrack, results);
      expect(ranked.length).toBe(0);
    });

    it("accepts title matches when local track has no artist", () => {
      const bareTrack = { title: "Bohemian Rhapsody" };
      const results: ItunesTrackResult[] = [
        {
          trackId: 777,
          trackName: "Bohemian Rhapsody",
          artistName: "Queen",
          artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/7/100x100bb.jpg",
        },
      ];

      const ranked = validateAndRankItunesResults(bareTrack, results);
      expect(ranked.length).toBe(1);
      expect(ranked[0].artworkUrl).toBe("https://is1-ssl.mzstatic.com/image/thumb/7/600x600bb.jpg");
    });
  });

  describe("searchItunesArtwork", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("returns null for empty track title", async () => {
      const url = await searchItunesArtwork({ title: "" });
      expect(url).toBeNull();
    });

    it("fetches from iTunes Search API and returns high-res artwork on match", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          resultCount: 1,
          results: [
            {
              trackId: 1,
              trackName: "Yellow",
              artistName: "Coldplay",
              artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/123/100x100bb.jpg",
            },
          ],
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const artwork = await searchItunesArtwork({ title: "Yellow", artist: "Coldplay" });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(artwork).toBe("https://is1-ssl.mzstatic.com/image/thumb/123/600x600bb.jpg");
    });

    it("returns null on network failure without throwing", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network offline")));
      const artwork = await searchItunesArtwork({ title: "Yellow", artist: "Coldplay" });
      expect(artwork).toBeNull();
    });

    it("returns null on non-200 response without throwing", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
      const artwork = await searchItunesArtwork({ title: "Yellow", artist: "Coldplay" });
      expect(artwork).toBeNull();
    });
  });
});
