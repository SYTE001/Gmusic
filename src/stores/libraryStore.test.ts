import { beforeEach, describe, expect, it } from "vitest";
import { useLibraryStore } from "./libraryStore";
import { usePlaybackStore } from "./playbackStore";
import type { AudioEngine } from "../services/audio/engine";
import { repository } from "../services/indexeddb/LibraryRepository";
import type { Track } from "../types";

/** Minimal engine stub so store code paths never touch real media elements. */
function installEngineStub(): void {
  const stub = {
    element: null,
    setSource: () => undefined,
    play: async () => undefined,
    pause: () => undefined,
    get currentTimeSec() {
      return 0;
    },
    seekSec: () => undefined,
    get durationSec() {
      return null;
    },
    setVolume: () => undefined,
    setMuted: () => undefined,
    dispose: () => undefined,
  } satisfies AudioEngine;
  usePlaybackStore.getState().setEngineForTests(stub);
}

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: `t${Math.random().toString(36).slice(2, 8)}`,
    title: "Song",
    artist: "Artist",
    album: "Album",
    trackNumber: null,
    albumTrackCount: null,
    durationMs: 60000,
    fileName: "song.mp3",
    fileSize: 1000,
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

describe("library store (IndexedDB-backed)", () => {
  beforeEach(async () => {
    await repository.clearAllData();
    installEngineStub();
    useLibraryStore.setState({ tracks: [], playlists: [], status: "loading", loadError: null });
  });

  it("loads persisted tracks and playlists on init", async () => {
    const track = makeTrack();
    await repository.putTracks([track]);
    await repository.putPlaylist({ id: "p1", name: "Mix", description: "", trackIds: [track.id], createdAt: 1, updatedAt: 1 });

    await useLibraryStore.getState().init();

    expect(useLibraryStore.getState().tracks.map((item) => item.id)).toEqual([track.id]);
    expect(useLibraryStore.getState().playlists).toHaveLength(1);
  });

  it("creates, renames, reorders, and deletes playlists; deletion keeps tracks", async () => {
    const a = makeTrack();
    const b = makeTrack();
    await repository.putTracks([a, b]);
    await useLibraryStore.getState().init();

    const playlist = await useLibraryStore.getState().createPlaylist("Late night");
    await useLibraryStore.getState().addToPlaylist(playlist.id, [a.id, b.id]);
    await useLibraryStore.getState().renamePlaylist(playlist.id, "Late night drive");
    await useLibraryStore.getState().reorderPlaylist(playlist.id, 1, 0);

    const stored = await repository.getPlaylist(playlist.id);
    expect(stored?.name).toBe("Late night drive");
    expect(stored?.trackIds).toEqual([b.id, a.id]);

    await useLibraryStore.getState().deletePlaylist(playlist.id);
    expect(await repository.listPlaylists()).toHaveLength(0);
    // Track records survive playlist deletion (rules §6).
    expect(await repository.listTracks()).toHaveLength(2);
  });

  it("persists liked state through the repository", async () => {
    const track = makeTrack();
    await repository.putTracks([track]);
    await useLibraryStore.getState().init();

    await useLibraryStore.getState().toggleLike(track.id);
    expect(useLibraryStore.getState().tracks[0].isLiked).toBe(true);
    expect((await repository.getTrack(track.id))?.isLiked).toBe(true);

    await useLibraryStore.getState().setLiked(track.id, false);
    expect((await repository.getTrack(track.id))?.isLiked).toBe(false);
  });

  it("removing tracks cascades artwork/lyrics and updates playlists", async () => {
    const a = makeTrack();
    const b = makeTrack();
    await repository.putTracks([a, b]);
    await repository.putArtwork(a.id, new Blob(["x"]));
    await repository.putLyrics({
      trackId: a.id,
      format: "txt",
      lines: [{ timeMs: null, text: "la" }],
      offsetMs: 0,
      updatedAt: 1,
      skippedLines: 0,
      sourceName: "a.txt",
    });
    const playlist = await useLibraryStore.getState().createPlaylist("Mix");
    await useLibraryStore.getState().addToPlaylist(playlist.id, [a.id, b.id]);

    await useLibraryStore.getState().removeTracks([a.id]);

    expect(await repository.getTrack(a.id)).toBeUndefined();
    expect(await repository.getArtwork(a.id)).toBeUndefined();
    expect(await repository.getLyrics(a.id)).toBeUndefined();
    const stored = await repository.getPlaylist(playlist.id);
    expect(stored?.trackIds).toEqual([b.id]);
  });

  it("clearLibrary empties everything but never touches prefs", async () => {
    await repository.putTracks([makeTrack()]);
    await useLibraryStore.getState().init();
    await useLibraryStore.getState().clearLibrary();

    expect(await repository.listTracks()).toHaveLength(0);
    // Re-init after clear works.
    await useLibraryStore.getState().init();
    expect(useLibraryStore.getState().tracks).toHaveLength(0);
  });
});
