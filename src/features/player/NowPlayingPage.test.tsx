import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { NowPlayingPage } from "./NowPlayingPage";
import { MiniPlayer } from "../../components/MiniPlayer";
import { clearArtworkCache, setCachedArtworkForTrack } from "../../components/Artwork";
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

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { writable: true, configurable: true, value: height });
  window.dispatchEvent(new Event("resize"));
}

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
    clearArtworkCache();
    setViewport(390, 844);
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

  it("renders track title, artist, artwork, and playback controls in Mobile Now Playing mode", () => {
    setViewport(390, 844);
    render(
      <MemoryRouter initialEntries={["/now-playing"]}>
        <NowPlayingPage />
      </MemoryRouter>,
    );

    const root = screen.getByRole("region", { name: "Now playing" });
    expect(root.getAttribute("data-viewport")).toBe("mobile");
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

  it("wires playback controls, favorite, seek bar, queue, and overflow Share action in Mobile Now Playing mode", () => {
    setViewport(412, 915);
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

  it("transitions between Mobile Now Playing and Fullscreen Lyrics modes while hiding extra controls and preserving playback", () => {
    setViewport(390, 844);
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

  it("uses explicit navigation actions so downward chevron returns to Now Playing without closing and X button closes player without navigating to lyrics", () => {
    setViewport(390, 844);
    mockNavigate.mockClear();
    const { unmount } = render(
      <MemoryRouter initialEntries={["/now-playing"]}>
        <NowPlayingPage />
      </MemoryRouter>,
    );

    const root = screen.getByRole("region", { name: "Now playing" });
    expect(root.getAttribute("data-stage")).toBe("album");

    // 1. Click Lyrics button -> enters Fullscreen Lyrics mode
    fireEvent.click(screen.getByRole("button", { name: "Show lyrics" }));
    expect(root.getAttribute("data-stage")).toBe("lyrics");
    const chevronBtn = screen.getByRole("button", { name: "Hide lyrics" });
    expect(chevronBtn.getAttribute("title")).toBe("Return to Now Playing");

    // 2. Click downward chevron -> returns to Now Playing mode, does NOT close player (no navigate(-1))
    fireEvent.click(chevronBtn);
    expect(root.getAttribute("data-stage")).toBe("album");
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Show lyrics" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close Now Playing" })).toBeTruthy();

    // 3. Click X button -> closes fullscreen player via navigate(-1), does NOT navigate to Lyrics
    fireEvent.click(screen.getByRole("button", { name: "Close Now Playing" }));
    expect(mockNavigate).toHaveBeenCalledWith(-1);
    expect(mockNavigate).not.toHaveBeenCalledWith(expect.stringContaining("lyrics"));
    expect(usePlaybackStore.getState().isPlaying).toBe(true);
    expect(usePlaybackStore.getState().currentTimeMs).toBe(30000);

    // 4. Reopen Now Playing -> opens fresh in Now Playing mode, not Lyrics mode
    unmount();
    render(
      <MemoryRouter initialEntries={["/now-playing"]}>
        <NowPlayingPage />
      </MemoryRouter>,
    );
    const reopenedRoot = screen.getByRole("region", { name: "Now playing" });
    expect(reopenedRoot.getAttribute("data-stage")).toBe("album");
    expect(screen.getByRole("button", { name: "Show lyrics" })).toBeTruthy();
  });

  it("renders original Desktop player layout at >= 768px (768x1024, 1366x768, 1920x1080) with side-by-side artwork and lyrics in Stage 2", () => {
    for (const [width, height] of [
      [768, 1024],
      [1366, 768],
      [1920, 1080],
    ] as const) {
      setViewport(width, height);
      const { unmount } = render(
        <MemoryRouter initialEntries={["/now-playing"]}>
          <NowPlayingPage />
        </MemoryRouter>,
      );

      const root = screen.getByRole("region", { name: "Now playing" });
      expect(root.getAttribute("data-viewport")).toBe("desktop");
      expect(root.getAttribute("data-stage")).toBe("album");

      // Desktop top bar has Close button on left and Lyrics toggle button with aria-pressed on right (no mobile More options menu)
      expect(screen.getByRole("button", { name: "Close Now Playing" })).toBeTruthy();
      const lyricsToggle = screen.getByRole("button", { name: "Show lyrics" });
      expect(lyricsToggle.getAttribute("aria-pressed")).toBe("false");
      expect(screen.queryByRole("button", { name: "More options" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Open queue" })).toBeNull();

      // Toggle lyrics on desktop -> enters Stage 2 with side-by-side artwork + controls AND lyrics simultaneously
      fireEvent.click(lyricsToggle);
      expect(root.getAttribute("data-stage")).toBe("lyrics");
      const hideLyricsBtn = screen.getByRole("button", { name: "Hide lyrics" });
      expect(hideLyricsBtn.getAttribute("aria-pressed")).toBe("true");
      // Desktop keeps album artwork and transport controls visible alongside lyrics
      expect(screen.getByRole("img", { name: /Test Song artwork/i })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Previous track" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Next track" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Enable shuffle" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Enable repeat all" })).toBeTruthy();

      unmount();
    }
  });

  it("handles responsive transitions between Desktop (1366x768) and Mobile (390x844) without interrupting playback or duplicating controls", () => {
    setViewport(1366, 768);
    render(
      <MemoryRouter initialEntries={["/now-playing"]}>
        <NowPlayingPage />
      </MemoryRouter>,
    );

    const root = screen.getByRole("region", { name: "Now playing" });
    expect(root.getAttribute("data-viewport")).toBe("desktop");
    expect(screen.getAllByRole("slider", { name: "Seek" }).length).toBe(1);

    // Resize Desktop -> Mobile (390x844)
    act(() => {
      setViewport(390, 844);
    });
    expect(root.getAttribute("data-viewport")).toBe("mobile");
    expect(screen.getAllByRole("slider", { name: "Seek" }).length).toBe(1);
    expect(screen.getByRole("button", { name: "More options" })).toBeTruthy();

    // Open mobile queue panel, then resize Mobile -> Desktop (1920x1080)
    fireEvent.click(screen.getByRole("button", { name: "Open queue" }));
    expect(screen.getByRole("complementary", { name: "Play queue" })).toBeTruthy();

    act(() => {
      setViewport(1920, 1080);
    });
    expect(root.getAttribute("data-viewport")).toBe("desktop");
    expect(screen.queryByRole("complementary", { name: "Play queue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "More options" })).toBeNull();
    expect(screen.getAllByRole("slider", { name: "Seek" }).length).toBe(1);
    expect(usePlaybackStore.getState().currentTrackId).toBe("track-1");
    expect(usePlaybackStore.getState().currentTimeMs).toBe(30000);
    expect(usePlaybackStore.getState().isPlaying).toBe(true);
  });

  it("renders full-bleed artwork background and blurred overlay on Mobile when active track has artwork", () => {
    setViewport(390, 844);
    setCachedArtworkForTrack("track-1", "blob:test-cover-1");

    const { container } = render(
      <MemoryRouter initialEntries={["/now-playing"]}>
        <NowPlayingPage />
      </MemoryRouter>,
    );

    const artworkLayer = container.querySelector('[data-mobile-artwork-layer="true"]');
    expect(artworkLayer).toBeTruthy();
    const img = screen.getByAltText("Test Song artwork") as HTMLImageElement;
    expect(img.src).toContain("blob:test-cover-1");
    expect(img.className).toContain("object-cover");

    const overlay = container.querySelector('[data-mobile-player-overlay="true"]');
    expect(overlay).toBeTruthy();
    expect(overlay?.className).toContain("mobile-player-overlay");
    expect(container.querySelector('[data-has-artwork="true"]')).toBeTruthy();
  });

  it("renders theme fallback without artwork layer, broken img, or blur when track has no artwork", () => {
    setViewport(390, 844);
    const { container } = render(
      <MemoryRouter initialEntries={["/now-playing"]}>
        <NowPlayingPage />
      </MemoryRouter>,
    );

    const root = screen.getByRole("region", { name: "Now playing" });
    expect(root.className).toContain("bg-app-bg");
    expect(container.querySelector('[data-has-artwork="false"]')).toBeTruthy();
    expect(container.querySelector("[data-mobile-artwork-layer]")).toBeNull();
    expect(container.querySelector(".mobile-player-overlay")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("immediately clears previous artwork and switches to fallback when changing to a track without artwork", () => {
    setViewport(390, 844);
    const track1 = createTrack("track-1", { title: "With Art" });
    const track2 = createTrack("track-2", { title: "Without Art" });
    useLibraryStore.setState({ tracks: [track1, track2], playlists: [], status: "ready", loadError: null });
    usePlaybackStore.setState({ currentTrackId: "track-1", queueTrackIds: ["track-1", "track-2"] });
    setCachedArtworkForTrack("track-1", "blob:test-cover-1");

    const { container, rerender } = render(
      <MemoryRouter initialEntries={["/now-playing"]}>
        <NowPlayingPage />
      </MemoryRouter>,
    );

    expect(screen.getByAltText("With Art artwork")).toBeTruthy();
    expect(container.querySelector('[data-has-artwork="true"]')).toBeTruthy();

    act(() => {
      usePlaybackStore.setState({ currentTrackId: "track-2", queueIndex: 1 });
    });
    rerender(
      <MemoryRouter initialEntries={["/now-playing"]}>
        <NowPlayingPage />
      </MemoryRouter>,
    );

    expect(screen.queryByAltText("With Art artwork")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.querySelector('[data-has-artwork="false"]')).toBeTruthy();
    expect(container.querySelector(".mobile-player-overlay")).toBeNull();
  });

  it("falls back to no-artwork state when the artwork image errors", () => {
    setViewport(390, 844);
    setCachedArtworkForTrack("track-1", "blob:broken-cover");

    const { container } = render(
      <MemoryRouter initialEntries={["/now-playing"]}>
        <NowPlayingPage />
      </MemoryRouter>,
    );

    const img = screen.getByAltText("Test Song artwork");
    fireEvent.error(img);

    expect(screen.queryByRole("img")).toBeNull();
    expect(container.querySelector('[data-has-artwork="false"]')).toBeTruthy();
    expect(container.querySelector(".mobile-player-overlay")).toBeNull();
  });
});
