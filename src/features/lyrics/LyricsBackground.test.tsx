import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { LyricsBackground } from "./LyricsBackground";
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

const mockTrackB: Track = {
  ...mockTrackA,
  id: "track-b",
  title: "Song B",
  album: "Album B",
};

describe("LyricsBackground Component", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      prefs: {
        ...useSettingsStore.getState().prefs,
        animatedLyricsBackground: true,
        reducedMotion: "off",
      },
    });
  });

  it("renders base, blur stage, blobs, scrim, and grain overlay", () => {
    const { container } = render(<LyricsBackground track={mockTrackA} isPlaying={true} />);
    const root = container.querySelector(".lyrics-bg-container");
    expect(root).not.toBeNull();
    expect(root?.classList.contains("lyrics-bg-paused")).toBe(false);

    // Blobs
    const blobs = container.querySelectorAll(".lyrics-blob");
    expect(blobs.length).toBeGreaterThanOrEqual(3);

    // Scrim overlay
    const scrim = container.querySelector("[style*='linear-gradient']");
    expect(scrim).not.toBeNull();
  });

  it("pauses animation when animatedLyricsBackground setting is disabled", () => {
    useSettingsStore.setState({
      prefs: {
        ...useSettingsStore.getState().prefs,
        animatedLyricsBackground: false,
      },
    });

    const { container } = render(<LyricsBackground track={mockTrackA} isPlaying={true} />);
    const root = container.querySelector(".lyrics-bg-container");
    expect(root?.classList.contains("lyrics-bg-paused")).toBe(true);
  });

  it("pauses animation when reducedMotion is enabled", () => {
    useSettingsStore.setState({
      prefs: {
        ...useSettingsStore.getState().prefs,
        reducedMotion: "on",
      },
    });

    const { container } = render(<LyricsBackground track={mockTrackA} isPlaying={true} />);
    const root = container.querySelector(".lyrics-bg-container");
    expect(root?.classList.contains("lyrics-bg-paused")).toBe(true);
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

  it("crossfades to layer B when track changes to a different album", () => {
    const { container, rerender } = render(<LyricsBackground track={mockTrackA} isPlaying={true} />);
    const layersInitial = container.querySelectorAll(".lyrics-bg-container > div[style*='opacity']");
    expect(layersInitial.length).toBe(1);

    // Change to track from different album
    rerender(<LyricsBackground track={mockTrackB} isPlaying={true} />);
    const layersAfterChange = container.querySelectorAll(".lyrics-bg-container > div[style*='opacity']");
    expect(layersAfterChange.length).toBe(2);
  });
});
