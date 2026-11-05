import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { NowPlayingPage } from "./NowPlayingPage";
import { useLibraryStore } from "../../stores/libraryStore";
import { usePlaybackStore } from "../../stores/playbackStore";
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
    });
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

  it("renders track title, artist, artwork, and playback controls", () => {
    render(
      <MemoryRouter>
        <NowPlayingPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "Test Song" })).toBeTruthy();
    expect(screen.getByText("Test Artist")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Pause/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous track" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next track" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enable shuffle" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enable repeat all" })).toBeTruthy();
  });

  it("navigates back when Escape key is pressed", () => {
    render(
      <MemoryRouter>
        <NowPlayingPage />
      </MemoryRouter>,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });
});
