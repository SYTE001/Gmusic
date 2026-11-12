import { describe, expect, it, vi } from "vitest";
import { searchCommands, searchPlaylists, searchTracks } from "./search";
import { buildCommandCatalog, type CommandActionContext } from "./commands";
import type { Playlist, Track } from "../../types";

function makeTrack(overrides: Partial<Track> & { id: string; title: string }): Track {
  return {
    artist: "Artist",
    album: "Album",
    trackNumber: 1,
    albumTrackCount: 10,
    durationMs: 180000,
    fileName: `${overrides.id}.mp3`,
    fileSize: 1000,
    mimeType: "audio/mpeg",
    addedAt: 1000,
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

function makePlaylist(overrides: Partial<Playlist> & { id: string; name: string }): Playlist {
  return {
    description: "",
    trackIds: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeMockContext(overrides: Partial<CommandActionContext> = {}): CommandActionContext {
  return {
    navigate: vi.fn(),
    toggleQueue: vi.fn(),
    openCreatePlaylist: vi.fn(),
    currentTrack: null,
    tracks: [],
    isPlaying: false,
    isMuted: false,
    shuffleEnabled: false,
    repeatMode: "off",
    queueOpen: false,
    togglePlay: vi.fn(),
    nextTrack: vi.fn(),
    previousTrack: vi.fn(),
    toggleShuffle: vi.fn(),
    cycleRepeat: vi.fn(),
    toggleMute: vi.fn(),
    toggleLike: vi.fn(),
    playTrackFromContext: vi.fn(),
    notifyInfo: vi.fn(),
    ...overrides,
  };
}

describe("Command Palette search ranking", () => {
  const tracks: Track[] = [
    makeTrack({ id: "t1", title: "Love", artist: "Air", album: "Moon Safari", fileName: "01-love.flac" }),
    makeTrack({ id: "t2", title: "Love Will Tear Us Apart", artist: "Joy Division", album: "Substance", fileName: "jd_lwtua.mp3" }),
    makeTrack({ id: "t3", title: "Modern Love", artist: "David Bowie", album: "Let's Dance", fileName: "modern_love.mp3" }),
    makeTrack({ id: "t4", title: "Beloved", artist: "Mumford", album: "Delta", fileName: "beloved_song.mp3" }),
    makeTrack({ id: "t5", title: "Nightcall", artist: "Kavinsky", album: "OutRun", fileName: "secret_filename_match.wav" }),
  ];

  it("ranks exact match > prefix match > token match > substring match", () => {
    const results = searchTracks(tracks, "love");
    expect(results.map((r) => r.id)).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("is case-insensitive and collapses extra spaces", () => {
    const results = searchTracks(tracks, "   LOVE   WILL  ");
    expect(results[0]?.id).toBe("t2");
  });

  it("matches by artist, album, and filename", () => {
    expect(searchTracks(tracks, "Kavinsky")[0]?.id).toBe("t5");
    expect(searchTracks(tracks, "Moon Safari")[0]?.id).toBe("t1");
    expect(searchTracks(tracks, "secret_filename")[0]?.id).toBe("t5");
  });

  it("limits track results to 8 and playlist results to 5", () => {
    const manyTracks = Array.from({ length: 15 }, (_, i) =>
      makeTrack({ id: `tr-${i}`, title: `Song ${i}` }),
    );
    const manyPlaylists = Array.from({ length: 10 }, (_, i) =>
      makePlaylist({ id: `pl-${i}`, name: `Mix ${i}` }),
    );
    expect(searchTracks(manyTracks, "song")).toHaveLength(8);
    expect(searchPlaylists(manyPlaylists, "mix")).toHaveLength(5);
  });
});

describe("Command catalog and dispatch", () => {
  it("disables current-track dependent commands when currentTrack is null", () => {
    const ctx = makeMockContext({ currentTrack: null, tracks: [] });
    const catalog = buildCommandCatalog(ctx);

    const playCmd = catalog.find((c) => c.id === "playback-toggle");
    const nextCmd = catalog.find((c) => c.id === "playback-next");
    const likeCmd = catalog.find((c) => c.id === "playback-like-current");
    const nowPlayingCmd = catalog.find((c) => c.id === "nav-now-playing");
    const randomCmd = catalog.find((c) => c.id === "playback-random");

    expect(playCmd?.disabled).toBe(true);
    expect(nextCmd?.disabled).toBe(true);
    expect(likeCmd?.disabled).toBe(true);
    expect(nowPlayingCmd?.disabled).toBe(true);
    expect(randomCmd?.disabled).toBe(true);
  });

  it("enables and dispatches playback and navigation commands when a track is loaded", async () => {
    const track = makeTrack({ id: "t1", title: "Test Song", isLiked: false });
    const ctx = makeMockContext({ currentTrack: track, tracks: [track] });
    const catalog = buildCommandCatalog(ctx);

    catalog.find((c) => c.id === "nav-library")?.execute();
    expect(ctx.navigate).toHaveBeenCalledWith("/library");

    catalog.find((c) => c.id === "playback-toggle")?.execute();
    expect(ctx.togglePlay).toHaveBeenCalledTimes(1);

    catalog.find((c) => c.id === "playback-next")?.execute();
    expect(ctx.nextTrack).toHaveBeenCalledTimes(1);

    await catalog.find((c) => c.id === "playback-like-current")?.execute();
    expect(ctx.toggleLike).toHaveBeenCalledWith("t1");

    catalog.find((c) => c.id === "library-create-playlist")?.execute();
    expect(ctx.openCreatePlaylist).toHaveBeenCalledTimes(1);
  });

  it("matches commands by label, category, and keywords", () => {
    const ctx = makeMockContext();
    const catalog = buildCommandCatalog(ctx);

    const shuffleMatches = searchCommands(catalog, "shuffle");
    expect(shuffleMatches[0]?.id).toBe("playback-shuffle");

    const brokenMatches = searchCommands(catalog, "relink");
    expect(brokenMatches.some((c) => c.id === "nav-broken")).toBe(true);
  });
});
