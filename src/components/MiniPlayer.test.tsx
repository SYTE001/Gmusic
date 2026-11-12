import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { MiniPlayer, resolveMiniPlayerMode } from "./MiniPlayer";
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
  it("resolves auto to standard on desktop (>= 900px) and compact below 900px", () => {
    expect(resolveMiniPlayerMode("auto", true)).toBe("standard");
    expect(resolveMiniPlayerMode("auto", false)).toBe("compact");
  });

  it("allows compact and standard on all viewports", () => {
    expect(resolveMiniPlayerMode("compact", true)).toBe("compact");
    expect(resolveMiniPlayerMode("compact", false)).toBe("compact");
    expect(resolveMiniPlayerMode("standard", true)).toBe("standard");
    expect(resolveMiniPlayerMode("standard", false)).toBe("standard");
  });

  it("only allows expanded dock on desktop (>= 900px)", () => {
    expect(resolveMiniPlayerMode("expanded", true)).toBe("expanded");
    expect(resolveMiniPlayerMode("expanded", false)).toBe("standard");
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
