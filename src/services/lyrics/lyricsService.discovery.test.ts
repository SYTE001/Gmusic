import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track, TrackLyrics } from "../../types";
import { repository } from "../indexeddb/LibraryRepository";
import { attachLrclibRecord, buildLyricsFromRecord, resolveLyricsForTrack } from "./lyricsService";
import { mapJsonResponseToRecord, type LrcmuxRecord } from "./lrcmuxClient";

vi.mock("./lrcmuxClient", async (importOriginal) => {
  const original = await importOriginal<typeof import("./lrcmuxClient")>();
  return {
    ...original,
    lrcmuxGet: vi.fn(),
    lrcmuxSearch: vi.fn(),
  };
});

// Typed access to the mocks declared by vi.mock above.
const { lrcmuxGet, lrcmuxSearch } = await import("./lrcmuxClient");
const getMock = vi.mocked(lrcmuxGet);
const searchMock = vi.mocked(lrcmuxSearch);

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: "t1",
    title: "Gentle Rise",
    artist: "Aurora Fields",
    album: "Northern Lights",
    trackNumber: null,
    albumTrackCount: null,
    durationMs: 212000,
    fileName: "a.wav",
    fileSize: 1,
    mimeType: "audio/wav",
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

function makeRecord(overrides: Partial<LrcmuxRecord> = {}): LrcmuxRecord {
  return {
    id: 42,
    trackName: "Gentle Rise",
    artistName: "Aurora Fields",
    albumName: "Northern Lights",
    duration: 212,
    instrumental: false,
    hasWordSync: false,
    plainLyrics: "plain text line",
    syncedLyrics: "[00:01.00]First\n[00:02.00]Second",
    lyricsfile: null,
    ...overrides,
  };
}

describe("resolveLyricsForTrack (discovery pipeline)", () => {
  beforeEach(async () => {
    await repository.clearAllData();
    getMock.mockReset();
    searchMock.mockReset();
  });

  it("returns cached lyrics without any network request", async () => {
    const track = makeTrack();
    await repository.putLyrics({
      trackId: track.id,
      format: "txt",
      lines: [{ timeMs: null, text: "manual" }],
      offsetMs: 250,
      updatedAt: 1,
      skippedLines: 0,
      sourceName: "manual.txt",
      origin: { kind: "manual", recordId: null, fetchedAt: 1, capability: "plain" },
    });
    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("cached");
    expect(getMock).not.toHaveBeenCalled();
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("auto-accepts a validated exact /api/get match and persists it", async () => {
    const track = makeTrack();
    getMock.mockResolvedValue(makeRecord());
    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");
    expect(getMock).toHaveBeenCalledWith(
      expect.objectContaining({ trackName: "Gentle Rise", artistName: "Aurora Fields", albumName: "Northern Lights", duration: 212 }),
      undefined,
    );
    const stored = await repository.getLyrics(track.id);
    expect(stored?.format).toBe("lrc");
    expect(stored?.origin?.kind).toBe("lrcmux");
    expect(stored?.origin?.recordId).toBe(42);
    expect(stored?.origin?.capability).toBe("line");
    const meta = await repository.getLyricsCacheMeta(track.id);
    expect(meta?.status).toBe("accepted");
  });

  it("falls back to /api/search when the exact lookup 404s, and accepts the best candidate", async () => {
    const track = makeTrack();
    getMock.mockResolvedValue(null);
    searchMock.mockResolvedValue([makeRecord({ id: 7 })]);
    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect((await repository.getLyrics(track.id))?.origin?.recordId).toBe(7);
  });

  it("rejects a mismatched /api/get result instead of trusting the endpoint", async () => {
    const track = makeTrack();
    // The API's duration matching is loose; it may hand back another recording.
    getMock.mockResolvedValue(makeRecord({ trackName: "Violent Rise", artistName: "Someone Else" }));
    searchMock.mockResolvedValue([]);
    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("not-found");
  });

  it("asks the user to choose when candidates are plausible but not certain", async () => {
    const track = makeTrack();
    getMock.mockResolvedValue(null);
    searchMock.mockResolvedValue([makeRecord({ artistName: "Cover Band", albumName: "Covers" })]);
    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("needs-selection");
    if (result.outcome === "needs-selection") {
      expect(result.candidates.length).toBeGreaterThan(0);
    }
    expect((await repository.getLyricsCacheMeta(track.id))?.status).toBe("needs-selection");
  });

  it("records not-found in the negative cache and skips re-querying within the TTL", async () => {
    const track = makeTrack();
    getMock.mockResolvedValue(null);
    searchMock.mockResolvedValue([]);
    await resolveLyricsForTrack(track);
    expect(getMock).toHaveBeenCalledTimes(1);

    const second = await resolveLyricsForTrack(track);
    expect(second.outcome).toBe("skipped-recently");
    expect(getMock).toHaveBeenCalledTimes(1); // no second network round-trip
  });

  it("retries not-found tracks after the TTL expires", async () => {
    const track = makeTrack();
    getMock.mockResolvedValue(null);
    searchMock.mockResolvedValue([]);
    await resolveLyricsForTrack(track);
    await repository.putLyricsCacheMeta({ trackId: track.id, status: "not-found", checkedAt: Date.now() - 8 * 24 * 3600 * 1000, recordId: null, schemaVersion: 2 });
    getMock.mockResolvedValue(makeRecord());
    const retried = await resolveLyricsForTrack(track);
    expect(retried.outcome).toBe("attached");
  });

  it("does not query the network while offline", async () => {
    const onlineGetter = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const result = await resolveLyricsForTrack(makeTrack());
    expect(result.outcome).toBe("offline");
    expect(getMock).not.toHaveBeenCalled();
    onlineGetter.mockRestore();
  });

  it("maps API failures to an error outcome without throwing", async () => {
    getMock.mockRejectedValue(Object.assign(new Error("rate limited"), { name: "LrcmuxError", kind: "rate-limited" }));
    searchMock.mockRejectedValue(Object.assign(new Error("rate limited"), { name: "LrcmuxError", kind: "rate-limited" }));
    const result = await resolveLyricsForTrack(makeTrack());
    expect(result.outcome).toBe("error");
  });

  it("force re-queries even when lyrics are cached", async () => {
    const track = makeTrack();
    await repository.putLyrics({
      trackId: track.id,
      format: "txt",
      lines: [{ timeMs: null, text: "manual" }],
      offsetMs: 0,
      updatedAt: 1,
      skippedLines: 0,
      sourceName: "m.txt",
    });
    getMock.mockResolvedValue(makeRecord());
    const result = await resolveLyricsForTrack(track, { force: true });
    expect(result.outcome).toBe("attached");
    expect((await repository.getLyrics(track.id))?.origin?.kind).toBe("lrcmux");
  });
});

describe("buildLyricsFromRecord capabilities", () => {
  it("uses lyricsfile word timing when hasWordSync is true", () => {
    const record = makeRecord({
      hasWordSync: true,
      lyricsfile: `lines:\n- text: hi there\n  start_ms: 1000\n  words:\n  - text: hi\n    start_ms: 1000\n    end_ms: 1500\n  - text: there\n    start_ms: 1500\n    end_ms: 2000\n`,
    });
    const lyrics = buildLyricsFromRecord("t1", record, 0);
    expect(lyrics.origin?.capability).toBe("word");
    expect(lyrics.lines[0].words).toHaveLength(2);
  });

  it("falls back to line-level when lyricsfile lacks word timing", () => {
    const record = makeRecord({ hasWordSync: true, lyricsfile: `lines:\n- text: hi\n  start_ms: 1000\n` });
    const lyrics = buildLyricsFromRecord("t1", record, 0);
    expect(lyrics.origin?.capability).toBe("line");
  });

  it("detects enhanced-LRC word tags inside syncedLyrics", () => {
    const record = makeRecord({ syncedLyrics: "[00:10.00]<00:10.00>Yeah <00:11.50>oh" });
    const lyrics = buildLyricsFromRecord("t1", record, 0);
    expect(lyrics.origin?.capability).toBe("word");
  });

  it("stores plain lyrics as unsynchronized text", () => {
    const record = makeRecord({ syncedLyrics: null });
    const lyrics = buildLyricsFromRecord("t1", record, 0);
    expect(lyrics.format).toBe("txt");
    expect(lyrics.origin?.capability).toBe("plain");
    expect(lyrics.lines.every((line) => line.timeMs === null)).toBe(true);
  });

  it("marks instrumental records explicitly", () => {
    const lyrics = buildLyricsFromRecord("t1", makeRecord({ instrumental: true, syncedLyrics: null, plainLyrics: null }), 0);
    expect(lyrics.origin?.capability).toBe("instrumental");
    expect(lyrics.lines).toHaveLength(0);
  });

  it("preserves word timestamps through the lrcmux JSON mapping, in milliseconds", () => {
    const record = mapJsonResponseToRecord({
      track: { title: "Gentle Rise", artist: "Aurora Fields", album: "Northern Lights", duration: 212 },
      meta: { level: "word" },
      lines: [
        {
          text: "Word up",
          start: 1000,
          end: 2000,
          words: [
            { text: "Word", start: 1000, end: 1500 },
            { text: "up", start: 1500, end: 2000 },
          ],
        },
      ],
    });
    expect(record.hasWordSync).toBe(true);
    expect(record.lines?.[0].words).toEqual([
      { text: "Word", startMs: 1000, endMs: 1500 },
      { text: "up", startMs: 1500, endMs: 2000 },
    ]);
    const lyrics = buildLyricsFromRecord("t1", record, 0);
    expect(lyrics.origin?.capability).toBe("word");
    expect(lyrics.lines[0].words).toHaveLength(2);
    // Line and word timing share the same millisecond basis.
    expect(lyrics.lines[0].timeMs).toBe(1000);
    expect(lyrics.lines[0].words?.[1].startMs).toBe(1500);
  });

  it("preserves the user's offset when replacing a record", async () => {
    const track = makeTrack();
    await repository.putLyrics({
      trackId: track.id,
      format: "lrc",
      lines: [{ timeMs: 0, text: "old" }],
      offsetMs: -1500,
      updatedAt: 1,
      skippedLines: 0,
      sourceName: "x.lrc",
    });
    const attached = await attachLrclibRecord(track, makeRecord());
    expect(attached.offsetMs).toBe(-1500);
  });
});

// ---------------------------------------------------------------------------
// Quality-aware resolution (task §2–§6): capability-validated attachment and
// cache upgrades. Records use real payloads — provider flags never count as
// proof.
// ---------------------------------------------------------------------------

const WORD_SYNCED = "[00:01.00]<00:01.00>Word <00:01.60>up";

function wordRecord(overrides: Partial<LrcmuxRecord> = {}): LrcmuxRecord {
  return makeRecord({ hasWordSync: true, syncedLyrics: WORD_SYNCED, ...overrides });
}
function lineRecord(overrides: Partial<LrcmuxRecord> = {}): LrcmuxRecord {
  return makeRecord({ ...overrides });
}
function plainRecord(overrides: Partial<LrcmuxRecord> = {}): LrcmuxRecord {
  return makeRecord({ syncedLyrics: null, ...overrides });
}
function emptyRecord(overrides: Partial<LrcmuxRecord> = {}): LrcmuxRecord {
  return makeRecord({ syncedLyrics: null, plainLyrics: null, ...overrides });
}

describe("quality-aware exact lookup validation", () => {
  beforeEach(async () => {
    await repository.clearAllData();
    getMock.mockReset();
    searchMock.mockReset();
  });

  it("accepts an exact word-sync match without touching search", async () => {
    const track = makeTrack();
    getMock.mockResolvedValue(wordRecord());
    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");
    expect(searchMock).not.toHaveBeenCalled();
    expect((await repository.getLyrics(track.id))?.origin?.capability).toBe("word");
  });

  it("accepts an exact line-sync match directly (the /get lookup already requested word level)", async () => {
    const track = makeTrack();
    getMock.mockResolvedValue(lineRecord());
    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");
    expect((await repository.getLyrics(track.id))?.origin?.capability).toBe("line");
  });

  it("keeps searching when the exact lookup is plain text, then attaches a synchronized result", async () => {
    const track = makeTrack();
    getMock.mockResolvedValue(plainRecord());
    searchMock.mockResolvedValue([lineRecord({ id: 9 })]);
    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");
    expect((await repository.getLyrics(track.id))?.origin?.capability).toBe("line");
    expect((await repository.getLyrics(track.id))?.origin?.recordId).toBe(9);
  });

  it("attaches the validated exact plain text when search finds nothing synchronized", async () => {
    const track = makeTrack();
    getMock.mockResolvedValue(plainRecord());
    searchMock.mockResolvedValue([]);
    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");
    expect((await repository.getLyrics(track.id))?.origin?.capability).toBe("plain");
  });

  it("attaches the validated exact plain text even when the search request fails", async () => {
    const track = makeTrack();
    getMock.mockResolvedValue(plainRecord());
    searchMock.mockRejectedValue(new Error("network down"));
    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");
    expect((await repository.getLyrics(track.id))?.origin?.capability).toBe("plain");
  });

  it("never attaches a payload-less record (empty lyrics are not lyrics)", async () => {
    const track = makeTrack();
    getMock.mockResolvedValue(emptyRecord());
    searchMock.mockResolvedValue([]);
    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("not-found");
    expect(await repository.getLyrics(track.id)).toBeUndefined();
  });

  it("prefers a valid word-sync candidate over a plain one from search", async () => {
    const track = makeTrack();
    getMock.mockResolvedValue(null);
    searchMock.mockResolvedValue([plainRecord({ id: 1 }), wordRecord({ id: 2 })]);
    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");
    expect((await repository.getLyrics(track.id))?.origin?.capability).toBe("word");
    expect((await repository.getLyrics(track.id))?.origin?.recordId).toBe(2);
  });

  it("prefers the correct track over a wrong-artist word-sync record", async () => {
    const track = makeTrack();
    getMock.mockResolvedValue(null);
    searchMock.mockResolvedValue([
      wordRecord({ id: 3, artistName: "Cover Band" }), // synchronized but wrong recording
      plainRecord({ id: 4 }), // correct artist, plain
    ]);
    const result = await resolveLyricsForTrack(track);
    // The wrong-artist record must not be attached; the correct plain-text
    // match surfaces first in the chooser instead.
    expect(result.outcome).toBe("needs-selection");
    if (result.outcome === "needs-selection") {
      expect(result.candidates[0].record.id).toBe(4);
      expect(result.candidates[0].autoAcceptable).toBe(true);
    }
    expect(await repository.getLyrics(track.id)).toBeUndefined();
  });
});

describe("quality-aware cache upgrades", () => {
  const lrcmuxOrigin = (capability: "line" | "plain" | "word") => ({
    kind: "lrcmux" as const,
    recordId: 1,
    fetchedAt: 1,
    capability,
  });

  async function seedCached(
    track: Track,
    lines: { timeMs: number | null; text: string; words?: unknown }[],
    opts: { capability: "line" | "plain"; offsetMs?: number; manual?: boolean; legacy?: boolean } = { capability: "plain" },
  ): Promise<void> {
    await repository.putLyrics({
      trackId: track.id,
      format: opts.capability === "plain" ? "txt" : "lrc",
      lines: lines as TrackLyrics["lines"],
      offsetMs: opts.offsetMs ?? 0,
      updatedAt: 1,
      skippedLines: 0,
      sourceName: "cache",
      ...(opts.legacy ? {} : { origin: opts.manual ? { kind: "manual" as const, recordId: null, fetchedAt: 1, capability: opts.capability } : lrcmuxOrigin(opts.capability) }),
    });
  }

  beforeEach(async () => {
    await repository.clearAllData();
    getMock.mockReset();
    searchMock.mockReset();
  });

  it("upgrades cached plain text to word sync from the exact lookup, preserving the offset", async () => {
    const track = makeTrack();
    await seedCached(track, [{ timeMs: null, text: "plain" }], { capability: "plain", offsetMs: -1200 });
    getMock.mockResolvedValue(wordRecord());
    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");
    const stored = await repository.getLyrics(track.id);
    expect(stored?.origin?.capability).toBe("word");
    expect(stored?.offsetMs).toBe(-1200);
  });

  it("upgrades cached plain text to line sync via search", async () => {
    const track = makeTrack();
    await seedCached(track, [{ timeMs: null, text: "plain" }], { capability: "plain" });
    getMock.mockResolvedValue(plainRecord());
    searchMock.mockResolvedValue([lineRecord({ id: 8 })]);
    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");
    expect((await repository.getLyrics(track.id))?.origin?.capability).toBe("line");
  });

  it("upgrades cached line sync to word sync via search", async () => {
    const track = makeTrack();
    await seedCached(track, [
      { timeMs: 1000, text: "First" },
      { timeMs: 2000, text: "Second" },
    ], { capability: "line" });
    getMock.mockResolvedValue(null);
    searchMock.mockResolvedValue([wordRecord({ id: 11 })]);
    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");
    expect((await repository.getLyrics(track.id))?.origin?.capability).toBe("word");
  });

  it("keeps cached word sync and never queries the API for it", async () => {
    const track = makeTrack();
    await repository.putLyrics({
      trackId: track.id,
      format: "lrc",
      lines: [{ timeMs: 1000, text: "Word up", words: [{ text: "Word", startMs: 1000, endMs: 1600 }, { text: "up", startMs: 1600, endMs: null }] }],
      offsetMs: 0,
      updatedAt: 1,
      skippedLines: 0,
      sourceName: "cache",
      origin: lrcmuxOrigin("word"),
    });
    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("cached");
    expect(getMock).not.toHaveBeenCalled();
    expect(searchMock).not.toHaveBeenCalled();
    expect((await repository.getLyrics(track.id))?.origin?.capability).toBe("word");
  });

  it("keeps cached line sync when the API only offers plain text", async () => {
    const track = makeTrack();
    await seedCached(track, [
      { timeMs: 1000, text: "First" },
      { timeMs: 2000, text: "Second" },
    ], { capability: "line" });
    getMock.mockResolvedValue(plainRecord());
    searchMock.mockResolvedValue([plainRecord({ id: 5 })]);
    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("cached");
    expect((await repository.getLyrics(track.id))?.origin?.capability).toBe("line");
    expect((await repository.getLyrics(track.id))?.origin?.recordId).toBe(1); // untouched
  });

  it("keeps manual lyrics when the API offers word sync, without querying", async () => {
    const track = makeTrack();
    await seedCached(track, [{ timeMs: null, text: "my own import" }], { capability: "plain", manual: true });
    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("cached");
    expect(getMock).not.toHaveBeenCalled();
    expect((await repository.getLyrics(track.id))?.lines[0]?.text).toBe("my own import");
  });

  it("upgrades a legacy cache record whose origin.capability is missing", async () => {
    const track = makeTrack();
    await seedCached(track, [{ timeMs: null, text: "legacy plain" }], { capability: "plain", legacy: true });
    getMock.mockResolvedValue(wordRecord());
    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");
    expect((await repository.getLyrics(track.id))?.origin?.capability).toBe("word");
  });

  it("treats a legacy word-sync cache as final and skips the network", async () => {
    const track = makeTrack();
    await repository.putLyrics({
      trackId: track.id,
      format: "lrc",
      lines: [{ timeMs: 1000, text: "Word up", words: [{ text: "Word", startMs: 1000, endMs: 1600 }] }],
      offsetMs: 0,
      updatedAt: 1,
      skippedLines: 0,
      sourceName: "legacy.lrc",
    });
    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("cached");
    expect(getMock).not.toHaveBeenCalled();
  });

  it("keeps the cache when the API returns empty or malformed payloads during an upgrade", async () => {
    const track = makeTrack();
    await seedCached(track, [{ timeMs: null, text: "plain" }], { capability: "plain" });
    getMock.mockResolvedValue(emptyRecord());
    searchMock.mockResolvedValue([emptyRecord({ id: 6 })]);
    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("cached");
    const stored = await repository.getLyrics(track.id);
    expect(stored?.lines[0]?.text).toBe("plain");
    expect(stored?.origin?.capability).toBe("plain");
  });

  it("keeps the cache when the API request fails during an upgrade", async () => {
    const track = makeTrack();
    await seedCached(track, [{ timeMs: null, text: "plain" }], { capability: "plain" });
    getMock.mockRejectedValue(Object.assign(new Error("down"), { name: "LrcmuxError", kind: "network" }));
    searchMock.mockRejectedValue(Object.assign(new Error("down"), { name: "LrcmuxError", kind: "network" }));
    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("cached");
    expect((await repository.getLyrics(track.id))?.lines[0]?.text).toBe("plain");
  });

  it("backs off after an unsuccessful upgrade instead of re-querying on every replay", async () => {
    const track = makeTrack();
    await seedCached(track, [{ timeMs: null, text: "plain" }], { capability: "plain" });
    getMock.mockResolvedValue(plainRecord());
    searchMock.mockResolvedValue([plainRecord({ id: 5 })]);
    const first = await resolveLyricsForTrack(track);
    expect(first.outcome).toBe("cached");
    expect(getMock).toHaveBeenCalledTimes(1);

    const second = await resolveLyricsForTrack(track);
    expect(second.outcome).toBe("cached");
    expect(getMock).toHaveBeenCalledTimes(1); // backoff held — no second round-trip
  });

  it("keeps higher-quality lyrics when a force refresh only finds lower quality", async () => {
    const track = makeTrack();
    await seedCached(track, [
      { timeMs: 1000, text: "First" },
      { timeMs: 2000, text: "Second" },
    ], { capability: "line" });
    getMock.mockResolvedValue(plainRecord());
    searchMock.mockResolvedValue([plainRecord({ id: 5 })]);
    const result = await resolveLyricsForTrack(track, { force: true });
    expect(result.outcome).toBe("cached");
    expect((await repository.getLyrics(track.id))?.origin?.capability).toBe("line");
  });

  it("replaces equal-quality lyrics on an explicit force refresh", async () => {
    const track = makeTrack();
    await seedCached(track, [{ timeMs: null, text: "old plain" }], { capability: "plain" });
    getMock.mockResolvedValue(plainRecord({ plainLyrics: "fresh plain" }));
    searchMock.mockResolvedValue([]);
    const result = await resolveLyricsForTrack(track, { force: true });
    expect(result.outcome).toBe("attached");
    expect((await repository.getLyrics(track.id))?.lines[0]?.text).toBe("fresh plain");
  });

  it("normalizes noisy track title on Stage A exact lookup", async () => {
    const track = makeTrack({
      title: "Gentle Rise (Dance Performance Video)",
      artist: "Aurora Fields",
    });
    getMock.mockResolvedValue(makeRecord());
    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");
    expect(getMock).toHaveBeenCalledWith(
      expect.objectContaining({ trackName: "Gentle Rise", artistName: "Aurora Fields" }),
      undefined,
    );
  });

  it("finds lyrics in Stage C alternative queries when artist and title are flipped", async () => {
    const track = makeTrack({
      title: "Gentle Rise",
      artist: "Aurora Fields",
    });
    getMock.mockResolvedValue(null);
    // Stage B search with standard ordering returns nothing
    searchMock.mockImplementation(async (query) => {
      if (query.trackName === "Gentle Rise" && query.artistName === "Aurora Fields") {
        return [];
      }
      if (query.trackName === "Aurora Fields" && query.artistName === "Gentle Rise") {
        return [makeRecord({ id: 99 })];
      }
      return [];
    });

    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");
    expect((await repository.getLyrics(track.id))?.origin?.recordId).toBe(99);
  });
});
