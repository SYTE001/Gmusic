import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { NowPlayingPage } from "./NowPlayingPage";
import { useLibraryStore } from "../../stores/libraryStore";
import { usePlaybackStore } from "../../stores/playbackStore";
import type { Track } from "../../types";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function createTrack(id: string = "track-1"): Track {
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
  };
}

describe("NowPlayingPage component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("mounts with solid neutral bg-app-bg on root container in Stage 1 (album only)", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/now-playing"]}>
        <NowPlayingPage />
      </MemoryRouter>,
    );

    const root = screen.getByRole("region", { name: "Now playing" });
    expect(root).toBeTruthy();
    expect(root.className).toContain("bg-app-bg");
    expect(root.getAttribute("data-stage")).toBe("album");
    // Stage 1 has no adaptive background mounted
    expect(container.querySelector(".lyrics-bg-container")).toBeNull();
  });

  it("mounts full-screen LyricsBackground in Stage 2 and fades out before unmounting on return to Stage 1", () => {
    vi.useFakeTimers();

    const { container } = render(
      <MemoryRouter initialEntries={["/now-playing?lyrics=1"]}>
        <NowPlayingPage />
      </MemoryRouter>,
    );

    const root = screen.getByRole("region", { name: "Now playing" });
    expect(root.getAttribute("data-stage")).toBe("lyrics");
    expect(root.getAttribute("data-theme")).toBe("dark");

    const bg = container.querySelector(".lyrics-bg-container") as HTMLElement | null;
    expect(bg).not.toBeNull();

    // Toggle back to Stage 1 (Hide lyrics)
    const hideBtn = screen.getByRole("button", { name: "Hide lyrics" });
    fireEvent.click(hideBtn);

    expect(root.getAttribute("data-stage")).toBe("album");
    // Still mounted during 500ms fade-out with opacity 0
    const bgFading = container.querySelector(".lyrics-bg-container") as HTMLElement | null;
    expect(bgFading).not.toBeNull();
    expect(bgFading?.style.opacity).toBe("0");

    // Unmounts after 500ms fade-out completes
    act(() => {
      vi.advanceTimersByTime(520);
    });
    expect(container.querySelector(".lyrics-bg-container")).toBeNull();

    vi.useRealTimers();
  });

  it("does not render any ambient canvas, sheen, or .gm-ambient elements", () => {
    const { container } = render(
      <MemoryRouter>
        <NowPlayingPage />
      </MemoryRouter>,
    );

    expect(container.querySelectorAll("canvas").length).toBe(0);
    expect(container.querySelectorAll(".gm-ambient").length).toBe(0);
    expect(container.querySelectorAll("[data-ambient]").length).toBe(0);
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
