import { beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { AppShell } from "../components/AppShell";
import { HomePage } from "../features/home/HomePage";
import { LibraryPage } from "../features/library/LibraryPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { usePlaybackStore, bindPlaybackHelpers } from "../stores/playbackStore";
import { useLibraryStore } from "../stores/libraryStore";
import { repository } from "../services/indexeddb/LibraryRepository";
import type { Track } from "../types";

function seedTrack(): Track {
  const track: Track = {
    id: "route-track",
    title: "Router Song",
    artist: "Tester",
    album: "",
    trackNumber: null,
    albumTrackCount: null,
    durationMs: 120000,
    fileName: "router.mp3",
    fileSize: 10,
    mimeType: "audio/mpeg",
    addedAt: Date.now(),
    lastPlayedAt: null,
    playCount: 0,
    isLiked: false,
    availability: "available",
    accessMode: "stored-copy",
    fingerprint: null,
    metadataFromFilename: false,
  };
  return track;
}

describe("persistent playback across route changes", () => {
  beforeEach(async () => {
    await repository.clearAllData();
    const track = seedTrack();
    await repository.putTracks([track]);
    await repository.putAudioBlob(track.id, new Blob(["audio"]));
    useLibraryStore.setState({ tracks: [track], playlists: [], status: "ready", loadError: null });

    bindPlaybackHelpers({
      getTrackForPlayback: async (id) => (id === track.id ? track : undefined),
      currentTrack: () => track,
      notifyTrackStarted: async () => undefined,
      markTrackAvailability: async () => undefined,
      persistPrefs: () => undefined,
      persistPosition: () => undefined,
    });

    // Fake playing state without a real audio element.
    usePlaybackStore.setState({
      currentTrackId: track.id,
      isPlaying: false, // rAF loops off; isPlaying toggled per assertion below
      status: "ready",
      durationMs: 120000,
      currentTimeMs: 30000,
      queueTrackIds: [track.id],
      queueIndex: 0,
      contextTrackIds: [track.id],
      context: { type: "library", label: "All songs" },
    });
    // Engine stub so the SeekBar/MiniPlayer never construct a real media element.
    usePlaybackStore.getState().setEngineForTests({
      element: null,
      setSource: () => undefined,
      play: async () => undefined,
      pause: () => undefined,
      get currentTimeSec() {
        return 30;
      },
      seekSec: () => undefined,
      get durationSec() {
        return 120;
      },
      setVolume: () => undefined,
      setMuted: () => undefined,
      dispose: () => undefined,
    });
    usePlaybackStore.setState({ isPlaying: true });
  });

  it("keeps playback state while navigating between primary routes", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<HomePage />} />
            <Route path="library" element={<LibraryPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(usePlaybackStore.getState().isPlaying).toBe(true);

    const libraryLinks = await screen.findAllByRole("link", { name: /^Library$/ });
    fireEvent.click(libraryLinks[0]);
    expect(await screen.findByRole("heading", { name: "Library" })).toBeTruthy();
    expect(usePlaybackStore.getState().isPlaying).toBe(true);
    expect(usePlaybackStore.getState().currentTrackId).toBe("route-track");

    const settingsLinks = await screen.findAllByRole("link", { name: /^Settings$/ });
    fireEvent.click(settingsLinks[0]);
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(usePlaybackStore.getState().isPlaying).toBe(true);
    expect(usePlaybackStore.getState().currentTimeMs).toBe(30000);
  });

  it("renders Home and Settings routes inside the shell", async () => {
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<HomePage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(usePlaybackStore.getState().isPlaying).toBe(true);
  });
});

describe("collapsible sidebar", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  function renderShell() {
    return render(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<HomePage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
  }

  it("collapses to the icon rail and persists the preference", () => {
    renderShell();
    const aside = document.querySelector("aside");
    expect(aside?.className).toContain("w-60");

    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(localStorage.getItem("lm-sidebar-collapsed")).toBe("1");
    expect(document.querySelector("aside")?.className).toContain("w-[76px]");

    // The rail keeps every nav item reachable by accessible name.
    expect(screen.getAllByRole("link", { name: "Library" }).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(localStorage.getItem("lm-sidebar-collapsed")).toBe("0");
    expect(document.querySelector("aside")?.className).toContain("w-60");
  });

  it("starts collapsed when the persisted preference says so", () => {
    localStorage.setItem("lm-sidebar-collapsed", "1");
    renderShell();
    expect(document.querySelector("aside")?.className).toContain("w-[76px]");
    expect(screen.getAllByRole("link", { name: "Settings" }).length).toBeGreaterThan(0);
  });
});
