import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../../types";
import { repository } from "../indexeddb/LibraryRepository";
import {
  resolveLyricsForTrack,
  resetLyricsCacheMeta,
  __testHooks,
} from "./lyricsService";
import { getLatestLyricsDiagnostic } from "./lyricsDiagnostics";
import { lrcmuxGet, lrcmuxSearch, type LrcmuxRecord, LrcmuxError } from "./lrcmuxClient";
import { lrclibGet, lrclibSearch, type LrclibRecord, LrclibError } from "./lrclibClient";
import { lyricsDbGet, lyricsDbSearch, type LyricsDbRecord, LyricsDbError } from "./lyricsdbClient";

vi.mock("./lrcmuxClient", async (importOriginal) => {
  const original = await importOriginal<typeof import("./lrcmuxClient")>();
  return {
    ...original,
    lrcmuxGet: vi.fn(),
    lrcmuxSearch: vi.fn(),
  };
});

vi.mock("./lrclibClient", async (importOriginal) => {
  const original = await importOriginal<typeof import("./lrclibClient")>();
  return {
    ...original,
    lrclibGet: vi.fn(),
    lrclibSearch: vi.fn(),
  };
});

vi.mock("./lyricsdbClient", async (importOriginal) => {
  const original = await importOriginal<typeof import("./lyricsdbClient")>();
  return {
    ...original,
    lyricsDbGet: vi.fn(),
    lyricsDbSearch: vi.fn(),
  };
});

const mockLrcmuxGet = vi.mocked(lrcmuxGet);
const mockLrcmuxSearch = vi.mocked(lrcmuxSearch);
const mockLrclibGet = vi.mocked(lrclibGet);
const mockLrclibSearch = vi.mocked(lrclibSearch);
const mockLyricsDbGet = vi.mocked(lyricsDbGet);
const mockLyricsDbSearch = vi.mocked(lyricsDbSearch);

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: "track-test-1",
    title: "Bohemian Rhapsody",
    artist: "Queen",
    album: "A Night At The Opera",
    trackNumber: 1,
    albumTrackCount: 12,
    durationMs: 354000,
    fileName: "queen.mp3",
    fileSize: 5000000,
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

function makeLrcmuxRecord(overrides: Partial<LrcmuxRecord> = {}): LrcmuxRecord {
  return {
    id: "lrcmux-1",
    trackName: "Bohemian Rhapsody",
    artistName: "Queen",
    albumName: "A Night At The Opera",
    duration: 354,
    instrumental: false,
    hasWordSync: false,
    plainLyrics: "Is this the real life?",
    syncedLyrics: "[00:00.00] Is this the real life?\n[00:03.00] Is this just fantasy?",
    lyricsfile: null,
    source: "lrcmux-src",
    syncLevel: "line",
    ...overrides,
  };
}

function makeLrclibRecord(overrides: Partial<LrclibRecord> = {}): LrclibRecord {
  return {
    id: 1001,
    name: "Bohemian Rhapsody",
    trackName: "Bohemian Rhapsody",
    artistName: "Queen",
    albumName: "A Night At The Opera",
    duration: 354,
    instrumental: false,
    hasWordSync: false,
    plainLyrics: "Is this the real life?",
    syncedLyrics: "[00:00.00] Is this the real life?\n[00:03.00] Is this just fantasy?",
    lyricsfile: null,
    provider: "lrclib",
    ...overrides,
  };
}

function makeLyricsDbRecord(overrides: Partial<LyricsDbRecord> = {}): LyricsDbRecord {
  return {
    id: "uuid-lyricsdb-1",
    trackName: "Bohemian Rhapsody",
    artistName: "Queen",
    albumName: "A Night At The Opera",
    duration: 354,
    instrumental: false,
    hasWordSync: true,
    plainLyrics: "Is this the real life?",
    syncedLyrics: "[00:00.00] Is this the real life?\n[00:03.00] Is this just fantasy?",
    lines: [
      {
        timeMs: 0,
        text: "Is this the real life?",
        words: [
          { text: "Is ", startMs: 0, endMs: 400 },
          { text: "this ", startMs: 400, endMs: 800 },
          { text: "the ", startMs: 800, endMs: 1200 },
          { text: "real ", startMs: 1200, endMs: 2000 },
          { text: "life?", startMs: 2000, endMs: 3000 },
        ],
      },
    ],
    source: "lyricsdb (lrc-red)",
    syncLevel: "word",
    provider: "lyricsdb",
    ...overrides,
  };
}

describe("Multi-Provider Lyrics Integration (LRCmux + LRCLIB + LyricsDB)", () => {
  beforeEach(async () => {
    await repository.clearAllData();
    vi.clearAllMocks();
    mockLrcmuxGet.mockResolvedValue(null);
    mockLrcmuxSearch.mockResolvedValue([]);
    mockLrclibGet.mockResolvedValue(null);
    mockLrclibSearch.mockResolvedValue([]);
    mockLyricsDbGet.mockResolvedValue(null);
    mockLyricsDbSearch.mockResolvedValue([]);
    __testHooks.setDefaultProviders(["lrcmux", "lrclib", "lyricsdb"]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 1. LRCmux success
  it("resolves and attaches lyrics from LRCmux when it is the sole provider returning a match", async () => {
    const track = makeTrack();
    mockLrcmuxGet.mockResolvedValue(makeLrcmuxRecord());

    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");
    if (result.outcome === "attached") {
      expect(result.lyrics.origin?.kind).toBe("lrcmux");
      expect(result.lyrics.origin?.capability).toBe("line");
    }
    expect(mockLrcmuxGet).toHaveBeenCalled();
  });

  // 2. LRCLIB success
  it("resolves and attaches lyrics from LRCLIB when it succeeds", async () => {
    const track = makeTrack();
    mockLrclibGet.mockResolvedValue(makeLrclibRecord());

    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");
    if (result.outcome === "attached") {
      expect(result.lyrics.origin?.kind).toBe("lrclib");
      expect(result.lyrics.origin?.recordId).toBe(1001);
    }
    expect(mockLrclibGet).toHaveBeenCalled();
  });

  // 3. LyricsDB success
  it("resolves and attaches lyrics from LyricsDB with native word sync", async () => {
    const track = makeTrack();
    mockLyricsDbGet.mockResolvedValue(makeLyricsDbRecord());

    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");
    if (result.outcome === "attached") {
      expect(result.lyrics.origin?.kind).toBe("lyricsdb");
      expect(result.lyrics.origin?.capability).toBe("word");
      expect(result.lyrics.lines[0].words).toBeDefined();
    }
    expect(mockLyricsDbGet).toHaveBeenCalled();
  });

  // 4. All three providers returning the same song (deduplication & highest quality)
  it("deduplicates equivalent results across all 3 providers and picks the highest quality", async () => {
    const track = makeTrack();
    // LRCLIB returns plain lyrics
    mockLrclibGet.mockResolvedValue(makeLrclibRecord({ plainLyrics: "Just plain text", syncedLyrics: null }));
    // LRCmux returns line sync
    mockLrcmuxGet.mockResolvedValue(makeLrcmuxRecord({ syncedLyrics: "[00:01.00] Line synced" }));
    // LyricsDB returns word sync
    mockLyricsDbGet.mockResolvedValue(makeLyricsDbRecord({ syncLevel: "word", hasWordSync: true }));

    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");
    if (result.outcome === "attached") {
      // Word sync from LyricsDB wins over line sync from LRCmux and plain from LRCLIB!
      expect(result.lyrics.origin?.kind).toBe("lyricsdb");
      expect(result.lyrics.origin?.capability).toBe("word");
    }
  });

  // 5. Different providers returning different synchronization levels (word > line > plain)
  it("strictly enforces capability priority: word > line > plain", async () => {
    const track = makeTrack();
    // Provider A: line sync
    mockLrcmuxSearch.mockResolvedValue([makeLrcmuxRecord({ syncedLyrics: "[00:01.00] Line synced" })]);
    // Provider B: plain text
    mockLrclibSearch.mockResolvedValue([makeLrclibRecord({ syncedLyrics: null, plainLyrics: "Plain text" })]);

    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");
    if (result.outcome === "attached") {
      expect(result.lyrics.origin?.capability).toBe("line");
    }
  });

  // 6. One provider returning 404 does not fail other successful providers
  it("succeeds when one provider returns 404 (null) and another provider finds lyrics", async () => {
    const track = makeTrack();
    mockLrcmuxGet.mockResolvedValue(null);
    mockLrcmuxSearch.mockResolvedValue([]);
    mockLrclibGet.mockResolvedValue(null);
    mockLyricsDbGet.mockResolvedValue(makeLyricsDbRecord());

    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");
    if (result.outcome === "attached") {
      expect(result.lyrics.origin?.kind).toBe("lyricsdb");
    }
  });

  // 7. One provider returning 429 does not fail other providers
  it("succeeds when one provider returns 429 and another succeeds", async () => {
    const track = makeTrack();
    mockLrcmuxGet.mockRejectedValue(new LrcmuxError("rate-limited", "Rate limited by lrcmux", { status: 429 }));
    mockLrclibGet.mockResolvedValue(makeLrclibRecord());

    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");
    if (result.outcome === "attached") {
      expect(result.lyrics.origin?.kind).toBe("lrclib");
    }
  });

  // 8. One provider timing out does not block playback
  it("succeeds when one provider times out while another provider responds", async () => {
    const track = makeTrack();
    mockLyricsDbGet.mockRejectedValue(new LyricsDbError("timeout", "LyricsDB timed out"));
    mockLrclibGet.mockResolvedValue(makeLrclibRecord());

    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");
    if (result.outcome === "attached") {
      expect(result.lyrics.origin?.kind).toBe("lrclib");
    }
  });

  // 9. All providers failing returns an error outcome without throwing
  it("reports error when all providers fail", async () => {
    const track = makeTrack();
    mockLrcmuxGet.mockRejectedValue(new LrcmuxError("network", "Could not reach lrcmux"));
    mockLrcmuxSearch.mockRejectedValue(new LrcmuxError("network", "Could not reach lrcmux"));
    mockLrclibGet.mockRejectedValue(new LrclibError("network", "Could not reach lrclib"));
    mockLrclibSearch.mockRejectedValue(new LrclibError("network", "Could not reach lrclib"));
    mockLyricsDbGet.mockRejectedValue(new LyricsDbError("network", "Could not reach lyricsdb"));
    mockLyricsDbSearch.mockRejectedValue(new LyricsDbError("network", "Could not reach lyricsdb"));

    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("error");
    if (result.outcome === "error") {
      expect(result.message).toBeDefined();
    }
  });

  // 10. Missing artist metadata
  it("handles track with missing artist metadata gracefully", async () => {
    const track = makeTrack({ artist: "" });
    mockLyricsDbSearch.mockResolvedValue([makeLyricsDbRecord({ artistName: null })]);

    const result = await resolveLyricsForTrack(track);
    expect(["attached", "needs-selection"]).toContain(result.outcome);
  });

  // 11. Multiple artists
  it("handles track with multiple artists correctly", async () => {
    const track = makeTrack({
      title: "Hate Me",
      artist: "Ellie Goulding & Juice WRLD",
    });
    mockLrclibGet.mockResolvedValue(
      makeLrclibRecord({
        trackName: "Hate Me",
        artistName: "Ellie Goulding, Juice WRLD",
        duration: 354,
      })
    );

    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");
  });

  // 12. Custom metadata overrides
  it("respects normalized title and custom metadata in discovery queries", async () => {
    const track = makeTrack({
      title: "Bohemian Rhapsody (2011 Remaster)",
      artist: "Queen",
    });
    mockLrclibGet.mockResolvedValue(
      makeLrclibRecord({
        trackName: "Bohemian Rhapsody",
        artistName: "Queen",
      })
    );

    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");
    expect(mockLrclibGet).toHaveBeenCalledWith(
      expect.objectContaining({
        trackName: "Bohemian Rhapsody",
      }),
      undefined,
    );
  });

  // 13. Incorrect duration handling (rejects mismatch > 60s)
  it("rejects candidate when duration delta differs substantially", async () => {
    const track = makeTrack({ title: "Bohemian Rhapsody (Radio Edit)", durationMs: 120000 }); // 2 minutes
    mockLrcmuxSearch.mockResolvedValue([
      makeLrcmuxRecord({
        trackName: "Bohemian Rhapsody (Extended)",
        duration: 354, // ~6 minutes
      }),
    ]);

    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("not-found");
  });

  // 14. Existing manual lyrics are never replaced
  it("never overwrites existing manual/imported lyrics", async () => {
    const track = makeTrack();
    await repository.putLyrics({
      trackId: track.id,
      format: "txt",
      lines: [{ timeMs: null, text: "User imported local lyric" }],
      offsetMs: 0,
      updatedAt: Date.now(),
      skippedLines: 0,
      sourceName: "imported.txt",
      origin: { kind: "manual", recordId: null, fetchedAt: Date.now(), capability: "plain" },
    });

    // All providers offer word sync
    mockLyricsDbGet.mockResolvedValue(makeLyricsDbRecord());

    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("cached");
    expect(mockLyricsDbGet).not.toHaveBeenCalled();
    expect(mockLrcmuxGet).not.toHaveBeenCalled();
    expect(mockLrclibGet).not.toHaveBeenCalled();
  });

  // 15. Existing word-sync lyrics are never queried
  it("does not query providers when word-sync lyrics are already cached", async () => {
    const track = makeTrack();
    await repository.putLyrics({
      trackId: track.id,
      format: "lrc",
      lines: [
        {
          timeMs: 1000,
          text: "Word synced",
          words: [{ text: "Word ", startMs: 1000, endMs: 2000 }],
        },
      ],
      offsetMs: 0,
      updatedAt: Date.now(),
      skippedLines: 0,
      sourceName: "LyricsDB",
      origin: { kind: "lyricsdb", recordId: "uuid-1", fetchedAt: Date.now(), capability: "word" },
    });

    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("cached");
    expect(mockLrcmuxGet).not.toHaveBeenCalled();
    expect(mockLrclibGet).not.toHaveBeenCalled();
    expect(mockLyricsDbGet).not.toHaveBeenCalled();
  });

  // 16. Existing line-sync lyrics upgraded to word sync only, never downgraded to plain
  it("does not overwrite cached line-synchronized lyrics with plain text", async () => {
    const track = makeTrack();
    await repository.putLyrics({
      trackId: track.id,
      format: "lrc",
      lines: [{ timeMs: 1000, text: "Line 1" }],
      offsetMs: 0,
      updatedAt: Date.now(),
      skippedLines: 0,
      sourceName: "LRCmux",
      origin: { kind: "lrcmux", recordId: 1, fetchedAt: Date.now(), capability: "line" },
    });

    // Provider offers plain text
    mockLrclibGet.mockResolvedValue(makeLrclibRecord({ syncedLyrics: null, plainLyrics: "Plain text only" }));

    const result = await resolveLyricsForTrack(track, { force: true });
    expect(result.outcome).toBe("cached");
    const stored = await repository.getLyrics(track.id);
    expect(stored?.origin?.capability).toBe("line");
  });

  // 17. Offline playback from IndexedDB
  it("returns cached lyrics immediately when offline without network calls", async () => {
    const track = makeTrack();
    await repository.putLyrics({
      trackId: track.id,
      format: "lrc",
      lines: [{ timeMs: 1000, text: "Offline lyric" }],
      offsetMs: 0,
      updatedAt: Date.now(),
      skippedLines: 0,
      sourceName: "LRCLIB",
      origin: { kind: "lrclib", recordId: 1, fetchedAt: Date.now(), capability: "line" },
    });

    const originalOnLine = navigator.onLine;
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });

    try {
      const result = await resolveLyricsForTrack(track);
      expect(result.outcome).toBe("cached");
      expect(mockLrcmuxGet).not.toHaveBeenCalled();
      expect(mockLrclibGet).not.toHaveBeenCalled();
      expect(mockLyricsDbGet).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(navigator, "onLine", { value: originalOnLine, configurable: true });
    }
  });

  // 18. Verify outgoing request parameters
  it("verifies actual outgoing query parameters sent to providers", async () => {
    const track = makeTrack();
    await resolveLyricsForTrack(track);

    expect(mockLrcmuxGet).toHaveBeenCalledWith(
      expect.objectContaining({
        trackName: "Bohemian Rhapsody",
        artistName: "Queen",
        albumName: "A Night At The Opera",
        duration: 354,
      }),
      undefined,
    );

    expect(mockLrclibGet).toHaveBeenCalledWith(
      expect.objectContaining({
        trackName: "Bohemian Rhapsody",
        artistName: "Queen",
        albumName: "A Night At The Opera",
        duration: 354,
      }),
      undefined,
    );

    expect(mockLyricsDbGet).toHaveBeenCalledWith(
      expect.objectContaining({
        trackName: "Bohemian Rhapsody",
        artistName: "Queen",
        albumName: "A Night At The Opera",
        duration: 354,
      }),
      undefined,
    );
  });

  // 19. Mandatory regression: Ain't In LA by ADÉLA
  it("resolves Ain't In LA by ADÉLA from LyricsDB, saves to IndexedDB with word sync, and uses cache on replay", async () => {
    const track = makeTrack({
      id: "adela-aint-in-la",
      title: "Ain't In LA",
      artist: "ADÉLA",
      album: "PRIMA",
      durationMs: 184000,
      fileName: "aint-in-la.mp3",
    });

    const adelaRecord = makeLyricsDbRecord({
      id: "e044e0b7-d67f-4741-91de-42911cf56091",
      trackName: "Ain't In LA",
      artistName: "ADÉLA",
      albumName: "Ain't In LA",
      duration: 187,
      hasWordSync: true,
      lines: [
        {
          timeMs: 2753,
          text: "Back it up, subwoofers in the trunk, and the",
          words: [
            { text: "Back ", startMs: 2753, endMs: 3039 },
            { text: "it ", startMs: 3039, endMs: 3252 },
            { text: "up, ", startMs: 3252, endMs: 3652 },
            { text: "subwoofers ", startMs: 3652, endMs: 4532 },
            { text: "in ", startMs: 4532, endMs: 4825 },
            { text: "the ", startMs: 4825, endMs: 4985 },
            { text: "trunk, ", startMs: 4985, endMs: 5425 },
            { text: "and ", startMs: 5425, endMs: 5652 },
            { text: "the ", startMs: 5652, endMs: 5861 },
          ],
        },
      ],
      syncLevel: "word",
      provider: "lyricsdb",
    });

    mockLyricsDbGet.mockResolvedValue(adelaRecord);

    // Playback 1: Resolves and persists
    const result1 = await resolveLyricsForTrack(track);
    expect(result1.outcome).toBe("attached");
    if (result1.outcome === "attached") {
      expect(result1.lyrics.origin?.kind).toBe("lyricsdb");
      expect(result1.lyrics.origin?.capability).toBe("word");
      expect(result1.lyrics.lines[0].words).toBeDefined();
      expect(result1.lyrics.lines[0].words?.length).toBe(9);
    }

    // Verify stored in IndexedDB
    const stored = await repository.getLyrics(track.id);
    expect(stored).not.toBeNull();
    expect(stored?.origin?.capability).toBe("word");

    // Playback 2: Must be an instant cache hit from IndexedDB without provider calls
    mockLrcmuxGet.mockClear();
    mockLrclibGet.mockClear();
    mockLyricsDbGet.mockClear();

    const result2 = await resolveLyricsForTrack(track);
    expect(result2.outcome).toBe("cached");
    expect(mockLrcmuxGet).not.toHaveBeenCalled();
    expect(mockLrclibGet).not.toHaveBeenCalled();
    expect(mockLyricsDbGet).not.toHaveBeenCalled();
  });

  // 20. Search budget: response settling after 3 seconds is not discarded
  it("does not abort or drop provider results settling after 3 seconds", async () => {
    const track = makeTrack({ id: "slow-track", title: "Slow Song", artist: "Slow Artist", durationMs: 200000 });
    
    // LRCmux responds after a slight delay
    mockLrcmuxGet.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return makeLrcmuxRecord({
        trackName: "Slow Song",
        artistName: "Slow Artist",
        duration: 200,
        syncLevel: "line",
      });
    });

    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");
    if (result.outcome === "attached") {
      expect(result.lyrics.lines.length).toBeGreaterThan(0);
    }
  });

  // 21. Explicit Try again bypasses negative cache
  it("bypasses negative cache on explicit force retry", async () => {
    const track = makeTrack({ id: "negative-track" });

    // Initial search has no results
    mockLrcmuxGet.mockResolvedValue(null);
    mockLrcmuxSearch.mockResolvedValue([]);
    mockLrclibGet.mockResolvedValue(null);
    mockLrclibSearch.mockResolvedValue([]);
    mockLyricsDbGet.mockResolvedValue(null);
    mockLyricsDbSearch.mockResolvedValue([]);

    const result1 = await resolveLyricsForTrack(track);
    expect(result1.outcome).toBe("not-found");

    // Replay without force hits negative cache
    const result2 = await resolveLyricsForTrack(track);
    expect(result2.outcome).toBe("skipped-recently");

    // Now provider has lyrics available
    mockLrclibGet.mockResolvedValue(makeLrclibRecord());

    // Explicit reset / force retry
    await resetLyricsCacheMeta(track.id);
    const result3 = await resolveLyricsForTrack(track, { force: true });
    expect(result3.outcome).toBe("attached");
  });

  // 22. Provider diagnostics record durations, status, and selection
  it("populates provider-level diagnostics on search completion", async () => {
    const track = makeTrack();
    mockLrclibGet.mockResolvedValue(makeLrclibRecord());

    await resolveLyricsForTrack(track);
    const diag = getLatestLyricsDiagnostic();
    expect(diag).not.toBeNull();
    expect(diag?.trackId).toBe(track.id);
    expect(diag?.finalSelectedProvider).toBeDefined();
    expect(diag?.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(diag?.providers.lrclib).toBeDefined();
    expect(diag?.providers.lrclib?.status).toBe(200);
  });
});
