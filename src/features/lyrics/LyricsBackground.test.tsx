import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { LyricsBackground } from "./LyricsBackground";
import { stepDownTier } from "./palette";
import { useSettingsStore } from "../../stores/settingsStore";
import type { Track } from "../../types";

const mockTrackA: Track = {
  id: "track-a",
  title: "Song A",
  artist: "Artist A",
  album: "Album A",
  trackNumber: 1,
  albumTrackCount: 10,
  durationMs: 200_000,
  fileName: "song_a.mp3",
  fileSize: 4_000_000,
  mimeType: "audio/mpeg",
  addedAt: Date.now(),
  lastPlayedAt: null,
  playCount: 0,
  isLiked: false,
  availability: "available",
  accessMode: "stored-copy",
  fingerprint: "fp-a",
  metadataFromFilename: false,
};

const mockTrackA2: Track = {
  ...mockTrackA,
  id: "track-a2",
  title: "Song A2 (Same Album)",
  trackNumber: 2,
};

const mockTrackB: Track = {
  ...mockTrackA,
  id: "track-b",
  title: "Song B",
  album: "Album B",
};

describe("LyricsBackground Component", () => {
  beforeEach(() => {
    window.localStorage.removeItem("gmusic_lyrics_bg_tier");
    useSettingsStore.setState({
      prefs: {
        ...useSettingsStore.getState().prefs,
        animatedLyricsBackground: true,
        reducedMotion: "off",
      },
    });
  });

  it("renders base, blur stage, blobs, scrim, and CSS palette variables", () => {
    const { container } = render(<LyricsBackground track={mockTrackA} isPlaying={true} />);
    const root = container.querySelector(".lyrics-bg-container") as HTMLElement | null;
    expect(root).not.toBeNull();
    expect(root?.classList.contains("lyrics-bg-paused")).toBe(false);
    expect(root?.style.opacity).toBe("1");

    // Blobs
    const blobs = container.querySelectorAll(".lyrics-blob");
    expect(blobs.length).toBeGreaterThanOrEqual(3);

    // Scrim overlay
    const scrim = container.querySelector("[style*='linear-gradient']");
    expect(scrim).not.toBeNull();

    // Layer exposes --bg-base and --blob-1..4 variables
    const layer = container.querySelector(".lyrics-bg-container > div") as HTMLElement | null;
    expect(layer?.style.getPropertyValue("--bg-base")).toBeTruthy();
    expect(layer?.style.getPropertyValue("--blob-1")).toBeTruthy();
  });

  it("fades opacity via visible prop without unmounting", () => {
    const { container, rerender } = render(
      <LyricsBackground track={mockTrackA} isPlaying={true} visible={true} />,
    );
    const root = container.querySelector(".lyrics-bg-container") as HTMLElement | null;
    expect(root?.style.opacity).toBe("1");

    rerender(<LyricsBackground track={mockTrackA} isPlaying={true} visible={false} />);
    expect(root?.style.opacity).toBe("0");
    expect(root?.classList.contains("lyrics-bg-paused")).toBe(true);
  });

  it("drops to static tier and pauses when animatedLyricsBackground setting is disabled", () => {
    useSettingsStore.setState({
      prefs: {
        ...useSettingsStore.getState().prefs,
        animatedLyricsBackground: false,
      },
    });

    const { container } = render(<LyricsBackground track={mockTrackA} isPlaying={true} />);
    const root = container.querySelector(".lyrics-bg-container");
    expect(root?.classList.contains("lyrics-bg-paused")).toBe(true);
    expect(root?.getAttribute("data-tier")).toBe("static");
  });

  it("drops to static tier and pauses when reducedMotion is enabled", () => {
    useSettingsStore.setState({
      prefs: {
        ...useSettingsStore.getState().prefs,
        reducedMotion: "on",
      },
    });

    const { container } = render(<LyricsBackground track={mockTrackA} isPlaying={true} />);
    const root = container.querySelector(".lyrics-bg-container");
    expect(root?.classList.contains("lyrics-bg-paused")).toBe(true);
    expect(root?.getAttribute("data-tier")).toBe("static");
  });

  it("pauses animation when playback is paused for more than 3 seconds", () => {
    vi.useFakeTimers();

    const { container, rerender } = render(<LyricsBackground track={mockTrackA} isPlaying={true} />);
    const root = container.querySelector(".lyrics-bg-container");
    expect(root?.classList.contains("lyrics-bg-paused")).toBe(false);

    // Pause playback
    rerender(<LyricsBackground track={mockTrackA} isPlaying={false} />);
    expect(root?.classList.contains("lyrics-bg-paused")).toBe(false);

    // Advance 3 seconds
    act(() => {
      vi.advanceTimersByTime(3100);
    });

    expect(root?.classList.contains("lyrics-bg-paused")).toBe(true);

    // Resume playback
    rerender(<LyricsBackground track={mockTrackA} isPlaying={true} />);
    expect(root?.classList.contains("lyrics-bg-paused")).toBe(false);

    vi.useRealTimers();
  });

  it("skips A/B crossfade when changing to a song from the same album, and crossfades on different album", () => {
    const { container, rerender } = render(<LyricsBackground track={mockTrackA} isPlaying={true} />);
    const layersInitial = container.querySelectorAll(".lyrics-bg-container > div[style*='opacity']");
    expect(layersInitial.length).toBe(1);

    // Change to another song on the same album -> skip transition (still 1 layer)
    rerender(<LyricsBackground track={mockTrackA2} isPlaying={true} />);
    const layersSameAlbum = container.querySelectorAll(".lyrics-bg-container > div[style*='opacity']");
    expect(layersSameAlbum.length).toBe(1);

    // Change to track from different album -> crossfades to layer B (2 layers)
    rerender(<LyricsBackground track={mockTrackB} isPlaying={true} />);
    const layersDifferentAlbum = container.querySelectorAll(".lyrics-bg-container > div[style*='opacity']");
    expect(layersDifferentAlbum.length).toBe(2);
  });

  it("steps down performance tiers full -> lite -> static and persists to localStorage", () => {
    expect(stepDownTier("full")).toBe("lite");
    expect(window.localStorage.getItem("gmusic_lyrics_bg_tier")).toBe("lite");
    expect(stepDownTier("lite")).toBe("static");
    expect(window.localStorage.getItem("gmusic_lyrics_bg_tier")).toBe("static");
  });
});
