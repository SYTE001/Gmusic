import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { NowPlayingPage } from "./NowPlayingPage";
import { MiniPlayer } from "../../components/MiniPlayer";
import { SettingsPage } from "../settings/SettingsPage";
import { useLibraryStore } from "../../stores/libraryStore";
import { usePlaybackStore } from "../../stores/playbackStore";
import { DEFAULT_PREFERENCES, useSettingsStore } from "../../stores/settingsStore";
import {
  setCachedPalette,
  clearPaletteCache,
  selectSolidPalette,
  extractClustersFromPixels,
  getTrackPaletteKey,
} from "../lyrics/palette";
import type { Track } from "../../types";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function createTrack(id: string = "track-1", overrides: Partial<Track> = {}): Track {
  return {
    id,
    title: "Test Song",
    artist: "Test Artist",
    album: "Test Album",
    trackNumber: 1,
    albumTrackCount: 10,
    durationMs: 180000,
    fileName: "test.mp3",
    fileSize: 1024,
    mimeType: "audio/mpeg",
    addedAt: Date.now(),
    lastPlayedAt: null,
    playCount: 0,
    isLiked: false,
    availability: "available",
    accessMode: "stored-copy",
    fingerprint: "fp-1",
    metadataFromFilename: false,
    ...overrides,
  };
}

describe("NowPlayingPage component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPaletteCache();
    const track = createTrack();
    useLibraryStore.setState({
      tracks: [track],
      playlists: [],
      status: "ready",
      loadError: null,
    });
    usePlaybackStore.setState({
      currentTrackId: "track-1",
      isPlaying: true,
      shuffleEnabled: false,
      repeatMode: "off",
      currentTimeMs: 30000,
      durationMs: 180000,
      queueTrackIds: ["track-1"],
      queueIndex: 0,
    });
    useSettingsStore.setState({ prefs: DEFAULT_PREFERENCES, loaded: true });
  });

  it("renders empty state when no track is playing", () => {
    usePlaybackStore.setState({ currentTrackId: null });
    render(
      <MemoryRouter>
        <NowPlayingPage />
      </MemoryRouter>,
    );

    expect(screen.getByText(/Nothing is playing/i)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Pick a song/i })).toBeTruthy();
  });

  it("opens Now Playing from MiniPlayer without restarting or resetting playback position", () => {
    render(
      <MemoryRouter>
        <MiniPlayer onToggleQueue={() => undefined} queueOpen={false} />
      </MemoryRouter>,
    );

    const openBtn = screen.getByRole("button", { name: "Open Now Playing" });
    fireEvent.click(openBtn);

    expect(mockNavigate).toHaveBeenCalledWith("/now-playing");
    expect(usePlaybackStore.getState().currentTimeMs).toBe(30000);
    expect(usePlaybackStore.getState().isPlaying).toBe(true);
  });

  it("mounts with untouched bg-app-bg on root container in Stage 1 (album only)", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/now-playing"]}>
        <NowPlayingPage />
      </MemoryRouter>,
    );

    const root = screen.getByRole("region", { name: "Now playing" });
    expect(root).toBeTruthy();
    expect(root.className).toContain("bg-app-bg");
    expect(root.getAttribute("data-stage")).toBe("album");
    expect(root.style.getPropertyValue("--bg")).toBe("");
    expect(container.querySelector(".lyrics-bg-container")).toBeNull();
  });

  it("applies solid album-adaptive CSS variables (--bg, --lyric-active, --lyric-inactive, --accent) on root in Stage 2 and restores Stage 1 when hidden", () => {
    // Seed a red album palette into cache for Test Artist::Test Album
    const redPixels = new Uint8ClampedArray(32 * 32 * 4);
    for (let i = 0; i < redPixels.length; i += 4) {
      redPixels[i] = 215;
      redPixels[i + 1] = 20;
      redPixels[i + 2] = 32;
      redPixels[i + 3] = 255;
    }
    const key = getTrackPaletteKey(useLibraryStore.getState().tracks[0]);
    const redPalette = selectSolidPalette(extractClustersFromPixels(redPixels), key);
    setCachedPalette(key, redPalette);

    const { container } = render(
      <MemoryRouter initialEntries={["/now-playing?lyrics=1"]}>
        <NowPlayingPage />
      </MemoryRouter>,
    );

    const root = screen.getByRole("region", { name: "Now playing" });
    expect(root.getAttribute("data-stage")).toBe("lyrics");
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(root.getAttribute("data-cover-category")).toBe("saturated");
    expect(root.style.getPropertyValue("--bg")).toBe(redPalette.bg);
    expect(root.style.getPropertyValue("--lyric-active")).toBe("#ffffff");
    expect(root.style.getPropertyValue("--lyric-inactive")).toBe(redPalette.lyricInactive);
    expect(root.style.getPropertyValue("--accent")).toBe(redPalette.accent);
    // No animated blob/grain layers exist
    expect(container.querySelector(".lyrics-bg-container")).toBeNull();
    expect(container.querySelector(".lyrics-bg-blob")).toBeNull();

    // Toggle back to Stage 1 (Hide lyrics)
    const hideBtn = screen.getByRole("button", { name: "Hide lyrics" });
    fireEvent.click(hideBtn);

    expect(root.getAttribute("data-stage")).toBe("album");
    expect(root.style.getPropertyValue("--bg")).toBe("");
  });

  it("produces visibly different solid --bg for a white cover vs a red cover and updates when track changes", () => {
    const whiteTrack = createTrack("rihanna-white", {
      title: "Breakin' Dishes",
      artist: "Rihanna",
      album: "Good Girl Gone Bad",
    });
    const redTrack = createTrack("megan-red", {
      title: "Thot Shit",
      artist: "Megan Thee Stallion",
      album: "Something for Thee Hotties",
    });

    const whitePixels = new Uint8ClampedArray(32 * 32 * 4).fill(252);
    const redPixels = new Uint8ClampedArray(32 * 32 * 4);
    for (let i = 0; i < redPixels.length; i += 4) {
      redPixels[i] = 215;
      redPixels[i + 1] = 20;
      redPixels[i + 2] = 32;
      redPixels[i + 3] = 255;
    }

    const whiteKey = getTrackPaletteKey(whiteTrack);
    const redKey = getTrackPaletteKey(redTrack);
    const whitePalette = selectSolidPalette(extractClustersFromPixels(whitePixels), whiteKey);
    const redPalette = selectSolidPalette(extractClustersFromPixels(redPixels), redKey);
    setCachedPalette(whiteKey, whitePalette);
    setCachedPalette(redKey, redPalette);

    useLibraryStore.setState({ tracks: [whiteTrack, redTrack], playlists: [], status: "ready", loadError: null });
    usePlaybackStore.setState({ currentTrackId: "rihanna-white" });

    const { rerender } = render(
      <MemoryRouter initialEntries={["/now-playing?lyrics=1"]}>
        <NowPlayingPage />
      </MemoryRouter>,
    );

    const root = screen.getByRole("region", { name: "Now playing" });
    const whiteBg = root.style.getPropertyValue("--bg");
    expect(whiteBg).toBe(whitePalette.bg);
    expect(root.getAttribute("data-cover-category")).toBe("light");

    act(() => {
      usePlaybackStore.setState({ currentTrackId: "megan-red" });
    });
    rerender(
      <MemoryRouter initialEntries={["/now-playing?lyrics=1"]}>
        <NowPlayingPage />
      </MemoryRouter>,
    );

    const redBg = root.style.getPropertyValue("--bg");
    expect(redBg).toBe(redPalette.bg);
    expect(redBg).not.toBe(whiteBg);
    expect(root.getAttribute("data-cover-category")).toBe("saturated");
  });

  it("does not render any ambient canvas, animated blobs, or .gm-ambient elements", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/now-playing?lyrics=1"]}>
        <NowPlayingPage />
      </MemoryRouter>,
    );

    expect(container.querySelectorAll("canvas").length).toBe(0);
    expect(container.querySelectorAll(".gm-ambient").length).toBe(0);
    expect(container.querySelectorAll("[data-ambient]").length).toBe(0);
    expect(container.querySelectorAll(".lyrics-bg-blob").length).toBe(0);
  });

  it("renders track title, artist, artwork, and playback controls in Now Playing mode", () => {
    render(
      <MemoryRouter initialEntries={["/now-playing"]}>
        <NowPlayingPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "Test Song" })).toBeTruthy();
    expect(screen.getByText("Test Artist")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close Now Playing" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "More options" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add to liked songs" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Seek" })).toBeTruthy();
    expect(screen.getByText("0:30")).toBeTruthy();
    expect(screen.getByText("3:00")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Pause/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous track" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next track" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enable shuffle" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enable repeat all" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show lyrics" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open queue" })).toBeTruthy();
  });

  it("wires playback controls, favorite, seek bar, queue, and overflow Share action in Now Playing mode", () => {
    const togglePlay = vi.fn();
    const previous = vi.fn();
    const next = vi.fn();
    const toggleShuffle = vi.fn();
    const cycleRepeat = vi.fn();
    const seek = vi.fn();
    const toggleLike = vi.fn().mockResolvedValue(undefined);

    usePlaybackStore.setState({
      togglePlay,
      previous,
      next,
      toggleShuffle,
      cycleRepeat,
      seek,
    });
    useLibraryStore.setState({ toggleLike });

    render(
      <MemoryRouter initialEntries={["/now-playing"]}>
        <NowPlayingPage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(togglePlay).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Previous track" }));
    expect(previous).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Next track" }));
    expect(next).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByRole("button", { name: "Enable shuffle" }));
    expect(toggleShuffle).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Enable repeat all" }));
    expect(cycleRepeat).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Add to liked songs" }));
    expect(toggleLike).toHaveBeenCalledWith("track-1");

    // Seek via pointer down + up on the SeekBar slider
    const slider = screen.getByRole("slider", { name: "Seek" });
    fireEvent(slider, Object.assign(new Event("pointerdown", { bubbles: true }), { clientX: 100, pointerId: 1 }));
    fireEvent(slider, Object.assign(new Event("pointerup", { bubbles: true }), { clientX: 100, pointerId: 1 }));
    expect(seek).toHaveBeenCalledWith(90000);

    // Open overflow menu and verify Share is inside the menu (not standalone on the bottom bar)
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    const shareItem = screen.getByRole("menuitem", { name: "Share" });
    expect(shareItem).toBeTruthy();
    fireEvent.click(shareItem);

    // Open queue panel
    fireEvent.click(screen.getByRole("button", { name: "Open queue" }));
    expect(screen.getByRole("complementary", { name: "Play queue" })).toBeTruthy();
  });

  it("transitions between Now Playing and Fullscreen Lyrics modes while hiding extra controls and preserving playback", () => {
    const togglePlay = vi.fn();
    usePlaybackStore.setState({ togglePlay });

    render(
      <MemoryRouter initialEntries={["/now-playing"]}>
        <NowPlayingPage />
      </MemoryRouter>,
    );

    // Click bottom-center Lyrics button -> transitions to Fullscreen Lyrics
    fireEvent.click(screen.getByRole("button", { name: "Show lyrics" }));

    const root = screen.getByRole("region", { name: "Now playing" });
    expect(root.getAttribute("data-stage")).toBe("lyrics");

    // Header has downward chevron ("Hide lyrics") and centered track title + artist
    expect(screen.getByRole("button", { name: "Hide lyrics" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Test Song" })).toBeTruthy();
    expect(screen.getByText("Test Artist")).toBeTruthy();

    // Retains only progress bar (with elapsed & duration) and central Play/Pause button
    expect(screen.getByRole("slider", { name: "Seek" })).toBeTruthy();
    expect(screen.getByText("0:30")).toBeTruthy();
    expect(screen.getByText("3:00")).toBeTruthy();
    const pauseBtn = screen.getByRole("button", { name: "Pause" });
    expect(pauseBtn).toBeTruthy();
    fireEvent.click(pauseBtn);
    expect(togglePlay).toHaveBeenCalledTimes(1);

    // Hides artwork, favorite, shuffle, previous/next, repeat, queue, and three-dot menu in Fullscreen Lyrics mode
    expect(screen.queryByRole("button", { name: "More options" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add to liked songs" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Enable shuffle" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Previous track" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next track" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Enable repeat all" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open queue" })).toBeNull();
    expect(screen.queryByAltText("Test Song artwork")).toBeNull();

    // Clicking downward chevron returns to Now Playing without interrupting playback
    fireEvent.click(screen.getByRole("button", { name: "Hide lyrics" }));
    expect(root.getAttribute("data-stage")).toBe("album");
    expect(screen.getByRole("button", { name: "Show lyrics" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous track" })).toBeTruthy();
    expect(usePlaybackStore.getState().currentTimeMs).toBe(30000);
    expect(usePlaybackStore.getState().isPlaying).toBe(true);
  });

  it("closes Now Playing with X button or Escape key without stopping playback", () => {
    render(
      <MemoryRouter initialEntries={["/now-playing"]}>
        <NowPlayingPage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close Now Playing" }));
    expect(mockNavigate).toHaveBeenCalledWith(-1);
    expect(usePlaybackStore.getState().isPlaying).toBe(true);

    mockNavigate.mockClear();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });

  it("renders lightweight AmbientRainDrops only when enabled in Now Playing mode, unmounts when disabled or in Lyrics mode, and respects reduced motion", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/now-playing"]}>
        <NowPlayingPage />
      </MemoryRouter>,
    );

    // Default state is OFF: zero rain elements or canvas
    expect(screen.queryByTestId("ambient-rain-drops")).toBeNull();
    expect(container.querySelectorAll("[data-raindrop]").length).toBe(0);
    expect(container.querySelectorAll("canvas").length).toBe(0);

    // Turn ON -> immediately renders 10 lightweight droplets (between 6 and 12)
    act(() => {
      useSettingsStore.getState().update({ ambientRainDrops: true });
    });

    const layer = screen.getByTestId("ambient-rain-drops");
    expect(layer).toBeTruthy();
    expect(layer.className).toContain("pointer-events-none");
    expect(layer.getAttribute("data-reduced-motion")).toBe("false");
    const droplets = container.querySelectorAll("[data-raindrop]");
    expect(droplets.length).toBeGreaterThanOrEqual(6);
    expect(droplets.length).toBeLessThanOrEqual(12);
    expect(container.querySelectorAll("canvas").length).toBe(0);

    // Respects reduced motion: disables continuous animations
    act(() => {
      useSettingsStore.getState().update({ reducedMotion: "on" });
    });
    expect(screen.getByTestId("ambient-rain-drops").getAttribute("data-reduced-motion")).toBe("true");
    expect((droplets[0] as HTMLElement).style.animation).toBe("none");

    // Switching to Fullscreen Lyrics unmounts the rain droplets
    fireEvent.click(screen.getByRole("button", { name: "Show lyrics" }));
    expect(screen.queryByTestId("ambient-rain-drops")).toBeNull();

    // Return to Now Playing -> droplets reappear while setting is ON
    fireEvent.click(screen.getByRole("button", { name: "Hide lyrics" }));
    expect(screen.getByTestId("ambient-rain-drops")).toBeTruthy();

    // Turn OFF -> immediately removes all droplet elements
    act(() => {
      useSettingsStore.getState().update({ ambientRainDrops: false });
    });
    expect(screen.queryByTestId("ambient-rain-drops")).toBeNull();
    expect(container.querySelectorAll("[data-raindrop]").length).toBe(0);
  });

  it("toggles Ambient Rain Drops from the Appearance section in SettingsPage", () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("Ambient Rain Drops")).toBeTruthy();
    expect(screen.getByText("Show subtle animated water droplets in the Now Playing background.")).toBeTruthy();

    const toggle = screen.getByRole("switch", { name: "Ambient Rain Drops" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);
    expect(useSettingsStore.getState().prefs.ambientRainDrops).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);
    expect(useSettingsStore.getState().prefs.ambientRainDrops).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});
