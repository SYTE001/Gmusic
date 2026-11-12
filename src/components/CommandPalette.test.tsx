import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AppShell } from "./AppShell";
import { HomePage } from "../features/home/HomePage";
import { LibraryPage } from "../features/library/LibraryPage";
import { PlaylistDetailPage } from "../features/playlists/PlaylistDetailPage";
import { useLibraryStore } from "../stores/libraryStore";
import { bindPlaybackHelpers, usePlaybackStore } from "../stores/playbackStore";
import { repository } from "../services/indexeddb/LibraryRepository";
import type { Playlist, Track } from "../types";

function createTestTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: "t-aurora",
    title: "Aurora Borealis",
    artist: "Solaris",
    album: "Northern Skies",
    trackNumber: 1,
    albumTrackCount: 8,
    durationMs: 210000,
    fileName: "aurora_borealis.flac",
    fileSize: 5000,
    mimeType: "audio/flac",
    addedAt: Date.now(),
    lastPlayedAt: null,
    playCount: 0,
    isLiked: false,
    availability: "available",
    accessMode: "stored-copy",
    fingerprint: null,
    metadataFromFilename: false,
    ...overrides,
  };
}

describe("CommandPalette integration in AppShell", () => {
  let track: Track;
  let playlist: Playlist;

  beforeEach(async () => {
    vi.clearAllMocks();
    await repository.clearAllData();
    track = createTestTrack();
    playlist = {
      id: "pl-night",
      name: "Night Drive",
      description: "",
      trackIds: [track.id],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    useLibraryStore.setState({
      tracks: [track],
      playlists: [playlist],
      status: "ready",
      loadError: null,
      toggleLike: vi.fn(),
    });

    bindPlaybackHelpers({
      getTrackForPlayback: async (id) => (id === track.id ? track : undefined),
      currentTrack: () => track,
      notifyTrackStarted: async () => undefined,
      markTrackAvailability: async () => undefined,
      persistPrefs: () => undefined,
      persistPosition: () => undefined,
    });

    usePlaybackStore.getState().setEngineForTests({
      element: null,
      setSource: () => undefined,
      play: async () => undefined,
      pause: () => undefined,
      get currentTimeSec() {
        return 10;
      },
      seekSec: () => undefined,
      get durationSec() {
        return 210;
      },
      setVolume: () => undefined,
      setMuted: () => undefined,
      dispose: () => undefined,
    });

    usePlaybackStore.setState({
      currentTrackId: track.id,
      isPlaying: false,
      isBuffering: false,
      status: "ready",
      volume: 0.8,
      isMuted: false,
      shuffleEnabled: false,
      repeatMode: "off",
      currentTimeMs: 10000,
      durationMs: 210000,
      queueTrackIds: [track.id],
      queueIndex: 0,
    });
  });

  afterEach(() => {
    cleanup();
  });

  function renderShell() {
    return render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<HomePage />} />
            <Route path="library" element={<LibraryPage />} />
            <Route path="playlist/:id" element={<PlaylistDetailPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
  }

  it("opens on Ctrl+K and Meta+K, focuses the input, and restores focus to trigger on Escape", () => {
    renderShell();
    expect(screen.queryByRole("dialog", { name: "Command Palette" })).toBeNull();

    const triggerBtn = screen.getByRole("button", { name: "Quick Actions" });
    triggerBtn.focus();
    expect(document.activeElement).toBe(triggerBtn);

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const dialog = screen.getByRole("dialog", { name: "Command Palette" });
    expect(dialog).toBeTruthy();

    const input = screen.getByRole("combobox", { name: /Search songs, playlists, or commands/i });
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Command Palette" })).toBeNull();
    expect(document.activeElement).toBe(triggerBtn);

    // Also opens with Meta+K
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByRole("dialog", { name: "Command Palette" })).toBeTruthy();
  });

  it("opens via the visible Quick Actions button in the header/sidebar", () => {
    renderShell();
    const triggerBtn = screen.getByRole("button", { name: "Quick Actions" });
    fireEvent.click(triggerBtn);
    expect(screen.getByRole("dialog", { name: "Command Palette" })).toBeTruthy();
  });

  it("navigates results with ArrowDown/ArrowUp and activates with Enter", async () => {
    renderShell();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    const input = screen.getByRole("combobox", { name: /Search songs, playlists, or commands/i });
    fireEvent.change(input, { target: { value: "Open Library" } });

    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
    expect(options[0].getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command Palette" })).toBeNull();
    });
    expect(await screen.findByRole("heading", { name: "Library" })).toBeTruthy();
  });

  it("searches tracks by title, artist, album, or filename and starts playback on selection", async () => {
    const playTrackSpy = vi.spyOn(usePlaybackStore.getState(), "playTrackFromContext");
    renderShell();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    const dialog = screen.getByRole("dialog", { name: "Command Palette" });
    const input = screen.getByRole("combobox", { name: /Search songs, playlists, or commands/i });
    fireEvent.change(input, { target: { value: "aurora_borealis" } });

    const trackItem = within(dialog).getByText("Aurora Borealis");
    expect(trackItem).toBeTruthy();
    fireEvent.click(trackItem);

    expect(playTrackSpy).toHaveBeenCalledWith(
      "t-aurora",
      ["t-aurora"],
      expect.objectContaining({ type: "search" }),
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command Palette" })).toBeNull();
    });
  });

  it("opens Create Playlist modal when Create Playlist command is executed", async () => {
    renderShell();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    const input = screen.getByRole("combobox", { name: /Search songs, playlists, or commands/i });
    fireEvent.change(input, { target: { value: "Create Playlist" } });

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Command Palette" })).toBeNull();
    });
    expect(screen.getByRole("dialog", { name: "New playlist" })).toBeTruthy();
  });

  it("blocks global playback shortcuts while Command Palette is open, and preserves them when closed", () => {
    const toggleMuteSpy = vi.spyOn(usePlaybackStore.getState(), "toggleMute");
    const toggleShuffleSpy = vi.spyOn(usePlaybackStore.getState(), "toggleShuffle");

    renderShell();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    const input = screen.getByRole("combobox", { name: /Search songs, playlists, or commands/i });
    fireEvent.keyDown(input, { key: "m" });
    fireEvent.keyDown(input, { key: "s" });
    fireEvent.keyDown(window, { key: " " });

    expect(toggleMuteSpy).not.toHaveBeenCalled();
    expect(toggleShuffleSpy).not.toHaveBeenCalled();

    // Close palette and verify global shortcuts work again
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Command Palette" })).toBeNull();

    // Blur any input so global shortcuts fire
    (document.activeElement as HTMLElement | null)?.blur?.();

    fireEvent.keyDown(window, { key: "m" });
    expect(toggleMuteSpy).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "s" });
    expect(toggleShuffleSpy).toHaveBeenCalledTimes(1);
  });

  it("shows empty state with query when nothing matches", () => {
    renderShell();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    const input = screen.getByRole("combobox", { name: /Search songs, playlists, or commands/i });
    fireEvent.change(input, { target: { value: "zzzz-nonexistent-query-999" } });

    expect(screen.getByText(/No results for “zzzz-nonexistent-query-999”/i)).toBeTruthy();
  });
});
