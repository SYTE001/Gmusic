import { beforeEach, describe, expect, it } from "vitest";
import { buildBackup, restoreBackup, validateBackupText } from "./backupService";
import { repository } from "../indexeddb/LibraryRepository";
import { DEFAULT_PREFERENCES } from "../../stores/settingsStore";
import type { Playlist, Track } from "../../types";

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: "t1",
    title: "Song",
    artist: "Artist",
    album: "Album",
    trackNumber: null,
    albumTrackCount: null,
    durationMs: 1000,
    fileName: "song.mp3",
    fileSize: 100,
    mimeType: "audio/mpeg",
    addedAt: 1,
    lastPlayedAt: null,
    playCount: 0,
    isLiked: true,
    availability: "available",
    accessMode: "handle",
    fingerprint: "fp",
    metadataFromFilename: false,
    ...overrides,
  };
}

describe("validateBackupText", () => {
  it("rejects invalid JSON", () => {
    const result = validateBackupText("{nope");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("JSON");
  });

  it("rejects files from another app", () => {
    const result = validateBackupText(JSON.stringify({ app: "other", schemaVersion: 1, tracks: [], playlists: [], lyrics: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("app identifier");
  });

  it("rejects unsupported schema versions", () => {
    const result = validateBackupText(
      JSON.stringify({ app: "local-music", schemaVersion: 99, tracks: [], playlists: [], lyrics: [] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("schema");
  });

  it("rejects malformed track entries", () => {
    const result = validateBackupText(
      JSON.stringify({ app: "local-music", schemaVersion: 1, tracks: [{ nope: 1 }], playlists: [], lyrics: [] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("Track entry 1");
  });

  it("accepts a well-formed backup and summarizes it", () => {
    const backup = {
      app: "local-music",
      schemaVersion: 1,
      exportedAt: "2026-01-01T00:00:00.000Z",
      tracks: [makeTrack(), makeTrack({ id: "t2", isLiked: false })],
      playlists: [{ id: "p1", name: "Mix", description: "", trackIds: ["t1"], createdAt: 1, updatedAt: 1 }],
      lyrics: [{ trackId: "t1", format: "lrc", lines: [], offsetMs: 0, updatedAt: 1, skippedLines: 0, sourceName: "a.lrc" }],
    };
    const result = validateBackupText(JSON.stringify(backup));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.trackCount).toBe(2);
      expect(result.summary.playlistCount).toBe(1);
      expect(result.summary.lyricCount).toBe(1);
      expect(result.summary.likedCount).toBe(1);
    }
  });
});

describe("backup round-trip with IndexedDB", () => {
  beforeEach(async () => {
    await repository.clearAllData();
  });

  it("exports and restores playlists, liked state, and lyrics without audio access", async () => {
    const track = makeTrack();
    const playlist: Playlist = {
      id: "p1",
      name: "Road trip",
      description: "",
      trackIds: ["t1"],
      createdAt: 1,
      updatedAt: 1,
    };
    await repository.putTracks([track]);
    await repository.putPlaylist(playlist);
    await repository.putLyrics({ trackId: "t1", format: "lrc", lines: [{ timeMs: 0, text: "hey" }], offsetMs: 500, updatedAt: 1, skippedLines: 0, sourceName: "a.lrc" });
    await repository.putPreferences(DEFAULT_PREFERENCES);

    const backup = await buildBackup();
    // Exported tracks never carry live file access.
    expect(backup.tracks[0].availability).toBe("missing");
    expect(backup.tracks[0].accessMode).toBe("session-only");
    expect(backup.preferences?.theme).toBe(DEFAULT_PREFERENCES.theme);
    expect(backup.preferences?.lyricsStyle).toBe("line");

    const validation = validateBackupText(JSON.stringify(backup));
    expect(validation.ok).toBe(true);

    await restoreBackup(backup);
    const [restoredTracks, restoredPlaylists, restoredLyrics, restoredPrefs] = await Promise.all([
      repository.listTracks(),
      repository.listPlaylists(),
      repository.getLyrics("t1"),
      repository.getPreferences(),
    ]);
    expect(restoredTracks).toHaveLength(1);
    expect(restoredTracks[0].isLiked).toBe(true);
    expect(restoredPlaylists[0].trackIds).toEqual(["t1"]);
    expect(restoredLyrics?.offsetMs).toBe(500);
    expect(restoredLyrics?.lines[0].text).toBe("hey");
    expect(restoredPrefs?.lyricsStyle).toBe("line");
  });

  it("restores older backup without lyricsStyle falling back to default 'line'", async () => {
    const backup = {
      app: "local-music" as const,
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      tracks: [makeTrack()],
      playlists: [],
      lyrics: [],
      preferences: {
        theme: "dark" as const,
        volume: 0.8,
        muted: false,
        crossfadeSec: 0,
        gapless: true,
        replayGainMode: "off" as const,
        preAmpGainDb: 0,
        preventSleep: false,
        autoFetchLyrics: true,
        lyricFontSize: "md" as const,
        lyricLineSpacing: 1.5,
        lyricAlignment: "left" as const,
        enableMediaSession: true,
        highContrast: false,
        artworkTint: true,
        accentPreset: "blue" as const,
      },
    };
    await restoreBackup(backup as unknown as Parameters<typeof restoreBackup>[0]);
    const prefs = await repository.getPreferences();
    expect(prefs?.lyricsStyle).toBe("line");
  });

  it("preserves explicit lyricsStyle 'word' when present in backup", async () => {
    const backup = {
      app: "local-music" as const,
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      tracks: [makeTrack()],
      playlists: [],
      lyrics: [],
      preferences: {
        ...DEFAULT_PREFERENCES,
        lyricsStyle: "word" as const,
      },
    };
    await restoreBackup(backup);
    const prefs = await repository.getPreferences();
    expect(prefs?.lyricsStyle).toBe("word");
  });

  it("drops playlist references to tracks missing from the backup", async () => {
    const backup = {
      app: "local-music" as const,
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      tracks: [makeTrack()],
      playlists: [
        { id: "p1", name: "A", description: "", trackIds: ["t1", "ghost"], createdAt: 1, updatedAt: 1 },
      ],
      lyrics: [],
    };
    await restoreBackup(backup);
    const playlists = await repository.listPlaylists();
    expect(playlists[0].trackIds).toEqual(["t1"]);
  });
});

describe("restore safety", () => {
  const baseBackup = (tracks: Track[], extra: Record<string, unknown> = {}) => ({
    app: "local-music" as const,
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    tracks,
    playlists: [],
    lyrics: [],
    ...extra,
  });

  beforeEach(async () => {
    await repository.clearAllData();
  });

  it("keeps the previous library untouched when a restore fails midway", async () => {
    const old = makeTrack({ id: "old" });
    await repository.putTracks([old]);
    await repository.putPlaylist({ id: "p-old", name: "Old", description: "", trackIds: ["old"], createdAt: 1, updatedAt: 1 });

    // A function inside a lyric line cannot be stored: the write throws after the clear was queued.
    const poisoned = baseBackup([makeTrack({ id: "new" })], {
      lyrics: [{ trackId: "new", format: "lrc", lines: [{ timeMs: 0, text: "x", boom: () => 1 }], offsetMs: 0, updatedAt: 1, skippedLines: 0, sourceName: "a.lrc" }],
    });
    await expect(restoreBackup(poisoned as unknown as Parameters<typeof restoreBackup>[0])).rejects.toBeTruthy();

    expect((await repository.listTracks()).map((track) => track.id)).toEqual(["old"]);
    expect((await repository.listPlaylists()).map((playlist) => playlist.id)).toEqual(["p-old"]);
  });

  it("keeps file handles and stored copies for tracks that are in the backup and drops the rest", async () => {
    const kept = makeTrack({ id: "kept" });
    const stored = makeTrack({ id: "stored" });
    const dropped = makeTrack({ id: "dropped" });
    await repository.putTracks([kept, stored, dropped]);
    await repository.putHandle("kept", { kind: "file", name: "kept.mp3" } as unknown as FileSystemFileHandle);
    await repository.putAudioBlob("stored", new Blob(["bytes"]));
    await repository.putHandle("dropped", { kind: "file", name: "dropped.mp3" } as unknown as FileSystemFileHandle);
    await repository.putArtwork("dropped", new Blob(["art"]));

    const backup = baseBackup([
      makeTrack({ id: "kept", availability: "missing", accessMode: "session-only" }),
      makeTrack({ id: "stored", availability: "missing", accessMode: "session-only" }),
      makeTrack({ id: "gone", availability: "missing", accessMode: "session-only" }),
    ]);
    await restoreBackup(backup);

    const byId = new Map((await repository.listTracks()).map((track) => [track.id, track]));
    expect(byId.get("kept")).toMatchObject({ availability: "available", accessMode: "handle" });
    expect(byId.get("stored")).toMatchObject({ availability: "available", accessMode: "stored-copy" });
    expect(byId.get("gone")).toMatchObject({ availability: "missing", accessMode: "session-only" });
    expect(await repository.getHandle("kept")).toBeDefined();
    expect(await repository.getAudioBlob("stored")).toBeDefined();
    expect(await repository.getHandle("dropped")).toBeUndefined();
    expect(await repository.getArtwork("dropped")).toBeUndefined();
  });

  it("fills defaults for fields missing from an older backup", async () => {
    const sparse = { id: "s1", title: "Sparse", fileName: "s.mp3" } as unknown as Track;
    await restoreBackup(baseBackup([sparse]));
    const [restored] = await repository.listTracks();
    expect(restored).toMatchObject({ artist: "Unknown Artist", album: "", fileSize: 0, playCount: 0, isLiked: false, durationMs: null });
  });

  it("ignores preference values of the wrong type", async () => {
    await restoreBackup(baseBackup([makeTrack()], { preferences: { ...DEFAULT_PREFERENCES, volume: "loud", theme: DEFAULT_PREFERENCES.theme } }));
    expect((await repository.getPreferences())?.volume).toBe(DEFAULT_PREFERENCES.volume);
  });

  it("rejects duplicate track ids, non-string playlist ids and lyric lines without text", () => {
    const dup = validateBackupText(JSON.stringify(baseBackup([makeTrack(), makeTrack()])));
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.errors.join(" ")).toContain("repeats the id");

    const badPlaylist = validateBackupText(
      JSON.stringify(baseBackup([makeTrack()], { playlists: [{ id: "p", name: "n", trackIds: [1] }] })),
    );
    expect(badPlaylist.ok).toBe(false);

    const badLyrics = validateBackupText(
      JSON.stringify(baseBackup([makeTrack()], { lyrics: [{ trackId: "t1", lines: [{ timeMs: 0 }] }] })),
    );
    expect(badLyrics.ok).toBe(false);
  });
});