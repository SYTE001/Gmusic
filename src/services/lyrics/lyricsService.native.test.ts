import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track, TrackLyrics } from "../../types";
import { repository } from "../indexeddb/LibraryRepository";
import { discoverDesktopLyrics, parseDesktopLyrics } from "../platform/lyrics";
import { isTauriRuntime } from "../platform/desktop";
import { parseLyricFileForPlatform, resolveLyricsForTrack } from "./lyricsService";
import { rankCandidates } from "./matching";
import { lrcmuxGet } from "./lrcmuxClient";

vi.mock("../platform/desktop", () => ({ isTauriRuntime: vi.fn(() => true) }));
vi.mock("../platform/lyrics", () => ({ discoverDesktopLyrics: vi.fn(), parseDesktopLyrics: vi.fn() }));
vi.mock("./lrcmuxClient", async (original) => ({ ...await original<typeof import("./lrcmuxClient")>(), lrcmuxGet: vi.fn(), lrcmuxSearch: vi.fn().mockResolvedValue([]) }));
vi.mock("./lrclibClient", async (original) => ({ ...await original<typeof import("./lrclibClient")>(), lrclibGet: vi.fn().mockResolvedValue(null), lrclibSearch: vi.fn().mockResolvedValue([]) }));
vi.mock("./lyricsdbClient", async (original) => ({ ...await original<typeof import("./lyricsdbClient")>(), lyricsDbGet: vi.fn().mockResolvedValue(null), lyricsDbSearch: vi.fn().mockResolvedValue([]) }));

const track: Track = {
  id: "native-track", title: "Gentle Rise", artist: "Aurora Fields", album: "Northern Lights", durationMs: 212000,
  trackNumber: null, albumTrackCount: null, fileName: "song.flac", fileSize: 1, mimeType: "audio/flac", addedAt: 1,
  lastPlayedAt: null, playCount: 0, isLiked: false, availability: "available", accessMode: "stored-copy", fingerprint: null, metadataFromFilename: false,
};
const record = { id: 42, provider: "lrclib" as const, trackName: track.title, artistName: track.artist, albumName: track.album, duration: 212, instrumental: false,
  hasWordSync: false, plainLyrics: null, syncedLyrics: "[00:01]First\n[00:02]Second", lyricsfile: null, lines: [{ timeMs: 1000, text: "First" }, { timeMs: 2000, text: "Second" }] };
const candidate = rankCandidates(track, [record])[0];
const native = () => ({ candidates: [candidate], errors: [], fromCache: false, offline: false, cacheWarning: null });
const manual = (offsetMs = 250): TrackLyrics => ({ trackId: track.id, format: "txt", lines: [{ timeMs: null, text: "My lyrics" }], offsetMs, updatedAt: 1, skippedLines: 0, sourceName: "manual.txt", origin: { kind: "manual", recordId: null, fetchedAt: 1, capability: "plain" } });

beforeEach(async () => {
  await repository.clearAllData();
  vi.mocked(isTauriRuntime).mockReturnValue(true);
  vi.mocked(discoverDesktopLyrics).mockReset().mockResolvedValue(native());
  vi.mocked(parseDesktopLyrics).mockReset().mockResolvedValue(null);
  vi.mocked(lrcmuxGet).mockReset().mockResolvedValue(null);
});
afterEach(() => vi.restoreAllMocks());

describe("native lyrics integration", () => {
  it("attaches a validated native record without querying browser providers", async () => {
    expect((await resolveLyricsForTrack(track)).outcome).toBe("attached");
    expect((await repository.getLyrics(track.id))?.lines).toEqual(record.lines);
    expect(lrcmuxGet).not.toHaveBeenCalled();
    expect((await repository.getLyricsCacheMeta(track.id))?.discoveryIdentity).toBeTruthy();
  });

  it("never replaces a manual document automatically or queries native providers", async () => {
    await repository.putLyrics(manual());
    expect(await resolveLyricsForTrack(track)).toEqual({ outcome: "cached", lyrics: manual() });
    expect(discoverDesktopLyrics).not.toHaveBeenCalled();
  });

  it("preserves the latest user offset when a refresh attaches", async () => {
    await repository.putLyrics({ ...manual(), origin: { kind: "lrclib", recordId: 42, fetchedAt: 1, capability: "plain" } });
    vi.mocked(discoverDesktopLyrics).mockImplementation(async () => {
      await repository.putLyrics({ ...manual(750), origin: { kind: "lrclib", recordId: 42, fetchedAt: 1, capability: "plain" } });
      return native();
    });
    expect((await resolveLyricsForTrack(track, { force: true })).outcome).toBe("attached");
    expect((await repository.getLyrics(track.id))?.offsetMs).toBe(750);
  });

  it("preserves manual import made during a pending lookup", async () => {
    vi.mocked(discoverDesktopLyrics).mockImplementation(async () => { await repository.putLyrics(manual()); return native(); });
    expect((await resolveLyricsForTrack(track)).outcome).toBe("cached");
    expect((await repository.getLyrics(track.id))?.origin?.kind).toBe("manual");
  });

  it("revalidates native candidates and returns zero choices for unrelated cross-field results", async () => {
    const localTrack = { ...track, id: "adela-aint-in-la", title: "Ain't In LA", artist: "ADÉLA", album: "PRIMA", durationMs: 184000 };
    const unrelatedRows: Array<{ artistName: string; duration: number; provider: "lrcmux" | "lrclib" | "lyricsdb" }> = [
      { artistName: "Babasha", duration: 192, provider: "lrcmux" },
      { artistName: "Smile / Happy Accidents", duration: 243, provider: "lrclib" },
      { artistName: "Francesco de Galdeano", duration: 146, provider: "lyricsdb" },
    ];
    const unrelated = unrelatedRows.map(({ artistName, duration, provider }, index) => ({
      ...candidate,
      autoAcceptable: false,
      record: { ...record, id: index + 1, provider, trackName: "Adela", artistName, duration },
    }));
    vi.mocked(discoverDesktopLyrics).mockResolvedValue({ ...native(), candidates: unrelated });

    expect((await resolveLyricsForTrack(localTrack)).outcome).toBe("not-found");
    expect(await repository.getLyrics(localTrack.id)).toBeUndefined();
  });

  it("shows ambiguity in the existing chooser instead of auto-attaching", async () => {
    vi.mocked(discoverDesktopLyrics).mockResolvedValue({ ...native(), candidates: [{ ...candidate, autoAcceptable: false }] });
    expect((await resolveLyricsForTrack(track)).outcome).toBe("needs-selection");
    expect(await repository.getLyrics(track.id)).toBeUndefined();
  });

  it("does not negative-cache provider failure", async () => {
    vi.mocked(discoverDesktopLyrics).mockResolvedValue({ ...native(), candidates: [], errors: ["lrclib: timed out"] });
    expect((await resolveLyricsForTrack(track)).outcome).toBe("error");
    expect(await repository.getLyricsCacheMeta(track.id)).toBeUndefined();
  });

  it("negative cache skips repeats but metadata edits invalidate it", async () => {
    vi.mocked(discoverDesktopLyrics).mockResolvedValue({ ...native(), candidates: [] });
    expect((await resolveLyricsForTrack(track)).outcome).toBe("not-found");
    expect((await resolveLyricsForTrack(track)).outcome).toBe("skipped-recently");
    await resolveLyricsForTrack({ ...track, title: "Corrected Song" });
    expect(discoverDesktopLyrics).toHaveBeenCalledTimes(2);
  });

  it("offline can recover positive disk cache and does not record a miss", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    vi.mocked(discoverDesktopLyrics).mockResolvedValue({ ...native(), fromCache: true, offline: true });
    expect((await resolveLyricsForTrack(track)).outcome).toBe("attached");
    expect((await repository.getLyrics(track.id))?.format).toBe("lrc");
    await repository.clearAllData();
    vi.mocked(discoverDesktopLyrics).mockResolvedValue({ ...native(), candidates: [], offline: true });
    expect((await resolveLyricsForTrack(track)).outcome).toBe("offline");
    expect(await repository.getLyricsCacheMeta(track.id)).toBeUndefined();
  });

  it("abort cannot attach a late native result", async () => {
    const controller = new AbortController();
    vi.mocked(discoverDesktopLyrics).mockImplementation(async () => { controller.abort(); return native(); });
    await expect(resolveLyricsForTrack(track, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(await repository.getLyrics(track.id)).toBeUndefined();
  });

  it("a new caller for the same track does not inherit a cancelled signal", async () => {
    const controller = new AbortController();
    let finish: (value: ReturnType<typeof native>) => void = () => {};
    vi.mocked(discoverDesktopLyrics).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = resolveLyricsForTrack(track, { signal: controller.signal });
    await vi.waitFor(() => expect(discoverDesktopLyrics).toHaveBeenCalledOnce());
    controller.abort();
    const second = await resolveLyricsForTrack(track);
    expect(second.outcome).toBe("attached");
    finish(native());
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(discoverDesktopLyrics).toHaveBeenCalledTimes(2);
  });

  it("falls back to existing web discovery when IPC is unavailable", async () => {
    vi.mocked(discoverDesktopLyrics).mockResolvedValue(null);
    vi.mocked(lrcmuxGet).mockResolvedValue(record);
    expect((await resolveLyricsForTrack(track)).outcome).toBe("attached");
    expect(lrcmuxGet).toHaveBeenCalledOnce();
  });

  it("platform import retains the Rust timestamp payload and web fallback", async () => {
    vi.mocked(parseDesktopLyrics).mockResolvedValue({ lines: record.lines, format: "lrc", skippedLines: 2 });
    expect((await parseLyricFileForPlatform(track.id, "file.lrc", "source")).lyrics.lines).toEqual(record.lines);
    vi.mocked(parseDesktopLyrics).mockResolvedValue(null);
    expect((await parseLyricFileForPlatform(track.id, "file.lrc", "[00:01]Hi")).lyrics.lines[0].timeMs).toBe(1000);
  });
});
