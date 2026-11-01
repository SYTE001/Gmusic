import { beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import type { Track } from "../../types";
import { importAudioItems } from "./importService";

// Deterministic crypto so fingerprints are real SHA-256 digests in jsdom.
Object.defineProperty(globalThis, "crypto", { value: webcrypto });

vi.mock("../metadata", () => ({
  probeAudioFile: vi.fn(async () => ({ supported: true, durationMs: 180_000 })),
  parseAudioTags: vi.fn(async () => ({})),
}));

const putTracks = vi.fn(async (_tracks: Track[]) => {});
vi.mock("../indexeddb/LibraryRepository", () => ({
  repository: {
    putTracks: (...args: unknown[]) => putTracks(...(args as [Track[]])),
    putArtwork: vi.fn(async () => {}),
    putHandle: vi.fn(async () => {}),
    putAudioBlob: vi.fn(async () => {}),
  },
}));

vi.mock("../file-access/FileAccessService", () => ({
  rememberSessionFile: vi.fn(),
}));

function audioFile(name: string, content: string): File {
  return new File([content], name, { type: "audio/mpeg" });
}

/** Tracks "in the library" are whatever the repository has been given so far. */
function librarySoFar(): Track[] {
  return putTracks.mock.calls.flatMap((call) => call[0] as Track[]);
}

async function run(files: File[]) {
  return importAudioItems(files, { existingTracks: librarySoFar(), storeCopies: true });
}

describe("importAudioItems duplicate prevention", () => {
  beforeEach(() => {
    putTracks.mockClear();
  });

  it("imports a new song", async () => {
    const outcome = await run([audioFile("first.mp3", "audio-content-one")]);
    expect(outcome.added).toBe(1);
    expect(outcome.duplicatesSkipped).toBe(0);
  });

  it("skips the exact same file on a later import", async () => {
    await run([audioFile("song.mp3", "same-bytes")]);
    const outcome = await run([audioFile("song.mp3", "same-bytes")]);
    expect(outcome.added).toBe(0);
    expect(outcome.duplicatesSkipped).toBe(1);
  });

  it("skips identical audio content under a different filename", async () => {
    await run([audioFile("original-name.mp3", "identical-audio-bytes")]);
    const outcome = await run([audioFile("renamed-copy.mp3", "identical-audio-bytes")]);
    expect(outcome.duplicatesSkipped).toBe(1);
    expect(outcome.added).toBe(0);
  });

  it("allows a different song that shares a filename", async () => {
    await run([audioFile("track01.mp3", "album-one-first-track")]);
    const outcome = await run([audioFile("track01.mp3", "album-two-first-track-longer")]);
    expect(outcome.added).toBe(1);
    expect(outcome.duplicatesSkipped).toBe(0);
  });

  it("allows two different recordings even with identical tags", async () => {
    const { parseAudioTags } = await import("../metadata");
    vi.mocked(parseAudioTags).mockResolvedValue({ title: "Same Title", artist: "Same Artist" });
    try {
      await run([audioFile("studio.mp3", "studio-recording-bytes")]);
      const outcome = await run([audioFile("live.mp3", "live-recording-bytes-different-length")]);
      expect(outcome.added).toBe(1);
      expect(outcome.duplicatesSkipped).toBe(0);
    } finally {
      vi.mocked(parseAudioTags).mockReset();
    }
  });

  it("deduplicates identical files inside one batch", async () => {
    const outcome = await run([
      audioFile("a.mp3", "batch-duplicate-bytes"),
      audioFile("a-copy.mp3", "batch-duplicate-bytes"),
    ]);
    expect(outcome.added).toBe(1);
    expect(outcome.duplicatesSkipped).toBe(1);
  });

  it("handles a mixed batch: new songs imported, duplicates skipped", async () => {
    await run([audioFile("known.mp3", "already-in-library")]);
    const outcome = await run([
      audioFile("fresh.mp3", "brand-new-song"),
      audioFile("known-again.mp3", "already-in-library"),
      audioFile("another.mp3", "another-new-song"),
    ]);
    expect(outcome.added).toBe(2);
    expect(outcome.duplicatesSkipped).toBe(1);
    expect(librarySoFar().map((track) => track.fileName)).toEqual(
      expect.arrayContaining(["known.mp3", "fresh.mp3", "another.mp3"]),
    );
  });

  it("normalizes noisy filename metadata on import while preserving original fileName", async () => {
    const outcome = await run([
      audioFile("Billie Eilish - Ocean Eyes (Dance Performance Video).mp3", "video-track-bytes"),
    ]);
    expect(outcome.added).toBe(1);
    expect(outcome.newTracks).toHaveLength(1);
    const imported = outcome.newTracks![0];
    expect(imported.artist).toBe("Billie Eilish");
    expect(imported.title).toBe("Ocean Eyes");
    expect(imported.fileName).toBe("Billie Eilish - Ocean Eyes (Dance Performance Video).mp3");
  });
});
