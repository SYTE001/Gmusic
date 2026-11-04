import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { PlaylistDetailPage } from "./PlaylistDetailPage";
import { useLibraryStore } from "../../stores/libraryStore";
import { usePlaybackStore } from "../../stores/playbackStore";
import type { Playlist, Track } from "../../types";

function createMockTrack(id: string, title: string, artist: string, durationMs: number): Track {
  return {
    id,
    title,
    artist,
    album: "Test Album",
    trackNumber: 1,
    albumTrackCount: 10,
    durationMs,
    fileName: `${id}.mp3`,
    fileSize: 4096000,
    mimeType: "audio/mpeg",
    addedAt: 1672531200000,
    lastPlayedAt: null,
    playCount: 0,
    isLiked: false,
    availability: "available",
    accessMode: "stored-copy",
    fingerprint: `fp-${id}`,
    metadataFromFilename: false,
  };
}

describe("PlaylistDetailPage alignment and reorder tests", () => {
  const track1 = createMockTrack("t1", "Track One", "Artist One", 183000); // 3:03
  const track2 = createMockTrack("t2", "Track Two With Very Long Title Indeed", "Artist Two", 197000); // 3:17
  const track3 = createMockTrack("t3", "Track Three", "Artist Three", 146000); // 2:26

  const mockPlaylist: Playlist = {
    id: "pl-1",
    name: "My Chill Vibes",
    description: "Great tunes",
    trackIds: ["t1", "t2", "t3"],
    createdAt: 1672531200000,
    updatedAt: 1672531200000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useLibraryStore.setState({
      tracks: [track1, track2, track3],
      playlists: [mockPlaylist],
      status: "ready",
      loadError: null,
      reorderPlaylist: vi.fn(),
      toggleLike: vi.fn(),
    });
    usePlaybackStore.setState({
      currentTrackId: null,
      isPlaying: false,
      status: "idle",
      playTrackFromContext: vi.fn(),
    });
  });

  function renderPage() {
    return render(
      <MemoryRouter initialEntries={["/playlists/pl-1"]}>
        <Routes>
          <Route path="/playlists/:id" element={<PlaylistDetailPage />} />
        </Routes>
      </MemoryRouter>
    );
  }

  it("renders stable w-14 slot for reorder buttons across every row", () => {
    const { container } = renderPage();

    // Find all reorder containers
    const reorderContainers = container.querySelectorAll(".w-14.shrink-0");
    expect(reorderContainers.length).toBe(3);

    // Verify row 1 has move up invisible/disabled and move down enabled
    const row1Up = screen.getByRole("button", { name: "Move Track One up" });
    const row1Down = screen.getByRole("button", { name: "Move Track One down" });
    expect(row1Up.className).toContain("invisible");
    expect(row1Up.hasAttribute("disabled")).toBe(true);
    expect(row1Down.className).not.toContain("invisible");
    expect(row1Down.hasAttribute("disabled")).toBe(false);

    // Verify middle row has both buttons visible/enabled
    const row2Up = screen.getByRole("button", { name: /Move Track Two.*up/i });
    const row2Down = screen.getByRole("button", { name: /Move Track Two.*down/i });
    expect(row2Up.className).not.toContain("invisible");
    expect(row2Up.hasAttribute("disabled")).toBe(false);
    expect(row2Down.className).not.toContain("invisible");
    expect(row2Down.hasAttribute("disabled")).toBe(false);

    // Verify last row has move down invisible/disabled and move up enabled
    const row3Up = screen.getByRole("button", { name: "Move Track Three up" });
    const row3Down = screen.getByRole("button", { name: "Move Track Three down" });
    expect(row3Up.className).not.toContain("invisible");
    expect(row3Up.hasAttribute("disabled")).toBe(false);
    expect(row3Down.className).toContain("invisible");
    expect(row3Down.hasAttribute("disabled")).toBe(true);
  });

  it("triggers reorderPlaylist when clicking move buttons", () => {
    const reorderSpy = vi.fn();
    useLibraryStore.setState({ reorderPlaylist: reorderSpy });

    renderPage();

    const row1Down = screen.getByRole("button", { name: "Move Track One down" });
    fireEvent.click(row1Down);
    expect(reorderSpy).toHaveBeenCalledWith("pl-1", 0, 1);

    const row2Up = screen.getByRole("button", { name: /Move Track Two.*up/i });
    fireEvent.click(row2Up);
    expect(reorderSpy).toHaveBeenCalledWith("pl-1", 1, 0);
  });

  it("renders duration, favorite button, and menu button with consistent classes in every row", () => {
    renderPage();

    expect(screen.getByText("3:03")).toBeDefined();
    expect(screen.getByText("3:17")).toBeDefined();
    expect(screen.getByText("2:26")).toBeDefined();

    const fav1 = screen.getByRole("button", { name: "Add Track One to liked songs" });
    const fav2 = screen.getByRole("button", { name: /Add Track Two.*to liked songs/i });
    const fav3 = screen.getByRole("button", { name: "Add Track Three to liked songs" });

    expect(fav1.className).toContain("size-8");
    expect(fav2.className).toContain("size-8");
    expect(fav3.className).toContain("size-8");

    const menu1 = screen.getByRole("button", { name: "More actions for Track One" });
    const menu2 = screen.getByRole("button", { name: /More actions for Track Two/i });
    const menu3 = screen.getByRole("button", { name: "More actions for Track Three" });

    expect(menu1.className).toContain("size-8");
    expect(menu2.className).toContain("size-8");
    expect(menu3.className).toContain("size-8");
  });

  it("renders header action buttons with smooth squircle rounded-[14px] and size-10 styling", () => {
    renderPage();

    const shuffleBtn = screen.getByRole("button", { name: "Shuffle play playlist" });
    const addBtn = screen.getByRole("button", { name: "Add songs to this playlist" });

    expect(shuffleBtn.className).toContain("size-10");
    expect(shuffleBtn.className).toContain("rounded-[14px]");
    expect(shuffleBtn.className).toContain("border");

    expect(addBtn.className).toContain("size-10");
    expect(addBtn.className).toContain("rounded-[14px]");
    expect(addBtn.className).toContain("border");
  });
});
