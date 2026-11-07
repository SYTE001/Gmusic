import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { MiniPlayer } from "./MiniPlayer";
import { useLibraryStore } from "../stores/libraryStore";
import { bindPlaybackHelpers, usePlaybackStore } from "../stores/playbackStore";
import type { AudioEngine, EngineEvents, MediaFailure } from "../services/audio/engine";
import type { Track } from "../types";

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

function renderMiniPlayer() {
  return render(
    <MemoryRouter>
      <MiniPlayer onToggleQueue={() => {}} queueOpen={false} />
    </MemoryRouter>,
  );
}

describe("MiniPlayer volume control", () => {
  let engine: FakeEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    const track = createTrack();
    useLibraryStore.setState({
      tracks: [track],
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
    });
    bindPlaybackHelpers({ persistPrefs: () => undefined, persistPosition: () => undefined });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders track info and transport controls", () => {
    renderMiniPlayer();
    expect(screen.getByText("Midnight City")).toBeTruthy();
    expect(screen.getByText("M83")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous track" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next track" })).toBeTruthy();
    // Right zone (and the mobile progress line) carry the seek slider.
    expect(screen.getAllByRole("slider", { name: "Seek" }).length).toBeGreaterThan(0);
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
