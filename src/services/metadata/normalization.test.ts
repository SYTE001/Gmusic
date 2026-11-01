import { describe, expect, it } from "vitest";
import {
  cleanNoiseFromText,
  extractArtistAndTitle,
  extractPrimaryArtist,
  extractVersionQualifiers,
  normalizeTrackMetadata,
} from "./normalization";
import type { Track } from "../../types";

describe("cleanNoiseFromText", () => {
  it("strips bracketed video descriptors", () => {
    expect(cleanNoiseFromText("Ocean Eyes (Official Music Video)").cleaned).toBe("Ocean Eyes");
    expect(cleanNoiseFromText("Ocean Eyes [Official Music Video]").cleaned).toBe("Ocean Eyes");
    expect(cleanNoiseFromText("Ocean Eyes (Dance Performance Video)").cleaned).toBe("Ocean Eyes");
    expect(cleanNoiseFromText("Ocean Eyes (Official Audio)").cleaned).toBe("Ocean Eyes");
    expect(cleanNoiseFromText("Ocean Eyes (Visualizer)").cleaned).toBe("Ocean Eyes");
    expect(cleanNoiseFromText("Ocean Eyes [Visualizer]").cleaned).toBe("Ocean Eyes");
    expect(cleanNoiseFromText("Ocean Eyes [MV]").cleaned).toBe("Ocean Eyes");
    expect(cleanNoiseFromText("Ocean Eyes (Clip Officiel)").cleaned).toBe("Ocean Eyes");
  });

  it("strips bracketed lyrics indicators", () => {
    expect(cleanNoiseFromText("Ocean Eyes (Lyrics)").cleaned).toBe("Ocean Eyes");
    expect(cleanNoiseFromText("Ocean Eyes [Lyric Video]").cleaned).toBe("Ocean Eyes");
    expect(cleanNoiseFromText("Ocean Eyes (Lyrics Video)").cleaned).toBe("Ocean Eyes");
  });

  it("strips release descriptors like Remastered", () => {
    expect(cleanNoiseFromText("Ocean Eyes (2011 Remaster)").cleaned).toBe("Ocean Eyes");
    expect(cleanNoiseFromText("Ocean Eyes (Remastered 2011)").cleaned).toBe("Ocean Eyes");
    expect(cleanNoiseFromText("Ocean Eyes [Remastered]").cleaned).toBe("Ocean Eyes");
    expect(cleanNoiseFromText("Ocean Eyes - Remastered").cleaned).toBe("Ocean Eyes");
  });

  it("strips resolution and quality tags", () => {
    expect(cleanNoiseFromText("Ocean Eyes [HD]").cleaned).toBe("Ocean Eyes");
    expect(cleanNoiseFromText("Ocean Eyes [4K]").cleaned).toBe("Ocean Eyes");
    expect(cleanNoiseFromText("Ocean Eyes [1080p]").cleaned).toBe("Ocean Eyes");
    expect(cleanNoiseFromText("Ocean Eyes [HQ]").cleaned).toBe("Ocean Eyes");
    expect(cleanNoiseFromText("Ocean Eyes HD").cleaned).toBe("Ocean Eyes");
    expect(cleanNoiseFromText("Ocean Eyes 4K").cleaned).toBe("Ocean Eyes");
  });

  it("strips unbracketed video descriptors", () => {
    expect(cleanNoiseFromText("Billie Eilish Ocean Eyes Official Video").cleaned).toBe("Billie Eilish Ocean Eyes");
    expect(cleanNoiseFromText("Ocean Eyes Official Music Video").cleaned).toBe("Ocean Eyes");
    expect(cleanNoiseFromText("Ocean Eyes Lyric Video").cleaned).toBe("Ocean Eyes");
  });

  it("strips Topic suffix from YouTube artist topics", () => {
    expect(cleanNoiseFromText("Billie Eilish - Topic").cleaned).toBe("Billie Eilish");
    expect(cleanNoiseFromText("Billie Eilish Topic").cleaned).toBe("Billie Eilish");
  });

  it("preserves meaningful version qualifiers", () => {
    expect(cleanNoiseFromText("Ocean Eyes (Live Acoustic)").cleaned).toBe("Ocean Eyes (Live Acoustic)");
    expect(cleanNoiseFromText("Ocean Eyes (Steve Aoki Remix)").cleaned).toBe("Ocean Eyes (Steve Aoki Remix)");
    expect(cleanNoiseFromText("Ocean Eyes (Radio Edit)").cleaned).toBe("Ocean Eyes (Radio Edit)");
    expect(cleanNoiseFromText("Ocean Eyes (Acoustic)").cleaned).toBe("Ocean Eyes (Acoustic)");
    expect(cleanNoiseFromText("Ocean Eyes (Live)").cleaned).toBe("Ocean Eyes (Live)");
    expect(cleanNoiseFromText("Ocean Eyes (feat. Khalid)").cleaned).toBe("Ocean Eyes (feat. Khalid)");
    expect(cleanNoiseFromText("Ocean Eyes (Instrumental)").cleaned).toBe("Ocean Eyes (Instrumental)");
  });

  it("strips noise while preserving meaningful version descriptors in combined titles", () => {
    expect(cleanNoiseFromText("Ocean Eyes (Live Acoustic) [Official Video] HD").cleaned).toBe("Ocean Eyes (Live Acoustic)");
    expect(cleanNoiseFromText("Ocean Eyes (feat. Khalid) (Official Audio)").cleaned).toBe("Ocean Eyes (feat. Khalid)");
  });
});

describe("extractVersionQualifiers", () => {
  it("detects acoustic, live, remix, and radio edit qualifiers", () => {
    expect(Array.from(extractVersionQualifiers("Ocean Eyes (Live Acoustic)"))).toEqual(
      expect.arrayContaining(["live", "acoustic"]),
    );
    expect(Array.from(extractVersionQualifiers("Ocean Eyes (Steve Aoki Remix)"))).toEqual(["remix"]);
    expect(Array.from(extractVersionQualifiers("Ocean Eyes (Radio Edit)"))).toEqual(["radio edit"]);
    expect(Array.from(extractVersionQualifiers("Ocean Eyes"))).toEqual([]);
  });
});

describe("extractPrimaryArtist", () => {
  it("extracts principal artist from featured / collaboration strings", () => {
    expect(extractPrimaryArtist("Billie Eilish feat. Khalid")).toBe("Billie Eilish");
    expect(extractPrimaryArtist("Billie Eilish ft. Khalid")).toBe("Billie Eilish");
    expect(extractPrimaryArtist("Billie Eilish featuring Khalid")).toBe("Billie Eilish");
    expect(extractPrimaryArtist("Billie Eilish & Khalid")).toBe("Billie Eilish");
    expect(extractPrimaryArtist("Billie Eilish, Khalid")).toBe("Billie Eilish");
    expect(extractPrimaryArtist("Billie Eilish")).toBe("Billie Eilish");
  });
});

describe("extractArtistAndTitle", () => {
  it("parses Artist - Title with hyphen", () => {
    const res = extractArtistAndTitle("Billie Eilish - Ocean Eyes");
    expect(res.artist).toBe("Billie Eilish");
    expect(res.title).toBe("Ocean Eyes");
  });

  it("parses Artist — Title with em dash", () => {
    const res = extractArtistAndTitle("Billie Eilish — Ocean Eyes");
    expect(res.artist).toBe("Billie Eilish");
    expect(res.title).toBe("Ocean Eyes");
  });

  it("parses Artist – Title with en dash", () => {
    const res = extractArtistAndTitle("Billie Eilish – Ocean Eyes");
    expect(res.artist).toBe("Billie Eilish");
    expect(res.title).toBe("Ocean Eyes");
  });

  it("parses Artist | Title with pipe", () => {
    const res = extractArtistAndTitle("Billie Eilish | Ocean Eyes");
    expect(res.artist).toBe("Billie Eilish");
    expect(res.title).toBe("Ocean Eyes");
  });

  it("identifies reversed Title - Artist when known artists match", () => {
    const knownArtists = new Set(["billie eilish"]);
    const res = extractArtistAndTitle("Ocean Eyes - Billie Eilish", { knownArtists });
    expect(res.artist).toBe("Billie Eilish");
    expect(res.title).toBe("Ocean Eyes");
    expect(res.isFlipped).toBe(true);
  });

  it("infers title when one side carries version descriptors", () => {
    const res = extractArtistAndTitle("Ocean Eyes (Live Acoustic) - Billie Eilish");
    expect(res.artist).toBe("Billie Eilish");
    expect(res.title).toBe("Ocean Eyes (Live Acoustic)");
  });

  it("handles title with no delimiters", () => {
    const knownArtists = new Set(["billie eilish"]);
    const res = extractArtistAndTitle("Billie Eilish Ocean Eyes", { knownArtists });
    expect(res.artist).toBe("Billie Eilish");
    expect(res.title).toBe("Ocean Eyes");
  });
});

describe("normalizeTrackMetadata", () => {
  function makeTrack(overrides: Partial<Track> = {}): Track {
    return {
      id: "t1",
      title: "Billie Eilish - Ocean Eyes (Dance Performance Video)",
      artist: "",
      album: "",
      trackNumber: null,
      albumTrackCount: null,
      durationMs: 200000,
      fileName: "Billie Eilish - Ocean Eyes (Dance Performance Video).mp3",
      fileSize: 1,
      mimeType: "audio/mpeg",
      addedAt: 1,
      lastPlayedAt: null,
      playCount: 0,
      isLiked: false,
      availability: "available",
      accessMode: "stored-copy",
      fingerprint: null,
      metadataFromFilename: true,
      ...overrides,
    };
  }

  it("normalizes Case A: Billie Eilish - Ocean Eyes (Dance Performance Video)", () => {
    const normalized = normalizeTrackMetadata(makeTrack());
    expect(normalized.artist).toBe("Billie Eilish");
    expect(normalized.title).toBe("Ocean Eyes");
    expect(normalized.cleanedTitle).toBe("Ocean Eyes");
    expect(normalized.original.title).toBe("Billie Eilish - Ocean Eyes (Dance Performance Video)");
  });

  it("normalizes Case B: Ocean Eyes - Billie Eilish (reversed)", () => {
    const normalized = normalizeTrackMetadata(
      makeTrack({
        title: "Ocean Eyes - Billie Eilish",
        fileName: "Ocean Eyes - Billie Eilish.mp3",
      }),
      { libraryTracks: [{ artist: "Billie Eilish" } as Track] },
    );
    expect(normalized.artist).toBe("Billie Eilish");
    expect(normalized.title).toBe("Ocean Eyes");
  });

  it("normalizes Case C: Billie Eilish - Ocean Eyes [Official Music Video] HD", () => {
    const normalized = normalizeTrackMetadata(
      makeTrack({
        title: "Billie Eilish - Ocean Eyes [Official Music Video] HD",
        fileName: "Billie Eilish - Ocean Eyes [Official Music Video] HD.mp3",
      }),
    );
    expect(normalized.artist).toBe("Billie Eilish");
    expect(normalized.title).toBe("Ocean Eyes");
  });

  it("normalizes Case D: Ocean Eyes (Live Acoustic) - Billie Eilish while preserving Live Acoustic", () => {
    const normalized = normalizeTrackMetadata(
      makeTrack({
        title: "Ocean Eyes (Live Acoustic) - Billie Eilish",
        fileName: "Ocean Eyes (Live Acoustic) - Billie Eilish.mp3",
      }),
    );
    expect(normalized.artist).toBe("Billie Eilish");
    expect(normalized.title).toBe("Ocean Eyes (Live Acoustic)");
    expect(normalized.versionType).toContain("acoustic");
  });

  it("generates alternative queries including swapped order and cleaned variants", () => {
    const normalized = normalizeTrackMetadata(
      makeTrack({
        title: "Billie Eilish - Ocean Eyes (Dance Performance Video)",
      }),
    );
    expect(normalized.alternateQueries.length).toBeGreaterThan(0);
    const hasCleaned = normalized.alternateQueries.some(
      (q) => q.trackName === "Ocean Eyes" && q.artistName === "Billie Eilish",
    );
    expect(hasCleaned).toBe(true);
  });
});
