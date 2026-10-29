import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../../types";
import { repository } from "../indexeddb/LibraryRepository";
import { attachLrclibRecord, buildLyricsFromRecord, resolveLyricsForTrack } from "./lyricsService";
import type { LrcmuxRecord } from "./lrcmuxClient";

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
