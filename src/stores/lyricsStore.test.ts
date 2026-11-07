import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindLyricsTrackLookup, useLyricsStore } from "./lyricsStore";
import type { Track } from "../types";
import type { RankedCandidate } from "../services/lyrics/matching";
import type { LrclibRecord } from "../services/lyrics/lrclibClient";

vi.mock("../services/lyrics/lyricsService", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/lyrics/lyricsService")>();
  return {
    ...original,
    resolveLyricsForTrack: vi.fn(),
    resetLyricsCacheMeta: vi.fn(async () => undefined),
    attachLrclibRecord: vi.fn(),
  };
});

const { resolveLyricsForTrack, attachLrclibRecord } = await import("../services/lyrics/lyricsService");
const resolveMock = vi.mocked(resolveLyricsForTrack);
const attachMock = vi.mocked(attachLrclibRecord);

function makeTrack(id: string): Track {
  return {
    id,
    title: `Song ${id}`,
    artist: "Artist",
    album: "",
    trackNumber: null,
    albumTrackCount: null,
    durationMs: 100000,
    fileName: `${id}.wav`,
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
  };
}

function candidate(id: number): RankedCandidate {
  return {
    record: { id, trackName: "x", artistName: "y", albumName: null, duration: 100, instrumental: false, hasWordSync: false, plainLyrics: "p", syncedLyrics: "[00:01.00]x", lyricsfile: null } as LrclibRecord,
    quality: { score: 60, titleSimilarity: 0.9, artistSimilarity: 0.5, albumSimilarity: null, durationDeltaSeconds: 0, versionMismatch: false, rejected: false },
    capability: "line",
    hasSynced: true,
    hasPlain: true,
    autoAcceptable: false,
  };
}

describe("lyricsStore race protection", () => {
  beforeEach(() => {
    resolveMock.mockReset();
    attachMock.mockReset();
    bindLyricsTrackLookup((id) => makeTrack(id));
    useLyricsStore.setState({ trackId: null, status: "idle", candidates: [], errorMessage: null, fromCache: false, lyricsVersion: 0 });
  });

  it("ignores results belonging to a superseded track (rapid track changes)", async () => {
    let releaseFirst: (value: { outcome: "not-found" }) => void = () => undefined;
    resolveMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = resolve;
        }),
    );
    resolveMock.mockResolvedValue({ outcome: "cached", lyrics: { trackId: "b", format: "txt", lines: [], offsetMs: 0, updatedAt: 0, skippedLines: 0, sourceName: "" } });

    const first = useLyricsStore.getState().resolveForTrack(makeTrack("a"));
    const second = useLyricsStore.getState().resolveForTrack(makeTrack("b"));
    await second;
    expect(useLyricsStore.getState().trackId).toBe("b");
    expect(useLyricsStore.getState().status).toBe("ready");

    // The stale resolution for track "a" resolves now — it must be ignored.
    releaseFirst({ outcome: "not-found" });
    await first;
    expect(useLyricsStore.getState().trackId).toBe("b");
    expect(useLyricsStore.getState().status).toBe("ready");
  });

  it("never surfaces aborted resolutions as errors", async () => {
    resolveMock.mockRejectedValue(Object.assign(new Error("aborted"), { kind: "aborted" }));
    await useLyricsStore.getState().resolveForTrack(makeTrack("a"));
    expect(useLyricsStore.getState().status).toBe("checking"); // unchanged, no error
  });

  it("deduplicates resolution for the same track", async () => {
    resolveMock.mockResolvedValue({ outcome: "cached", lyrics: { trackId: "a", format: "txt", lines: [], offsetMs: 0, updatedAt: 0, skippedLines: 0, sourceName: "" } });
    await useLyricsStore.getState().resolveForTrack(makeTrack("a"));
    await useLyricsStore.getState().resolveForTrack(makeTrack("a"));
    expect(resolveMock).toHaveBeenCalledTimes(1);
  });

  it("force re-resolution with searchAgain always queries", async () => {
    resolveMock.mockResolvedValue({ outcome: "cached", lyrics: { trackId: "a", format: "txt", lines: [], offsetMs: 0, updatedAt: 0, skippedLines: 0, sourceName: "" } });
    const track = makeTrack("a");
    await useLyricsStore.getState().resolveForTrack(track);
    await useLyricsStore.getState().searchAgain(track);
    expect(resolveMock).toHaveBeenCalledTimes(2);
  });

  it("stores candidates for the picker and clears them on selection", async () => {
    resolveMock.mockResolvedValue({ outcome: "needs-selection", candidates: [candidate(1), candidate(2)] });
    await useLyricsStore.getState().resolveForTrack(makeTrack("a"));
    expect(useLyricsStore.getState().status).toBe("needs-selection");
    expect(useLyricsStore.getState().candidates).toHaveLength(2);

    attachMock.mockResolvedValue({ trackId: "a", format: "lrc", lines: [], offsetMs: 0, updatedAt: 0, skippedLines: 0, sourceName: "lrclib #1" });
    await useLyricsStore.getState().pickCandidate(candidate(1));
    expect(useLyricsStore.getState().status).toBe("ready");
    expect(useLyricsStore.getState().candidates).toHaveLength(0);
    expect(useLyricsStore.getState().lyricsVersion).toBe(1);
  });

  it("maps API errors to an error status with a message", async () => {
    resolveMock.mockResolvedValue({ outcome: "error", message: "The lyrics service is busy." });
    await useLyricsStore.getState().resolveForTrack(makeTrack("a"));
    expect(useLyricsStore.getState().status).toBe("error");
    expect(useLyricsStore.getState().errorMessage).toContain("busy");
  });

  it("does not re-resolve on its own after an error (no check/error loop)", async () => {
    resolveMock.mockResolvedValue({ outcome: "error", message: "The lyrics service is busy." });
    const track = makeTrack("a");
    await useLyricsStore.getState().resolveForTrack(track);
    expect(useLyricsStore.getState().status).toBe("error");
    // The view calls resolveForTrack on every status change; a failed lookup
    // must stay terminal instead of hammering the provider forever.
    await useLyricsStore.getState().resolveForTrack(track);
    await useLyricsStore.getState().resolveForTrack(track);
    expect(resolveMock).toHaveBeenCalledTimes(1);
    // Recovery is user-initiated and always queries.
    resolveMock.mockResolvedValue({ outcome: "cached", lyrics: { trackId: "a", format: "txt", lines: [], offsetMs: 0, updatedAt: 0, skippedLines: 0, sourceName: "" } });
    await useLyricsStore.getState().retry(track);
    expect(resolveMock).toHaveBeenCalledTimes(2);
  });

  it("updates resolution phases during discovery", async () => {
    resolveMock.mockImplementation(async (_track, options) => {
      options?.onProgress?.("identifying");
      options?.onProgress?.("searching");
      options?.onProgress?.("validating");
      return { outcome: "attached", lyrics: { trackId: "a", format: "lrc", lines: [], offsetMs: 0, updatedAt: 0, skippedLines: 0, sourceName: "" } };
    });
    const track = makeTrack("a");
    await useLyricsStore.getState().resolveForTrack(track);
    expect(useLyricsStore.getState().phase).toBe("ready");
  });
});
