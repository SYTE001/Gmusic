import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../../types";
import { repository } from "../indexeddb/LibraryRepository";
import { resolveLyricsForTrack } from "./lyricsService";
import { normalizeTrackMetadata } from "../metadata/normalization";
import { decideMatch } from "./matching";
import type { LrcmuxRecord } from "./lrcmuxClient";

vi.mock("./lrcmuxClient", async (importOriginal) => {
  const original = await importOriginal<typeof import("./lrcmuxClient")>();
  return {
    ...original,
    lrcmuxGet: vi.fn(),
    lrcmuxSearch: vi.fn(),
  };
});

const { lrcmuxGet, lrcmuxSearch } = await import("./lrcmuxClient");
const getMock = vi.mocked(lrcmuxGet);
const searchMock = vi.mocked(lrcmuxSearch);

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: "track-1",
    title: "",
    artist: "",
    album: "",
    trackNumber: null,
    albumTrackCount: null,
    durationMs: 200000,
    fileName: "",
    fileSize: 1000,
    mimeType: "audio/mpeg",
    addedAt: 1,
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

function makeOceanEyesRecord(overrides: Partial<LrcmuxRecord> = {}): LrcmuxRecord {
  return {
    id: 101,
    trackName: "Ocean Eyes",
    artistName: "Billie Eilish",
    albumName: "Don't Smile at Me",
    duration: 200,
    instrumental: false,
    hasWordSync: false,
    plainLyrics: "I've been watchin' you for some time...",
    syncedLyrics: "[00:13.00]I've been watchin' you for some time\n[00:17.50]Can't stop starin' at those ocean eyes",
    lyricsfile: null,
    ...overrides,
  };
}

describe("PRD §9: Mandatory Test Cases", () => {
  beforeEach(async () => {
    await repository.clearAllData();
    getMock.mockReset();
    searchMock.mockReset();
  });

  /**
   * Case A — Primary issue
   * Input: Billie Eilish - Ocean Eyes (Dance Performance Video)
   * Expected:
   * - Artist: Billie Eilish
   * - Title: Ocean Eyes
   * - Find the correct Ocean Eyes lyrics if present in the provider library.
   */
  it("Case A — Primary issue: normalizes video label and finds correct lyrics", async () => {
    const rawInput = "Billie Eilish - Ocean Eyes (Dance Performance Video)";
    const track = makeTrack({
      title: rawInput,
      fileName: `${rawInput}.mp3`,
    });

    const normalized = normalizeTrackMetadata(track);
    expect(normalized.artist).toBe("Billie Eilish");
    expect(normalized.title).toBe("Ocean Eyes");

    // Provider returns standard recording on exact query
    getMock.mockResolvedValue(makeOceanEyesRecord());

    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");
    expect(getMock).toHaveBeenCalledWith(
      expect.objectContaining({
        trackName: "Ocean Eyes",
        artistName: "Billie Eilish",
      }),
      undefined,
    );

    const savedLyrics = await repository.getLyrics(track.id);
    expect(savedLyrics).not.toBeNull();
    expect(savedLyrics?.origin?.matchedTitle).toBe("Ocean Eyes");
    expect(savedLyrics?.origin?.matchedArtist).toBe("Billie Eilish");
  });

  /**
   * Case B — Reversed metadata
   * Input: Ocean Eyes - Billie Eilish
   * Expected: Same canonical identity as Case A.
   */
  it("Case B — Reversed metadata: resolves to canonical identity and finds lyrics", async () => {
    const rawInput = "Ocean Eyes - Billie Eilish";
    const track = makeTrack({
      title: rawInput,
      fileName: `${rawInput}.mp3`,
    });

    // Provide context of known artist in library
    const normalized = normalizeTrackMetadata(track, {
      libraryTracks: [makeTrack({ artist: "Billie Eilish" })],
    });
    expect(normalized.artist).toBe("Billie Eilish");
    expect(normalized.title).toBe("Ocean Eyes");

    // Even without prior library context, alternative search query in Stage C resolves it
    getMock.mockImplementation(async (query) => {
      if (query.trackName === "Ocean Eyes" && query.artistName === "Billie Eilish") {
        return makeOceanEyesRecord();
      }
      return null;
    });
    searchMock.mockImplementation(async (query) => {
      if (
        (query.trackName === "Ocean Eyes" && query.artistName === "Billie Eilish") ||
        (query.trackName === "Billie Eilish" && query.artistName === "Ocean Eyes")
      ) {
        return [makeOceanEyesRecord()];
      }
      return [];
    });

    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");

    const savedLyrics = await repository.getLyrics(track.id);
    expect(savedLyrics?.origin?.matchedTitle).toBe("Ocean Eyes");
    expect(savedLyrics?.origin?.matchedArtist).toBe("Billie Eilish");
  });

  /**
   * Case C — Noisy metadata
   * Input: Billie Eilish - Ocean Eyes [Official Music Video] HD
   * Expected: Same canonical identity as Case A.
   */
  it("Case C — Noisy metadata: strips brackets and resolution suffixes", async () => {
    const rawInput = "Billie Eilish - Ocean Eyes [Official Music Video] HD";
    const track = makeTrack({
      title: rawInput,
      fileName: `${rawInput}.mp3`,
    });

    const normalized = normalizeTrackMetadata(track);
    expect(normalized.artist).toBe("Billie Eilish");
    expect(normalized.title).toBe("Ocean Eyes");

    getMock.mockResolvedValue(makeOceanEyesRecord());

    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");
    expect(getMock).toHaveBeenCalledWith(
      expect.objectContaining({
        trackName: "Ocean Eyes",
        artistName: "Billie Eilish",
      }),
      undefined,
    );
  });

  /**
   * Case D — Legitimate alternate version
   * Input: Ocean Eyes (Live Acoustic) - Billie Eilish
   * Expected: Preserve the Live Acoustic distinction and avoid incorrectly
   * attaching studio-version lyrics when recording identity differs.
   */
  it("Case D — Legitimate alternate version: preserves version distinction and rejects studio lyrics", async () => {
    const rawInput = "Ocean Eyes (Live Acoustic) - Billie Eilish";
    const track = makeTrack({
      title: rawInput,
      fileName: `${rawInput}.mp3`,
      durationMs: 240000,
    });

    const normalized = normalizeTrackMetadata(track);
    expect(normalized.title).toBe("Ocean Eyes (Live Acoustic)");
    expect(normalized.artist).toBe("Billie Eilish");
    expect(normalized.versionType).toContain("acoustic");

    // Provider only has the studio version
    getMock.mockResolvedValue(null);
    searchMock.mockResolvedValue([makeOceanEyesRecord({ trackName: "Ocean Eyes", duration: 200 })]);

    // Candidate evaluation must NOT auto-accept the studio record
    const decision = decideMatch(track, makeOceanEyesRecord());
    expect(decision.quality.versionMismatch).toBe(true);
    expect(decision.autoAccept).toBe(false);

    const result = await resolveLyricsForTrack(track);
    // Not auto-accepted — offered in chooser (needs-selection) rather than silent attach
    expect(result.outcome).toBe("needs-selection");
    if (result.outcome === "needs-selection") {
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.candidates[0].autoAcceptable).toBe(false);
    }
  });

  /**
   * Case E — Ambiguous title
   * Input: A song title shared by multiple artists.
   * Expected: Artist identity must be validated before accepting lyrics.
   */
  it("Case E — Ambiguous title: validates artist identity and rejects mismatched artists", async () => {
    const track = makeTrack({
      title: "Hello",
      artist: "Adele",
      durationMs: 295000,
    });

    // Candidate is "Hello" by Lionel Richie
    const lionelRecord: LrcmuxRecord = {
      id: 88,
      trackName: "Hello",
      artistName: "Lionel Richie",
      albumName: "Can't Slow Down",
      duration: 250,
      instrumental: false,
      hasWordSync: false,
      plainLyrics: "Hello, is it me you're looking for?",
      syncedLyrics: "[00:20.00]Hello, is it me you're looking for?",
      lyricsfile: null,
    };

    getMock.mockResolvedValue(lionelRecord);
    searchMock.mockResolvedValue([lionelRecord]);

    const result = await resolveLyricsForTrack(track);
    // The candidate describes a different artist, so it must NOT be auto-accepted
    expect(result.outcome).not.toBe("attached");

    const decision = decideMatch(track, lionelRecord);
    expect(decision.autoAccept).toBe(false);
    expect(decision.quality.artistSimilarity).toBeLessThan(0.4);
  });

  /**
   * Case F — Missing metadata
   * Input: Audio with no embedded title or artist, but a meaningful filename.
   * Expected: Attempt filename-based metadata extraction before declaring lyrics unavailable.
   */
  it("Case F — Missing metadata: extracts metadata from filename and resolves lyrics", async () => {
    // No embedded metadata in title or artist fields
    const track = makeTrack({
      title: "",
      artist: "",
      fileName: "02 - Billie Eilish - Ocean Eyes [Official Audio].mp3",
    });

    const normalized = normalizeTrackMetadata(track);
    expect(normalized.artist).toBe("Billie Eilish");
    expect(normalized.title).toBe("Ocean Eyes");

    getMock.mockResolvedValue(makeOceanEyesRecord());

    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");
    expect(getMock).toHaveBeenCalledWith(
      expect.objectContaining({
        trackName: "Ocean Eyes",
        artistName: "Billie Eilish",
      }),
      undefined,
    );

    const savedLyrics = await repository.getLyrics(track.id);
    expect(savedLyrics).not.toBeNull();
    expect(savedLyrics?.origin?.matchedTitle).toBe("Ocean Eyes");
  });
});
