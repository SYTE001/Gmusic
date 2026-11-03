import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TrackRow } from "./TrackRow";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlaybackStore } from "../stores/playbackStore";
import type { PlaybackContext, Track } from "../types";

function createTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: "track-1",
    title: "Midnight City",
    artist: "M83",
    album: "Hurry Up, We're Dreaming",
    trackNumber: 1,
    albumTrackCount: 12,
    durationMs: 243000, // 4:03
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

const mockContext: PlaybackContext = {
  type: "library",
  label: "All Songs",
};

describe("TrackRow component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useLibraryStore.setState({
      tracks: [createTrack()],
      playlists: [],
      status: "ready",
      loadError: null,
      toggleLike: vi.fn(),
    });
    usePlaybackStore.setState({
      currentTrackId: null,
      isPlaying: false,
      status: "idle",
      playTrackFromContext: vi.fn(),
    });
  });

  it("renders track identity with title, artist, artwork, and index", () => {
    const track = createTrack();
    render(
      <TrackRow
        track={track}
        contextTrackIds={[track.id]}
        context={mockContext}
        index={1}
      />
    );

    expect(screen.getByText("Midnight City")).toBeDefined();
    expect(screen.getByText("M83")).toBeDefined();
    expect(screen.getByText("1")).toBeDefined();
    expect(screen.getByText("4:03")).toBeDefined();
  });

  it("renders consistent 32x32px hitboxes for favorite and context menu buttons", () => {
    const track = createTrack();
    render(
      <TrackRow
        track={track}
        contextTrackIds={[track.id]}
        context={mockContext}
      />
    );

    const likeButton = screen.getByRole("button", { name: /Add Midnight City to liked songs/i });
    const menuButton = screen.getByRole("button", { name: /More actions for Midnight City/i });

    expect(likeButton.className).toContain("size-8");
    expect(menuButton.className).toContain("size-8");
  });

  it("toggles favorite without triggering row playback", () => {
    const toggleLike = vi.fn();
    const playTrackFromContext = vi.fn();
    useLibraryStore.setState({ toggleLike });
    usePlaybackStore.setState({ playTrackFromContext });

    const track = createTrack();
    render(
      <TrackRow
        track={track}
        contextTrackIds={[track.id]}
        context={mockContext}
      />
    );

    const likeButton = screen.getByRole("button", { name: /Add Midnight City to liked songs/i });
    fireEvent.click(likeButton);

    expect(toggleLike).toHaveBeenCalledWith("track-1");
    expect(playTrackFromContext).not.toHaveBeenCalled();
  });

  it("opens context menu without triggering row playback", () => {
    const playTrackFromContext = vi.fn();
    usePlaybackStore.setState({ playTrackFromContext });

    const track = createTrack();
    render(
      <TrackRow
        track={track}
        contextTrackIds={[track.id]}
        context={mockContext}
      />
    );

    const menuButton = screen.getByRole("button", { name: /More actions for Midnight City/i });
    fireEvent.click(menuButton);

    expect(menuButton.getAttribute("aria-expanded")).toBe("true");
    expect(playTrackFromContext).not.toHaveBeenCalled();
  });

  it("clicking row triggers playback with context", () => {
    const playTrackFromContext = vi.fn();
    usePlaybackStore.setState({ playTrackFromContext });

    const track = createTrack();
    render(
      <TrackRow
        track={track}
        contextTrackIds={[track.id]}
        context={mockContext}
      />
    );

    const row = screen.getByRole("listitem");
    fireEvent.click(row);

    expect(playTrackFromContext).toHaveBeenCalledWith("track-1", ["track-1"], mockContext);
  });

  it("renders album and date added with fixed width column classes", () => {
    const track = createTrack();
    render(
      <TrackRow
        track={track}
        contextTrackIds={[track.id]}
        context={mockContext}
        showAlbum={true}
        showAdded={true}
      />
    );

    const album = screen.getByText("Hurry Up, We're Dreaming");
    expect(album.className).toContain("w-44");
    expect(album.className).toContain("shrink-0");

    const date = screen.getByText(/2023|Jan/i);
    expect(date.className).toContain("w-24");
    expect(date.className).toContain("shrink-0");
  });

  it("applies active styling when track is current playing", () => {
    const track = createTrack();
    usePlaybackStore.setState({
      currentTrackId: "track-1",
      isPlaying: true,
    });

    render(
      <TrackRow
        track={track}
        contextTrackIds={[track.id]}
        context={mockContext}
      />
    );

    const row = screen.getByRole("listitem");
    expect(row.className).toContain("bg-surface-raised");

    const title = screen.getByText("Midnight City");
    expect(title.className).toContain("text-accent");
  });
});
