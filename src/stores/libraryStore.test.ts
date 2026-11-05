import { beforeEach, describe, expect, it } from "vitest";
import { useLibraryStore } from "./libraryStore";
import { usePlaybackStore } from "./playbackStore";
import type { AudioEngine } from "../services/audio/engine";
import { repository } from "../services/indexeddb/LibraryRepository";
import { savePlaybackSession } from "../services/library/playbackSession";
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

  it("preserves state.tracks array reference on markTrackPlayed and updates trackStats", async () => {
    const track = makeTrack({ id: "track-1", playCount: 2 });
    await repository.putTracks([track]);
    await useLibraryStore.getState().init();

    const initialTracks = useLibraryStore.getState().tracks;
    expect(useLibraryStore.getState().trackStats["track-1"]).toEqual({
      lastPlayedAt: null,
      playCount: 2,
    });

    await useLibraryStore.getState().markTrackPlayed("track-1");

    // Array reference must be identical to avoid render cascades across whole library
    expect(useLibraryStore.getState().tracks).toBe(initialTracks);
    expect(useLibraryStore.getState().trackStats["track-1"].playCount).toBe(3);
    expect(typeof useLibraryStore.getState().trackStats["track-1"].lastPlayedAt).toBe("number");

    // Subsequent play increments accurately
    await useLibraryStore.getState().markTrackPlayed("track-1");
    expect(useLibraryStore.getState().trackStats["track-1"].playCount).toBe(4);
  });
});

describe("queue and session consistency", () => {
  const resetPlayback = () =>
    usePlaybackStore.setState({
      currentTrackId: null,
      isPlaying: false,
      status: "idle",
      queueTrackIds: [],
      queueIndex: -1,
      contextTrackIds: [],
      context: null,
      currentTimeMs: 0,
    });

  beforeEach(async () => {
    await repository.clearAllData();
    installEngineStub();
    resetPlayback();
    useLibraryStore.setState({ tracks: [], playlists: [], status: "loading", loadError: null });
  });

  it("removing an upcoming track also removes it from the live queue", async () => {
    const [a, b, c] = [makeTrack({ id: "qa" }), makeTrack({ id: "qb" }), makeTrack({ id: "qc" })];
    await repository.putTracks([a, b, c]);
    await useLibraryStore.getState().init();
    usePlaybackStore.setState({ currentTrackId: "qa", status: "ready", queueTrackIds: ["qa", "qb", "qc"], queueIndex: 0, contextTrackIds: ["qa", "qb", "qc"] });

    await useLibraryStore.getState().removeTracks(["qb"]);

    const playback = usePlaybackStore.getState();
    expect(playback.queueTrackIds).toEqual(["qa", "qc"]);
    expect(playback.contextTrackIds).toEqual(["qa", "qc"]);
    expect(playback.queueIndex).toBe(0);
    expect(playback.currentTrackId).toBe("qa");
  });

  it("removing a track before the current one keeps the index on the current track", async () => {
    const [a, b, c] = [makeTrack({ id: "ra" }), makeTrack({ id: "rb" }), makeTrack({ id: "rc" })];
    await repository.putTracks([a, b, c]);
    await useLibraryStore.getState().init();
    usePlaybackStore.setState({ currentTrackId: "rc", status: "ready", queueTrackIds: ["ra", "rb", "rc"], queueIndex: 2 });

    await useLibraryStore.getState().removeTracks(["ra"]);

    const playback = usePlaybackStore.getState();
    expect(playback.queueTrackIds).toEqual(["rb", "rc"]);
    expect(playback.queueIndex).toBe(1);
  });

  it("restores the saved queue at the right slot when an earlier track was deleted", async () => {
    const [a, b] = [makeTrack({ id: "sa" }), makeTrack({ id: "sb" })];
    await repository.putTracks([a, b]);
    await savePlaybackSession({
      queueTrackIds: ["gone", "sa", "sb"],
      queueIndex: 2,
      contextTrackIds: ["gone", "sa", "sb"],
      context: null,
      currentTrackId: "sb",
      positionMs: 4200,
      savedAt: 1,
    });

    await useLibraryStore.getState().init();

    const playback = usePlaybackStore.getState();
    expect(playback.queueTrackIds).toEqual(["sa", "sb"]);
    expect(playback.queueIndex).toBe(1);
    expect(playback.queueTrackIds[playback.queueIndex]).toBe(playback.currentTrackId);
    expect(playback.currentTimeMs).toBe(4200);
    expect(playback.isPlaying).toBe(false); // restoring never autoplays
  });

  it("does not duplicate queue entries when a session is restored twice", async () => {
    const a = makeTrack({ id: "da" });
    await repository.putTracks([a]);
    await savePlaybackSession({
      queueTrackIds: ["da"], queueIndex: 0, contextTrackIds: ["da"], context: null, currentTrackId: "da", positionMs: 0, savedAt: 1,
    });
    await useLibraryStore.getState().init();
    await useLibraryStore.getState().init();
    expect(usePlaybackStore.getState().queueTrackIds).toEqual(["da"]);
  });

  it("skips a session whose current track no longer exists", async () => {
    await repository.putTracks([makeTrack({ id: "alive" })]);
    await savePlaybackSession({
      queueTrackIds: ["dead", "alive"], queueIndex: 0, contextTrackIds: [], context: null, currentTrackId: "dead", positionMs: 10, savedAt: 1,
    });
    await useLibraryStore.getState().init();
    expect(usePlaybackStore.getState().currentTrackId).toBeNull();
  });
});

describe("reload with a 100-track library", () => {
  beforeEach(async () => {
    await repository.clearAllData();
    installEngineStub();
    useLibraryStore.setState({ tracks: [], playlists: [], status: "loading", loadError: null });
  });

  it("persists and reloads every track, playlist and like across a fresh init", async () => {
    const tracks = Array.from({ length: 100 }, (_, i) => makeTrack({ id: `bulk-${i}`, title: `Song ${i}`, isLiked: i % 10 === 0 }));
    await repository.putTracks(tracks);
    for (const track of tracks) await repository.putAudioBlob(track.id, new Blob([`audio-${track.id}`]));
    await repository.putPlaylist({ id: "pl", name: "All", description: "", trackIds: tracks.map((track) => track.id), createdAt: 1, updatedAt: 1 });

    // Simulate a reload: wipe in-memory state, then initialise from storage.
    useLibraryStore.setState({ tracks: [], playlists: [], status: "loading" });
    const startedAt = performance.now();
    await useLibraryStore.getState().init();
    const elapsedMs = performance.now() - startedAt;
    console.info(`[perf] init() with 100 stored-copy tracks took ${elapsedMs.toFixed(0)} ms (jsdom + fake-indexeddb, not a browser number)`);

    const state = useLibraryStore.getState();
    expect(state.status).toBe("ready");
    expect(state.tracks).toHaveLength(100);
    expect(state.tracks.every((track) => track.availability === "available")).toBe(true);
    expect(state.tracks.filter((track) => track.isLiked)).toHaveLength(10);
    expect(state.playlists[0].trackIds).toHaveLength(100);
  });

  it("keeps metadata and marks tracks missing when their audio source disappears", async () => {
    const tracks = Array.from({ length: 5 }, (_, i) => makeTrack({ id: `lost-${i}`, title: `Lost ${i}`, accessMode: "stored-copy" }));
    await repository.putTracks(tracks);
    // No audio blobs were ever stored: every source is unavailable.
    await useLibraryStore.getState().init();

    const state = useLibraryStore.getState();
    expect(state.tracks).toHaveLength(5);
    expect(state.tracks.every((track) => track.availability === "missing")).toBe(true);
    expect(state.tracks.map((track) => track.title)).toEqual(tracks.map((track) => track.title));
    // The "missing" status is persisted, and the records are still in the database.
    expect((await repository.listTracks()).every((track) => track.availability === "missing")).toBe(true);
  });
});