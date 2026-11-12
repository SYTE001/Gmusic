import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { MiniPlayer, resolveMiniPlayerMode } from "./MiniPlayer";
import { AppShell } from "./AppShell";
import { NowPlayingPage } from "../features/player/NowPlayingPage";
import { useLibraryStore } from "../stores/libraryStore";
import { bindPlaybackHelpers, usePlaybackStore } from "../stores/playbackStore";
import { DEFAULT_PREFERENCES, useSettingsStore } from "../stores/settingsStore";
import { repository } from "../services/indexeddb/LibraryRepository";
import type { AudioEngine, EngineEvents, MediaFailure } from "../services/audio/engine";
import type { Track, TrackLyrics } from "../types";

/** Deterministic engine double — no real audio in jsdom (mirrors the store test). */
class FakeEngine implements AudioEngine {
  element: HTMLAudioElement | null = null;
  src: string | null = null;
  playing = false;
  time = 42;
  duration = 120;
  volume = 0.8;
  muted = false;
  sourceGen = 0;
  playError: unknown = null;
  #events: EngineEvents;

  constructor(events: EngineEvents) {
    this.#events = events;
  }

  get sourceGeneration(): number {
    return this.sourceGen;
  }

  setSource(url: string | null) {
    this.sourceGen += 1;
    this.src = url;
    if (url !== null) this.#events.onDurationChange(this.duration);
  }
  async play() {
    if (this.playError !== null) throw this.playError;
    this.playing = true;
    this.#events.onPlayStateChange(true);
  }
  pause() {
    this.playing = false;
    this.#events.onPlayStateChange(false);
  }
  get currentTimeSec() {
    return this.time;
  }
  seekSec(seconds: number) {
    this.time = seconds;
    this.#events.onTimeUpdate(seconds);
  }
  get durationSec() {
    return this.duration;
  }
  setVolume(volume: number) {
    this.volume = volume;
  }
  setMuted(muted: boolean) {
    this.muted = muted;
  }
  dispose() {
    this.playing = false;
  }
}

function createTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: "track-1",
    title: "Midnight City",
    artist: "M83",
    album: "Hurry Up, We're Dreaming",
    trackNumber: 1,
    albumTrackCount: 12,
    durationMs: 243000,
    fileName: "midnight_city.mp3",
    fileSize: 4096000,
    mimeType: "audio/mpeg",
    addedAt: 1672531200000,
    lastPlayedAt: null,
    playCount: 5,
    isLiked: false,
    availability: "available",
    accessMode: "stored-copy",
    fingerprint: "fp-midnight",
    metadataFromFilename: false,
    ...overrides,
  };
}

function renderMiniPlayer(onToggleQueue = () => {}) {
  return render(
    <MemoryRouter>
      <MiniPlayer onToggleQueue={onToggleQueue} queueOpen={false} />
    </MemoryRouter>,
  );
}

describe("resolveMiniPlayerMode", () => {
  it("resolves mobile (< 900px) to compact dock regardless of setting", () => {
    expect(resolveMiniPlayerMode("auto", false)).toBe("compact");
    expect(resolveMiniPlayerMode("compact", false)).toBe("compact");
    expect(resolveMiniPlayerMode("standard", false)).toBe("compact");
    expect(resolveMiniPlayerMode("expanded", false)).toBe("compact");
  });

  it("preserves compact, standard, and expanded modes on desktop (>= 900px)", () => {
    expect(resolveMiniPlayerMode("auto", true)).toBe("standard");
    expect(resolveMiniPlayerMode("compact", true)).toBe("compact");
    expect(resolveMiniPlayerMode("standard", true)).toBe("standard");
    expect(resolveMiniPlayerMode("expanded", true)).toBe("expanded");
  });
});

describe("MiniPlayer volume control and adaptive modes", () => {
  let engine: FakeEngine;

  beforeEach(async () => {
    vi.clearAllMocks();
    await repository.clearAllData();
    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1280 });
    useSettingsStore.setState({ prefs: { ...DEFAULT_PREFERENCES, miniPlayerMode: "auto" }, loaded: true });

    const track = createTrack();
    const track2 = createTrack({ id: "track-2", title: "Wait", artist: "M83" });
    const track3 = createTrack({ id: "track-3", title: "Outro", artist: "M83" });
    const track4 = createTrack({ id: "track-4", title: "Reunion", artist: "M83" });
    const track5 = createTrack({ id: "track-5", title: "Steve McQueen", artist: "M83" });

    useLibraryStore.setState({
      tracks: [track, track2, track3, track4, track5],
      playlists: [],
      status: "ready",
      loadError: null,
      toggleLike: vi.fn(),
    });
    engine = new FakeEngine({
      onTimeUpdate: (sec) => usePlaybackStore.setState({ currentTimeMs: sec * 1000 }),
      onDurationChange: (sec) => usePlaybackStore.setState({ durationMs: sec !== null ? sec * 1000 : null }),
      onPlayStateChange: (isPlaying) => usePlaybackStore.setState({ isPlaying }),
      onBufferingChange: (isBuffering) => usePlaybackStore.setState({ isBuffering }),
      onSeeked: () => undefined,
      onEnded: () => undefined,
      onError: (_failure: MediaFailure) => undefined,
    });
    usePlaybackStore.getState().setEngineForTests(engine);
    usePlaybackStore.setState({
      currentTrackId: "track-1",
      isPlaying: false,
      isBuffering: false,
      status: "ready",
      shuffleEnabled: false,
      repeatMode: "off",
      volume: 0.8,
      isMuted: false,
      currentTimeMs: 42000,
      durationMs: 243000,
      queueTrackIds: ["track-1", "track-2", "track-3", "track-4", "track-5"],
      queueIndex: 0,
    });
    bindPlaybackHelpers({ persistPrefs: () => undefined, persistPosition: () => undefined });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders track info and transport controls in standard mode", () => {
    const { container } = renderMiniPlayer();
    expect(container.querySelector('[data-mini-player-mode="standard"]')).toBeTruthy();
    expect(screen.getByText("Midnight City")).toBeTruthy();
    expect(screen.getByText("M83")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous track" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next track" })).toBeTruthy();
    // Right zone (and the mobile progress line) carry the seek slider.
    expect(screen.getAllByRole("slider", { name: "Seek" }).length).toBeGreaterThan(0);
  });

  it("renders compact mode with streamlined controls and overflow menu", () => {
    useSettingsStore.setState({ prefs: { ...DEFAULT_PREFERENCES, miniPlayerMode: "compact" }, loaded: true });
    const { container } = renderMiniPlayer();
    expect(container.querySelector('[data-mini-player-mode="compact"]')).toBeTruthy();
    expect(screen.getByText("Midnight City")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next track" })).toBeTruthy();
    // Secondary controls are moved into the overflow menu
    expect(screen.queryByRole("button", { name: "Previous track" })).toBeNull();

    const menuBtn = screen.getByRole("button", { name: /Player options and mode/i });
    fireEvent.click(menuBtn);
    expect(screen.getByRole("menuitem", { name: /Add to Liked Songs/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Enable shuffle/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Open Queue/i })).toBeTruthy();
  });

  it("renders expanded mode on desktop with lyrics preview and up to 3 upcoming queue tracks", async () => {
    const sampleLyrics: TrackLyrics = {
      trackId: "track-1",
      format: "lrc",
      lines: [
        { timeMs: 10000, text: "Waiting in a car" },
        { timeMs: 40000, text: "Waiting for a ride in the dark" },
        { timeMs: 45000, text: "The night city grows" },
      ],
      offsetMs: 0,
      updatedAt: Date.now(),
      skippedLines: 0,
      sourceName: "test.lrc",
    };
    await repository.putLyrics(sampleLyrics);
    useSettingsStore.setState({ prefs: { ...DEFAULT_PREFERENCES, miniPlayerMode: "expanded" }, loaded: true });

    const { container } = renderMiniPlayer();
    expect(container.querySelector('[data-mini-player-mode="expanded"]')).toBeTruthy();

    // Up to 3 upcoming tracks (track-2, track-3, track-4), not track-5
    expect(screen.getByText("Wait")).toBeTruthy();
    expect(screen.getByText("Outro")).toBeTruthy();
    expect(screen.getByText("Reunion")).toBeTruthy();
    expect(screen.queryByText("Steve McQueen")).toBeNull();

    // Active lyric line at 42s is "Waiting for a ride in the dark" + next line "The night city grows"
    expect(await screen.findByText("Waiting for a ride in the dark")).toBeTruthy();
    expect(screen.getByText("The night city grows")).toBeTruthy();
  });

  it("shows 'Lyrics not available' in expanded mode when no lyrics exist without triggering lookup", async () => {
    useSettingsStore.setState({ prefs: { ...DEFAULT_PREFERENCES, miniPlayerMode: "expanded" }, loaded: true });
    renderMiniPlayer();
    expect(await screen.findByText("Lyrics not available")).toBeTruthy();
  });

  it("switches modes without interrupting playback, changing position, or reloading audio source", () => {
    const startTrackSpy = vi.spyOn(usePlaybackStore.getState(), "startTrack");
    const seekSpy = vi.spyOn(usePlaybackStore.getState(), "seek");
    const initialGen = engine.sourceGeneration;

    usePlaybackStore.setState({ isPlaying: true, currentTimeMs: 65000 });
    const { container } = renderMiniPlayer();
    expect(container.querySelector('[data-mini-player-mode="standard"]')).toBeTruthy();

    act(() => {
      useSettingsStore.getState().update({ miniPlayerMode: "compact" });
    });
    expect(container.querySelector('[data-mini-player-mode="compact"]')).toBeTruthy();

    act(() => {
      useSettingsStore.getState().update({ miniPlayerMode: "expanded" });
    });
    expect(container.querySelector('[data-mini-player-mode="expanded"]')).toBeTruthy();

    expect(startTrackSpy).not.toHaveBeenCalled();
    expect(seekSpy).not.toHaveBeenCalled();
    expect(engine.sourceGeneration).toBe(initialGen);
    expect(usePlaybackStore.getState().currentTrackId).toBe("track-1");
    expect(usePlaybackStore.getState().currentTimeMs).toBe(65000);
    expect(usePlaybackStore.getState().isPlaying).toBe(true);
    expect(usePlaybackStore.getState().volume).toBe(0.8);
  });

  it("keeps the volume popover closed until the speaker button is clicked", () => {
    renderMiniPlayer();
    const trigger = screen.getByRole("button", { name: "Open volume slider" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("slider", { name: "Volume" })).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByRole("slider", { name: "Volume" })).toBeTruthy();
    // Default comes from the live playback store volume, not a hardcoded value.
    expect((screen.getByRole("slider", { name: "Volume" }) as HTMLInputElement).value).toBe("0.8");

    fireEvent.click(screen.getByRole("button", { name: "Close volume slider" }));
    expect(screen.queryByRole("slider", { name: "Volume" })).toBeNull();
  });

  it("reflects muted state in the level icon", () => {
    usePlaybackStore.setState({ volume: 0, isMuted: false });
    const { container } = renderMiniPlayer();
    expect(container.querySelector('[data-volume-level="mute"]')).toBeTruthy();

    act(() => {
      usePlaybackStore.setState({ volume: 0.3, isMuted: false });
    });
    expect(container.querySelector('[data-volume-level="low"]')).toBeTruthy();

    act(() => {
      usePlaybackStore.setState({ volume: 0.8, isMuted: false });
    });
    expect(container.querySelector('[data-volume-level="normal"]')).toBeTruthy();

    act(() => {
      usePlaybackStore.setState({ volume: 0.8, isMuted: true });
    });
    expect(container.querySelector('[data-volume-level="mute"]')).toBeTruthy();
  });

  it("changes the engine volume live without touching playback position", () => {
    renderMiniPlayer();
    fireEvent.click(screen.getByRole("button", { name: "Open volume slider" }));
    const slider = screen.getByRole("slider", { name: "Volume" }) as HTMLInputElement;

    fireEvent.change(slider, { target: { value: "0.4" } });

    expect(engine.volume).toBe(0.4);
    expect(usePlaybackStore.getState().volume).toBe(0.4);
    expect(usePlaybackStore.getState().currentTimeMs).toBe(42000);
    expect(usePlaybackStore.getState().isPlaying).toBe(false);
  });

  it("mutes from the popover icon and keeps the previous volume for restore", () => {
    renderMiniPlayer();
    fireEvent.click(screen.getByRole("button", { name: "Open volume slider" }));

    fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    expect(engine.muted).toBe(true);
    expect(usePlaybackStore.getState().isMuted).toBe(true);
    // Volume is preserved so unmute restores it.
    expect(usePlaybackStore.getState().volume).toBe(0.8);
    expect((screen.getByRole("slider", { name: "Volume" }) as HTMLInputElement).value).toBe("0");

    fireEvent.click(screen.getByRole("button", { name: "Unmute" }));
    expect(engine.muted).toBe(false);
    expect(usePlaybackStore.getState().isMuted).toBe(false);
  });

  it("closes the popover on Escape and on outside pointerdown", () => {
    renderMiniPlayer();
    fireEvent.click(screen.getByRole("button", { name: "Open volume slider" }));
    expect(screen.getByRole("slider", { name: "Volume" })).toBeTruthy();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("slider", { name: "Volume" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open volume slider" }));
    expect(screen.getByRole("slider", { name: "Volume" })).toBeTruthy();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("slider", { name: "Volume" })).toBeNull();
  });
});

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="current-path">{location.pathname}</div>;
}

describe("Mobile Compact Now Playing Dock (< 900px)", () => {
  let engine: FakeEngine;

  beforeEach(async () => {
    vi.clearAllMocks();
    await repository.clearAllData();
    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 390 });
    Object.defineProperty(window, "innerHeight", { writable: true, configurable: true, value: 844 });
    useSettingsStore.setState({ prefs: { ...DEFAULT_PREFERENCES, miniPlayerMode: "auto" }, loaded: true });

    const track = createTrack();
    const track2 = createTrack({ id: "track-2", title: "Wait", artist: "M83" });
    const track3 = createTrack({ id: "track-3", title: "Outro", artist: "M83" });

    useLibraryStore.setState({
      tracks: [track, track2, track3],
      playlists: [],
      status: "ready",
      loadError: null,
      toggleLike: vi.fn(),
    });

    engine = new FakeEngine({
      onTimeUpdate: (sec) => usePlaybackStore.setState({ currentTimeMs: sec * 1000 }),
      onDurationChange: (sec) => usePlaybackStore.setState({ durationMs: sec !== null ? sec * 1000 : null }),
      onPlayStateChange: (isPlaying) => usePlaybackStore.setState({ isPlaying }),
      onBufferingChange: (isBuffering) => usePlaybackStore.setState({ isBuffering }),
      onSeeked: () => undefined,
      onEnded: () => undefined,
      onError: () => undefined,
    });
    usePlaybackStore.getState().setEngineForTests(engine);
    usePlaybackStore.setState({
      currentTrackId: "track-1",
      isPlaying: true,
      isBuffering: false,
      status: "ready",
      error: null,
      shuffleEnabled: true,
      repeatMode: "all",
      volume: 0.8,
      isMuted: false,
      currentTimeMs: 135000, // 02:15
      durationMs: 243000,
      queueTrackIds: ["track-1", "track-2", "track-3"],
      queueIndex: 0,
    });
    bindPlaybackHelpers({
      getTrackForPlayback: async (id) => useLibraryStore.getState().tracks.find((t) => t.id === id),
      currentTrack: () => useLibraryStore.getState().tracks.find((t) => t.id === usePlaybackStore.getState().currentTrackId),
      resolveSource: async (t) => ({ ok: true, url: `blob:${t.id}`, release: () => undefined }),
      notifyTrackStarted: async () => undefined,
      markTrackAvailability: async () => undefined,
      persistPrefs: () => undefined,
      persistPosition: () => undefined,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it.each([360, 375, 390, 430, 768])(
    "renders streamlined 4-part Compact Dock at %ipx with only Open Now Playing, Play/Pause, Next, and thin progress line",
    (width) => {
      Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: width });
      useSettingsStore.setState({ prefs: { ...DEFAULT_PREFERENCES, miniPlayerMode: "standard" }, loaded: true });

      const { container } = render(
        <MemoryRouter>
          <MiniPlayer onToggleQueue={() => undefined} queueOpen={false} />
        </MemoryRouter>,
      );

      const dock = container.querySelector('[data-viewport="mobile"][data-mini-player-mode="compact"]');
      expect(dock).toBeTruthy();

      expect(screen.getByText("Midnight City")).toBeTruthy();
      expect(screen.getByText("M83")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Open Now Playing" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Next track" })).toBeTruthy();

      // Secondary controls and time labels must not render on the mobile dock
      expect(screen.queryByRole("button", { name: "Previous track" })).toBeNull();
      expect(screen.queryByRole("button", { name: /shuffle/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /repeat/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /queue/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /lyrics/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /volume/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /Expand to full player/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /Player options/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /liked songs/i })).toBeNull();
      expect(screen.queryByText("2:15")).toBeNull();
      expect(screen.queryByText("4:03")).toBeNull();

      // Buttons must never be nested inside each other
      const openBtn = screen.getByRole("button", { name: "Open Now Playing" });
      const pauseBtn = screen.getByRole("button", { name: "Pause" });
      const nextBtn = screen.getByRole("button", { name: "Next track" });
      expect(openBtn.contains(pauseBtn)).toBe(false);
      expect(openBtn.contains(nextBtn)).toBe(false);
    },
  );

  it("toggles play/pause and advances next track without navigating away", async () => {
    const togglePlaySpy = vi.spyOn(usePlaybackStore.getState(), "togglePlay");
    const nextSpy = vi.spyOn(usePlaybackStore.getState(), "next");

    render(
      <MemoryRouter initialEntries={["/library"]}>
        <LocationProbe />
        <MiniPlayer onToggleQueue={() => undefined} queueOpen={false} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("current-path").textContent).toBe("/library");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pause" }));
      await Promise.resolve();
    });
    expect(togglePlaySpy).toHaveBeenCalledTimes(1);
    expect(usePlaybackStore.getState().isPlaying).toBe(false);
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
    expect(screen.getByTestId("current-path").textContent).toBe("/library");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next track" }));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(nextSpy).toHaveBeenCalledWith(true);
    expect(usePlaybackStore.getState().currentTrackId).toBe("track-2");
    expect(usePlaybackStore.getState().queueIndex).toBe(1);
    expect(screen.getByText("Wait")).toBeTruthy();
    expect(screen.getByTestId("current-path").textContent).toBe("/library");
  });

  it("stops cleanly when Next is pressed on a single-track / ended queue without next track", () => {
    usePlaybackStore.setState({
      queueTrackIds: ["track-1"],
      queueIndex: 0,
      repeatMode: "off",
      isPlaying: true,
    });

    render(
      <MemoryRouter>
        <MiniPlayer onToggleQueue={() => undefined} queueOpen={false} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Next track" }));
    expect(usePlaybackStore.getState().isPlaying).toBe(false);
    expect(usePlaybackStore.getState().status).toBe("ended");
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
  });

  it("tracks playback and seek progress accurately in the thin progress line", () => {
    const { container } = render(
      <MemoryRouter>
        <MiniPlayer onToggleQueue={() => undefined} queueOpen={false} />
      </MemoryRouter>,
    );

    const fill = container.querySelector('[aria-hidden="true"] > div') as HTMLDivElement;
    expect(fill).toBeTruthy();
    expect(fill.style.transform).toContain("0.5555");

    act(() => {
      usePlaybackStore.getState().seek(60750); // 25% of 243000ms
    });

    expect(fill.style.transform).toBe("scaleX(0.25)");
  });

  it("opens Now Playing from artwork/title without restarting track, resetting position, or altering queue/shuffle/repeat, and preserves state on close", () => {
    const startTrackSpy = vi.spyOn(usePlaybackStore.getState(), "startTrack");
    const playTrackFromContextSpy = vi.spyOn(usePlaybackStore.getState(), "playTrackFromContext");
    const playContextSpy = vi.spyOn(usePlaybackStore.getState(), "playContext");
    const initialGen = engine.sourceGeneration;

    render(
      <MemoryRouter initialEntries={["/"]}>
        <LocationProbe />
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<div>Home View</div>} />
            <Route path="now-playing" element={<NowPlayingPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const nav = screen.getByRole("navigation", { name: "Primary" });
    const dock = document.querySelector('[data-viewport="mobile"][data-mini-player-mode="compact"]');
    expect(dock).toBeTruthy();
    // Dock appears directly before bottom navigation in AppShell layout
    expect(dock!.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open Now Playing" }));

    expect(screen.getByTestId("current-path").textContent).toBe("/now-playing");
    expect(startTrackSpy).not.toHaveBeenCalled();
    expect(playTrackFromContextSpy).not.toHaveBeenCalled();
    expect(playContextSpy).not.toHaveBeenCalled();
    expect(engine.sourceGeneration).toBe(initialGen);
    expect(usePlaybackStore.getState().currentTrackId).toBe("track-1");
    expect(usePlaybackStore.getState().currentTimeMs).toBe(135000);
    expect(usePlaybackStore.getState().isPlaying).toBe(true);
    expect(usePlaybackStore.getState().shuffleEnabled).toBe(true);
    expect(usePlaybackStore.getState().repeatMode).toBe("all");
    expect(usePlaybackStore.getState().queueTrackIds).toEqual(["track-1", "track-2", "track-3"]);

    // Close Now Playing -> returns cleanly with MiniPlayer intact and playback unbroken
    fireEvent.click(screen.getByRole("button", { name: "Close Now Playing" }));
    expect(screen.getByTestId("current-path").textContent).toBe("/");
    expect(document.querySelector('[data-viewport="mobile"][data-mini-player-mode="compact"]')).toBeTruthy();
    expect(usePlaybackStore.getState().isPlaying).toBe(true);
    expect(usePlaybackStore.getState().currentTimeMs).toBe(135000);
    expect(engine.sourceGeneration).toBe(initialGen);
  });

  it("keeps track paused when opening Now Playing while paused", () => {
    usePlaybackStore.setState({ isPlaying: false, currentTimeMs: 90000 });

    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<div>Home View</div>} />
            <Route path="now-playing" element={<NowPlayingPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open Now Playing" }));
    const nowPlaying = screen.getByRole("region", { name: "Now playing" });
    expect(nowPlaying).toBeTruthy();
    expect(usePlaybackStore.getState().isPlaying).toBe(false);
    expect(usePlaybackStore.getState().currentTimeMs).toBe(90000);
    expect(within(nowPlaying).getByRole("button", { name: "Play" })).toBeTruthy();
  });

  it("handles idle, buffering, and error states honestly without claiming playback", () => {
    const { container } = render(
      <MemoryRouter>
        <MiniPlayer onToggleQueue={() => undefined} queueOpen={false} />
      </MemoryRouter>,
    );

    // Buffering state keeps Play/Pause honest to store
    act(() => {
      usePlaybackStore.setState({ isPlaying: false, isBuffering: true });
    });
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
    expect(container.querySelector(".animate-pulse")).toBeTruthy();

    // Error state shows honest error cue and keeps Play button for retry
    act(() => {
      usePlaybackStore.setState({
        isPlaying: false,
        isBuffering: false,
        status: "error",
        error: { title: "File unavailable", detail: "Missing audio file", action: "relink" },
      });
    });
    expect(screen.getByText("File unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();

    // Idle with no active track renders nothing
    act(() => {
      usePlaybackStore.setState({ currentTrackId: null, status: "idle", isPlaying: false, error: null });
    });
    expect(container.firstChild).toBeNull();
  });

  it("transitions between Mobile (< 900px) and Desktop (>= 900px) without interrupting playback or reloading audio source", () => {
    const startTrackSpy = vi.spyOn(usePlaybackStore.getState(), "startTrack");
    const initialGen = engine.sourceGeneration;

    const { container } = render(
      <MemoryRouter>
        <MiniPlayer onToggleQueue={() => undefined} queueOpen={false} />
      </MemoryRouter>,
    );

    expect(container.querySelector('[data-viewport="mobile"]')).toBeTruthy();

    act(() => {
      Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1280 });
      window.dispatchEvent(new Event("resize"));
    });
    expect(container.querySelector('[data-viewport="mobile"]')).toBeNull();
    expect(container.querySelector('[data-mini-player-mode="standard"]')).toBeTruthy();

    act(() => {
      Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 390 });
      window.dispatchEvent(new Event("resize"));
    });
    expect(container.querySelector('[data-viewport="mobile"]')).toBeTruthy();

    expect(startTrackSpy).not.toHaveBeenCalled();
    expect(engine.sourceGeneration).toBe(initialGen);
    expect(usePlaybackStore.getState().currentTimeMs).toBe(135000);
    expect(usePlaybackStore.getState().isPlaying).toBe(true);
  });
});
