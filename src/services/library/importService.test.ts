import { beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import type { Track } from "../../types";
import {
  importAudioItems,
  extractTailHash,
  extractHeadHash,
  haveConflictingVersions,
  isGenericTitleOrArtist,
  evaluateMetadataImprovement,
  findMatchingExistingTrack,
} from "./importService";

// Deterministic crypto so fingerprints are real SHA-256 digests in jsdom.
Object.defineProperty(globalThis, "crypto", { value: webcrypto });

vi.mock("../metadata", () => ({
  probeAudioFile: vi.fn(async () => ({ supported: true, durationMs: 180_000 })),
  parseAudioTags: vi.fn(async () => ({})),
}));

const libraryMap = new Map<string, Track>();
const audioMap = new Map<string, Blob>();
const artworkMap = new Map<string, Blob>();

const putTracks = vi.fn(async (tracks: Track[]) => {
  for (const track of tracks) {
    libraryMap.set(track.id, track);
  }
});
const putArtwork = vi.fn(async (id: string, blob: Blob) => {
  artworkMap.set(id, blob);
});
const putHandle = vi.fn(async (_id: string, _handle: FileSystemFileHandle) => {});
const putAudioBlob = vi.fn(async (id: string, blob: Blob) => {
  audioMap.set(id, blob);
});

vi.mock("../indexeddb/LibraryRepository", () => ({
  repository: {
    putTracks: (...args: unknown[]) => putTracks(...(args as [Track[]])),
    putArtwork: (...args: unknown[]) => putArtwork(...(args as [string, Blob])),
    putHandle: (...args: unknown[]) => putHandle(...(args as [string, FileSystemFileHandle])),
    putAudioBlob: (...args: unknown[]) => putAudioBlob(...(args as [string, Blob])),
  },
}));

vi.mock("../file-access/FileAccessService", () => ({
  rememberSessionFile: vi.fn(),
}));

function audioFile(name: string, content: string): File {
  return new File([content], name, { type: "audio/mpeg" });
}

function librarySoFar(): Track[] {
  return Array.from(libraryMap.values());
}

async function run(files: File[]) {
  return importAudioItems(files, { existingTracks: librarySoFar(), storeCopies: true });
}

describe("importAudioItems intelligent re-import & duplicate reconciliation", () => {
  beforeEach(() => {
    libraryMap.clear();
    audioMap.clear();
    artworkMap.clear();
    putTracks.mockClear();
    putArtwork.mockClear();
    putHandle.mockClear();
    putAudioBlob.mockClear();
  });

  // Base behavior
  it("imports a new song", async () => {
    const outcome = await run([audioFile("first.mp3", "audio-content-one")]);
    expect(outcome.added).toBe(1);
    expect(outcome.duplicatesSkipped).toBe(0);
  });

  // Case 1: Importing exact same audio twice -> no duplicate
  it("Case 1: Importing exact same audio twice -> no duplicate", async () => {
    const outcome1 = await run([audioFile("song.mp3", "same-audio-bytes")]);
    expect(outcome1.added).toBe(1);
    expect(outcome1.duplicatesSkipped).toBe(0);

    const outcome2 = await run([audioFile("song.mp3", "same-audio-bytes")]);
    expect(outcome2.added).toBe(0);
    expect(outcome2.updated).toBe(0);
    expect(outcome2.duplicatesSkipped).toBe(1);
  });

  // Case 2: Importing identical audio with different filename -> no duplicate
  it("Case 2: Importing identical audio with different filename -> no duplicate", async () => {
    await run([audioFile("original-name.mp3", "identical-audio-bytes")]);
    const outcome = await run([audioFile("renamed-copy.mp3", "identical-audio-bytes")]);
    expect(outcome.duplicatesSkipped).toBe(1);
    expect(outcome.added).toBe(0);
    expect(outcome.updated).toBe(0);
  });

  // Case 3: Importing corrected title and artist -> update existing metadata, preserve track ID
  it("Case 3: Importing corrected title and artist -> update existing metadata, preserve track ID", async () => {
    const { parseAudioTags } = await import("../metadata");
    vi.mocked(parseAudioTags).mockResolvedValueOnce({
      title: "Teh Sciencist",
      artist: "Coldpaly",
    });

    const outcome1 = await run([audioFile("coldplay.mp3", "coldplay-track-bytes")]);
    expect(outcome1.added).toBe(1);
    const originalTrack = outcome1.newTracks![0];
    const originalId = originalTrack.id;

    // Second import with corrected metadata for the exact same audio
    vi.mocked(parseAudioTags).mockResolvedValueOnce({
      title: "The Scientist",
      artist: "Coldplay",
    });

    const outcome2 = await run([audioFile("coldplay.mp3", "coldplay-track-bytes")]);
    expect(outcome2.added).toBe(0);
    expect(outcome2.updated).toBe(1);
    expect(outcome2.updatedTracks).toHaveLength(1);
    expect(outcome2.updatedTracks![0].id).toBe(originalId);
    expect(outcome2.updatedTracks![0].title).toBe("The Scientist");
    expect(outcome2.updatedTracks![0].artist).toBe("Coldplay");
    expect(libraryMap.get(originalId)?.title).toBe("The Scientist");
  });

  // Case 4: Importing different recording with same title/artist -> keep both tracks
  it("Case 4: Importing different recording with same title/artist -> keep both tracks", async () => {
    const { parseAudioTags, probeAudioFile } = await import("../metadata");
    vi.mocked(parseAudioTags).mockResolvedValue({
      title: "Yesterday",
      artist: "The Beatles",
    });

    // Recording 1: 125s studio
    vi.mocked(probeAudioFile).mockResolvedValueOnce({ supported: true, durationMs: 125_000 });
    const outcome1 = await run([audioFile("yesterday-take1.mp3", "audio-take-1-bytes")]);
    expect(outcome1.added).toBe(1);

    // Recording 2: 160s different recording (duration differs by > 1.5s)
    vi.mocked(probeAudioFile).mockResolvedValueOnce({ supported: true, durationMs: 160_000 });
    const outcome2 = await run([audioFile("yesterday-take2.mp3", "audio-take-2-bytes")]);
    expect(outcome2.added).toBe(1);
    expect(outcome2.duplicatesSkipped).toBe(0);
    expect(outcome2.updated).toBe(0);
    expect(librarySoFar()).toHaveLength(2);
  });

  // Case 5: Importing remix or live version -> do not merge with original
  it("Case 5: Importing remix or live version -> do not merge with original", async () => {
    const { parseAudioTags } = await import("../metadata");
    vi.mocked(parseAudioTags).mockResolvedValueOnce({
      title: "Hotel California",
      artist: "Eagles",
    });
    await run([audioFile("hotel-california.mp3", "studio-bytes")]);

    vi.mocked(parseAudioTags).mockResolvedValueOnce({
      title: "Hotel California (Live)",
      artist: "Eagles",
    });
    const outcome = await run([audioFile("hotel-california-live.mp3", "live-recording-bytes")]);
    expect(outcome.added).toBe(1);
    expect(outcome.duplicatesSkipped).toBe(0);
    expect(outcome.updated).toBe(0);
    expect(librarySoFar()).toHaveLength(2);
  });

  // Case 6: Importing file with incomplete metadata -> preserve better existing metadata
  it("Case 6: Importing file with incomplete metadata -> preserve better existing metadata", async () => {
    const { parseAudioTags } = await import("../metadata");
    vi.mocked(parseAudioTags).mockResolvedValueOnce({
      title: "Full Title",
      artist: "Full Artist",
      album: "Great Album",
      trackNumber: 5,
    });
    const outcome1 = await run([audioFile("rich.mp3", "rich-metadata-audio")]);
    const originalTrack = outcome1.newTracks![0];

    // Second import with empty/incomplete tags
    vi.mocked(parseAudioTags).mockResolvedValueOnce({});
    const outcome2 = await run([audioFile("rich.mp3", "rich-metadata-audio")]);
    expect(outcome2.updated).toBe(0);
    expect(outcome2.duplicatesSkipped).toBe(1);

    const stored = libraryMap.get(originalTrack.id);
    expect(stored?.title).toBe("Full Title");
    expect(stored?.artist).toBe("Full Artist");
    expect(stored?.album).toBe("Great Album");
    expect(stored?.trackNumber).toBe(5);
  });

  // Case 7: Re-importing file with improved artwork/metadata -> update only relevant fields
  it("Case 7: Re-importing file with improved artwork/metadata -> update only relevant fields", async () => {
    const { parseAudioTags } = await import("../metadata");
    vi.mocked(parseAudioTags).mockResolvedValueOnce({
      title: "Good Song",
      artist: "Good Artist",
    });
    const outcome1 = await run([audioFile("artwork-test.mp3", "artwork-audio-bytes")]);
    const original = outcome1.newTracks![0];
    const artBlob = new Blob(["mock-artwork-bytes"], { type: "image/jpeg" });

    vi.mocked(parseAudioTags).mockResolvedValueOnce({
      title: "Good Song",
      artist: "Good Artist",
      album: "New Album Name",
      trackNumber: 2,
      artwork: artBlob,
    });

    const outcome2 = await run([audioFile("artwork-test.mp3", "artwork-audio-bytes")]);
    expect(outcome2.updated).toBe(1);
    expect(putArtwork).toHaveBeenCalledWith(original.id, artBlob);

    const stored = libraryMap.get(original.id)!;
    expect(stored.id).toBe(original.id);
    expect(stored.addedAt).toBe(original.addedAt);
    expect(stored.title).toBe("Good Song");
    expect(stored.artist).toBe("Good Artist");
    expect(stored.album).toBe("New Album Name");
    expect(stored.trackNumber).toBe(2);
  });

  // Case 8: Updating track in multiple playlists -> all playlist relationships remain intact
  it("Case 8: Updating track in multiple playlists -> all playlist relationships remain intact", async () => {
    const { parseAudioTags } = await import("../metadata");
    vi.mocked(parseAudioTags).mockResolvedValueOnce({
      title: "Old Title",
      artist: "Old Artist",
    });
    const outcome1 = await run([audioFile("playlist-track.mp3", "playlist-audio-bytes")]);
    const trackId = outcome1.newTracks![0].id;

    // Simulated playlists referencing trackId
    const playlistA = { id: "p1", name: "Favorites", description: "", trackIds: [trackId, "other-1"], createdAt: 1, updatedAt: 1 };
    const playlistB = { id: "p2", name: "Workout", description: "", trackIds: ["other-2", trackId], createdAt: 1, updatedAt: 1 };

    vi.mocked(parseAudioTags).mockResolvedValueOnce({
      title: "New Correct Title",
      artist: "New Artist",
    });
    const outcome2 = await run([audioFile("playlist-track.mp3", "playlist-audio-bytes")]);
    expect(outcome2.updated).toBe(1);

    expect(playlistA.trackIds).toContain(trackId);
    expect(playlistB.trackIds).toContain(trackId);
    expect(libraryMap.get(trackId)?.title).toBe("New Correct Title");
  });

  // Case 9: Re-importing track with existing lyrics -> lyrics and synchronization remain intact
  it("Case 9: Re-importing track with existing lyrics -> lyrics and synchronization remain intact", async () => {
    const { parseAudioTags } = await import("../metadata");
    vi.mocked(parseAudioTags).mockResolvedValueOnce({
      title: "Lyrics Track",
      artist: "Lyrics Artist",
    });
    const outcome1 = await run([audioFile("lyrics-track.mp3", "lyrics-audio-bytes")]);
    const trackId = outcome1.newTracks![0].id;

    // Existing lyrics stored for trackId
    const lyricsRecord = {
      trackId,
      format: "lrc" as const,
      lines: [{ timeMs: 12000, text: "First line" }],
      offsetMs: 0,
      updatedAt: Date.now(),
      skippedLines: 0,
      sourceName: "manual",
    };

    vi.mocked(parseAudioTags).mockResolvedValueOnce({
      title: "Lyrics Track Updated",
      artist: "Lyrics Artist",
    });
    const outcome2 = await run([audioFile("lyrics-track.mp3", "lyrics-audio-bytes")]);
    expect(outcome2.updated).toBe(1);

    expect(lyricsRecord.trackId).toBe(trackId);
    expect(libraryMap.get(trackId)?.id).toBe(trackId);
  });

  // Case 10: Failed audio replacement -> original audio remains available
  it("Case 10: Failed audio replacement -> original audio remains available", async () => {
    const { parseAudioTags } = await import("../metadata");
    vi.mocked(parseAudioTags).mockResolvedValueOnce({
      title: "Initial Song",
      artist: "Initial Artist",
    });
    const outcome1 = await run([audioFile("fail-replace.mp3", "original-audio-content")]);
    const trackId = outcome1.newTracks![0].id;
    expect(audioMap.get(trackId)).toBeDefined();

    // Next audio blob write fails (e.g. disk quota error)
    putAudioBlob.mockRejectedValueOnce(new Error("QuotaExceededError"));

    vi.mocked(parseAudioTags).mockResolvedValueOnce({
      title: "Improved Song Title",
      artist: "Initial Artist",
    });

    const outcome2 = await run([audioFile("fail-replace.mp3", "original-audio-content")]);
    expect(outcome2.failed).toHaveLength(1);
    expect(outcome2.failed[0].reason).toContain("QuotaExceededError");
    expect(outcome2.updated).toBe(0);

    // Original track and audio remain intact
    expect(libraryMap.get(trackId)?.title).toBe("Initial Song");
    expect(audioMap.get(trackId)).toBeDefined();
  });

  // Case 11: Importing mixed batch -> accurate summary (added, updated, duplicatesSkipped)
  it("Case 11: Importing mixed batch -> accurate summary (added, updated, duplicatesSkipped)", async () => {
    const { parseAudioTags } = await import("../metadata");
    vi.mocked(parseAudioTags).mockResolvedValueOnce({
      title: "Existing Song",
      artist: "Artist 1",
    });
    await run([audioFile("existing.mp3", "existing-bytes")]);

    vi.mocked(parseAudioTags).mockImplementation(async (file: File) => {
      if (file.name === "fresh.mp3") return { title: "Fresh Song", artist: "Artist 2" };
      if (file.name === "existing.mp3") return { title: "Existing Song", artist: "Artist 1" };
      if (file.name === "existing-better.mp3") {
        return { title: "Existing Song", artist: "Artist 1", album: "New Discovered Album" };
      }
      return {};
    });

    const outcome = await run([
      audioFile("fresh.mp3", "fresh-bytes"),
      audioFile("existing.mp3", "existing-bytes"),
      audioFile("existing-better.mp3", "existing-bytes"),
    ]);

    expect(outcome.added).toBe(1);
    expect(outcome.duplicatesSkipped).toBe(1);
    expect(outcome.updated).toBe(1);
  });

  it("restores broken track status when re-importing audio", async () => {
    const brokenTrack: Track = {
      id: "broken-track-id",
      title: "Broken Song",
      artist: "Artist",
      album: "Album",
      trackNumber: 1,
      albumTrackCount: 1,
      durationMs: 180_000,
      fileName: "broken.mp3",
      fileSize: 1000,
      mimeType: "audio/mpeg",
      addedAt: Date.now() - 10000,
      lastPlayedAt: null,
      playCount: 0,
      isLiked: false,
      availability: "broken",
      accessMode: "stored-copy",
      fingerprint: null,
      metadataFromFilename: false,
      broken: {
        isBroken: true,
        category: "missing",
        description: "Missing audio file",
        failedAt: Date.now() - 5000,
        retryCount: 2,
      },
    };
    libraryMap.set(brokenTrack.id, brokenTrack);

    const { parseAudioTags } = await import("../metadata");
    vi.mocked(parseAudioTags).mockResolvedValueOnce({
      title: "Broken Song",
      artist: "Artist",
      album: "Album",
    });

    const outcome = await run([
      new File(["fresh-audio-bytes"], "broken.mp3", { type: "audio/mpeg" }),
    ]);

    expect(outcome.updated).toBe(1);
    const restored = libraryMap.get("broken-track-id");
    expect(restored?.availability).toBe("available");
    expect(restored?.broken).toBeNull();
  });

  it("allows a different song that shares a generic filename", async () => {
    await run([audioFile("track01.mp3", "album-one-first-track")]);
    const outcome = await run([audioFile("track01.mp3", "album-two-first-track-longer")]);
    expect(outcome.added).toBe(1);
    expect(outcome.duplicatesSkipped).toBe(0);
  });

  it("deduplicates identical files inside one batch", async () => {
    const outcome = await run([
      audioFile("a.mp3", "batch-duplicate-bytes"),
      audioFile("a-copy.mp3", "batch-duplicate-bytes"),
    ]);
    expect(outcome.added).toBe(1);
    expect(outcome.duplicatesSkipped).toBe(1);
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

  describe("Reconciliation Helper Functions", () => {
    it("extractTailHash and extractHeadHash extract partial hashes properly", () => {
      const mockFingerprint = "0123456789abcdef0123456789abcdef:1024:180000";
      expect(extractHeadHash(mockFingerprint)).toBe("0123456789abcdef");
      expect(extractTailHash(mockFingerprint)).toBe("0123456789abcdef");
      expect(extractTailHash("weak:1024:180000")).toBeNull();
      expect(extractTailHash(null)).toBeNull();
    });

    it("haveConflictingVersions distinguishes versions", () => {
      expect(haveConflictingVersions("Song", "song.mp3", "Song (Live)", "song.mp3")).toBe(true);
      expect(haveConflictingVersions("Song (Remix)", "song.mp3", "Song", "song.mp3")).toBe(true);
      expect(haveConflictingVersions("Song", "song.mp3", "Song", "song.mp3")).toBe(false);
      expect(haveConflictingVersions("Song (Live)", "song.mp3", "Song (Live)", "song.mp3")).toBe(false);
    });

    it("isGenericTitleOrArtist detects generic track numbers and unknown artists", () => {
      expect(isGenericTitleOrArtist("Track 01", "Artist")).toBe(true);
      expect(isGenericTitleOrArtist("Song", "Unknown Artist")).toBe(true);
      expect(isGenericTitleOrArtist("Yellow", "Coldplay")).toBe(false);
    });

    it("evaluateMetadataImprovement never downgrades metadata", () => {
      const existing: Track = {
        id: "t1",
        title: "Song",
        artist: "Artist",
        album: "Super Album",
        trackNumber: 5,
        albumTrackCount: 10,
        durationMs: 180000,
        fileName: "song.mp3",
        fileSize: 1000,
        mimeType: "audio/mpeg",
        addedAt: Date.now(),
        lastPlayedAt: null,
        playCount: 0,
        isLiked: false,
        availability: "available",
        accessMode: "stored-copy",
        fingerprint: "fp1",
        metadataFromFilename: false,
      };

      // Incomplete tags
      const result = evaluateMetadataImprovement(existing, { title: "Song" }, { title: "Song", artist: "" }, 180000);
      expect(result.hasImprovement).toBe(false);
      expect(result.improvedAlbum).toBeUndefined();
      expect(result.improvedTrackNumber).toBeUndefined();

      // Improved tags
      const improved = evaluateMetadataImprovement(
        existing,
        { title: "Song", album: "New Album 2", trackNumber: 6 },
        { title: "Song", artist: "" },
        180000,
      );
      expect(improved.hasImprovement).toBe(true);
      expect(improved.improvedAlbum).toBe("New Album 2");
      expect(improved.improvedTrackNumber).toBe(6);
    });

    it("findMatchingExistingTrack performs Level 1, 2, and 3 matching", () => {
      const existing: Track = {
        id: "t1",
        title: "The Scientist",
        artist: "Coldplay",
        album: "A Rush of Blood to the Head",
        trackNumber: 4,
        albumTrackCount: 11,
        durationMs: 300000,
        fileName: "the_scientist.mp3",
        fileSize: 5000000,
        mimeType: "audio/mpeg",
        addedAt: Date.now(),
        lastPlayedAt: null,
        playCount: 0,
        isLiked: false,
        availability: "available",
        accessMode: "stored-copy",
        fingerprint: "0123456789abcdef0123456789abcdef:5000000:300000",
        metadataFromFilename: false,
      };

      // Level 1: exact fingerprint
      const match1 = findMatchingExistingTrack({
        file: audioFile("any.mp3", "test"),
        fingerprint: "0123456789abcdef0123456789abcdef:5000000:300000",
        tailHash: "0123456789abcdef",
        durationMs: 300000,
        normalizedTitle: "the scientist",
        normalizedArtist: "coldplay",
        rawTitle: "The Scientist",
        rawArtist: "Coldplay",
        tracks: [existing],
      });
      expect(match1?.matchLevel).toBe(1);

      // Level 2: tail hash match
      const match2 = findMatchingExistingTrack({
        file: audioFile("retagged.mp3", "test"),
        fingerprint: "differenthead00000123456789abcdef:5000100:300200",
        tailHash: "0123456789abcdef",
        durationMs: 300200,
        normalizedTitle: "the scientist",
        normalizedArtist: "coldplay",
        rawTitle: "The Scientist",
        rawArtist: "Coldplay",
        tracks: [existing],
      });
      expect(match2?.matchLevel).toBe(2);

      // Level 3: Metadata match with close duration and size
      const match3 = findMatchingExistingTrack({
        file: new File([new ArrayBuffer(5001000)], "new_file.mp3", { type: "audio/mpeg" }),
        fingerprint: "differenthash999differenthash888:5001000:300100",
        tailHash: "differenthash888",
        durationMs: 300100,
        normalizedTitle: "the scientist",
        normalizedArtist: "coldplay",
        rawTitle: "The Scientist",
        rawArtist: "Coldplay",
        tracks: [existing],
      });
      expect(match3?.matchLevel).toBe(3);
    });

    it("rejects corrupted mojibake title from tags and safely falls back to filename title", async () => {
      const { parseAudioTags } = await import("../metadata");
      vi.mocked(parseAudioTags).mockResolvedValueOnce({
        title: "ÿþThot Shit",
        artist: "Megan Thee Stallion",
      });

      const outcome = await run([audioFile("Megan Thee Stallion - Thot Shit.mp3", "audio-content")]);
      expect(outcome.added).toBe(1);
      const track = outcome.newTracks![0];
      // Title must be healed from filename, and artist preserved from tag
      expect(track.title).toBe("Thot Shit");
      expect(track.artist).toBe("Megan Thee Stallion");
      expect(track.metadataFromFilename).toBe(true);
    });

    it("falls back to Unknown Track only when both tags and filename have no valid title", async () => {
      const { parseAudioTags } = await import("../metadata");
      vi.mocked(parseAudioTags).mockResolvedValueOnce({
        title: "   ",
        artist: "",
      });

      const outcome = await run([audioFile(".mp3", "audio-content-2")]);
      expect(outcome.added).toBe(1);
      const track = outcome.newTracks![0];
      expect(track.title).toBe("Unknown Track");
      expect(track.artist).toBe("Unknown Artist");
    });
  });
});
