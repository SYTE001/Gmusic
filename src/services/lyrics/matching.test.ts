import { describe, expect, it } from "vitest";
import { decideMatch, evaluateMatch, rankCandidates } from "./matching";
import type { LrclibRecord } from "./lrclibClient";
import type { Track } from "../../types";

const track: Pick<Track, "title" | "artist" | "album" | "durationMs"> = {
  title: "Gentle Rise",
  artist: "Aurora Fields",
  album: "Northern Lights",
  durationMs: 212000,
};

function record(overrides: Partial<LrclibRecord> = {}): LrclibRecord {
  return {
    id: 1,
    trackName: "Gentle Rise",
    artistName: "Aurora Fields",
    albumName: "Northern Lights",
    duration: 212,
    instrumental: false,
    hasWordSync: false,
    plainLyrics: "text",
    syncedLyrics: "[00:01.00]text",
    lyricsfile: null,
    ...overrides,
  };
}

describe("evaluateMatch", () => {
  it("scores an exact metadata match near 100 and accepts it", () => {
    const decision = decideMatch(track, record());
    expect(decision.quality.score).toBeGreaterThanOrEqual(95);
    expect(decision.autoAccept).toBe(true);
  });

  it("accepts a match with light annotation noise in artist/album", () => {
    const decision = decideMatch(
      track,
      record({ artistName: "Aurora Fields - 2011 Remaster", albumName: "Northern Lights (Deluxe)" }),
    );
    expect(decision.quality.artistSimilarity).toBeGreaterThanOrEqual(0.9);
    expect(decision.autoAccept).toBe(true);
  });

  it("accepts a match when the local track has no album or artist", () => {
    const bare: Pick<Track, "title" | "artist" | "album" | "durationMs"> = {
      title: "Gentle Rise",
      artist: "",
      album: "",
      durationMs: 212000,
    };
    const decision = decideMatch(bare, record());
    expect(decision.quality.artistSimilarity).toBeNull();
    expect(decision.autoAccept).toBe(true);
  });

  it("rejects a clearly different title", () => {
    const decision = decideMatch(track, record({ trackName: "Completely Different Song" }));
    expect(decision.quality.rejected).toBe(true);
    expect(decision.autoAccept).toBe(false);
    expect(decision.candidate).toBe(false);
  });

  it("never auto-accepts a clearly different artist, but keeps it choosable (covers)", () => {
    const decision = decideMatch(track, record({ artistName: "Another Band Entirely" }));
    expect(decision.quality.rejected).toBe(false);
    expect(decision.autoAccept).toBe(false);
    expect(decision.candidate).toBe(true);
  });

  it("rejects when both title and artist are clearly different", () => {
    const decision = decideMatch(track, record({ trackName: "Violent Rise", artistName: "Someone Else" }));
    expect(decision.quality.rejected).toBe(true);
    expect(decision.candidate).toBe(false);
  });

  it("rejects a different recording with a wildly different duration", () => {
    const decision = decideMatch(track, record({ trackName: "Gentle Rise (Live 12 Minute Version)", duration: 721 }));
    expect(decision.quality.rejected).toBe(true);
  });

  it("penalizes duration drift in the score", () => {
    const close = evaluateMatch(track, record({ duration: 214 }));
    const far = evaluateMatch(track, record({ duration: 224 }));
    expect(close.score).toBeGreaterThan(far.score);
    expect(far.durationDeltaSeconds).toBe(12);
  });

  it("does not reject on duration when the title is an exact match (editions)", () => {
    const decision = decideMatch(track, record({ duration: 200 }));
    expect(decision.quality.rejected).toBe(false);
  });
});

describe("rankCandidates", () => {
  it("drops rejected records and ranks synced above plain, word-sync above line-sync", () => {
    const ranked = rankCandidates(track, [
      record({ id: 10, syncedLyrics: null }), // plain only
      record({ id: 11, trackName: "Totally Unrelated" }), // rejected
      record({ id: 12 }), // line sync
      record({ id: 13, hasWordSync: true }), // word sync
    ]);
    expect(ranked.map((entry) => entry.record.id)).toEqual([13, 12, 10]);
  });

  it("breaks sync ties by score", () => {
    const ranked = rankCandidates(track, [
      record({ id: 1, duration: 212 }),
      record({ id: 2, duration: 230, artistName: "Aurora Fields Trio" }),
    ]);
    expect(ranked[0].record.id).toBe(1);
  });

  it("caps the candidate list length", () => {
    const many = Array.from({ length: 30 }, (_, i) => record({ id: i }));
    expect(rankCandidates(track, many)).toHaveLength(12);
  });
});

describe("low-confidence handling", () => {
  it("marks a partial match as a candidate but not auto-accepted", () => {
    // Same title, different artist — plausible cover, but never silent-attach.
    const decision = decideMatch(track, record({ artistName: "Cover Band", albumName: "Covers", duration: 213 }));
    expect(decision.autoAccept).toBe(false);
    expect(decision.candidate).toBe(true);
  });
});
