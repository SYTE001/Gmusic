import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsPage } from "./SettingsPage";
import { useLibraryStore } from "../../stores/libraryStore";
import { reloadMissingArtwork } from "../../services/artwork/artworkCache";
import { toast } from "../../stores/toastStore";
import type { Track } from "../../types";

vi.mock("./CloudAccountSection", () => ({
  CloudAccountSection: () => null,
}));

vi.mock("./CloudMigrationSection", () => ({
  CloudMigrationSection: () => null,
}));

vi.mock("./LibraryMetadataSection", () => ({
  LibraryMetadataSection: () => null,
}));

vi.mock("../../services/artwork/artworkCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/artwork/artworkCache")>();
  return {
    ...actual,
    reloadMissingArtwork: vi.fn(),
  };
});

vi.mock("../../stores/toastStore", () => ({
  toast: vi.fn(),
}));

const makeTrack = (id: string): Track =>
  ({
    id,
    title: `Song ${id}`,
    artist: "Artist",
    album: "Album",
    fileName: `${id}.mp3`,
    addedAt: 0,
    availability: "available",
    broken: null,
    liked: false,
    playCount: 0,
    lastPlayedAt: null,
  }) as unknown as Track;

describe("SettingsPage — Reload missing artwork", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useLibraryStore.setState({ tracks: [] });
  });

  it("disables the button when the library has no tracks", () => {
    render(<SettingsPage />);

    const button = screen.getByRole("button", { name: /reload missing artwork/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("triggers reloadMissingArtwork with current tracks, displays progress, and reports restored count", async () => {
    const tracks = [makeTrack("t1"), makeTrack("t2"), makeTrack("t3")];
    useLibraryStore.setState({ tracks });

    let resolveRun!: (value: Awaited<ReturnType<typeof reloadMissingArtwork>>) => void;
    vi.mocked(reloadMissingArtwork).mockImplementation((_tracks, options) => {
      options?.onProgress?.({ done: 1, total: 2, restored: 1 });
      return new Promise((resolve) => {
        resolveRun = resolve;
      });
    });

    render(<SettingsPage />);

    const button = screen.getByRole("button", { name: /reload missing artwork/i });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);

    await waitFor(() => {
      expect(reloadMissingArtwork).toHaveBeenCalledWith(tracks, expect.objectContaining({ onProgress: expect.any(Function) }));
      expect((screen.getByRole("button", { name: /reloading \(1\/2\)/i }) as HTMLButtonElement).disabled).toBe(true);
    });

    resolveRun({
      totalTracks: 3,
      alreadyHaveArtwork: 1,
      missingFound: 2,
      restored: 2,
      stillMissing: 0,
      offline: false,
    });

    await waitFor(() => {
      expect(screen.getByText("Restored artwork for 2 tracks.")).toBeTruthy();
      expect(toast).toHaveBeenCalledWith("success", "Restored artwork for 2 tracks.");
      expect((screen.getByRole("button", { name: /reload missing artwork/i }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("shows an informational message when all tracks already have artwork", async () => {
    useLibraryStore.setState({ tracks: [makeTrack("t1")] });
    vi.mocked(reloadMissingArtwork).mockResolvedValue({
      totalTracks: 1,
      alreadyHaveArtwork: 1,
      missingFound: 0,
      restored: 0,
      stillMissing: 0,
      offline: false,
    });

    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: /reload missing artwork/i }));

    await waitFor(() => {
      expect(screen.getByText("All tracks already have artwork.")).toBeTruthy();
      expect(toast).toHaveBeenCalledWith("info", "All tracks already have artwork.");
    });
  });

  it("shows an error toast when offline", async () => {
    useLibraryStore.setState({ tracks: [makeTrack("t1")] });
    vi.mocked(reloadMissingArtwork).mockResolvedValue({
      totalTracks: 1,
      alreadyHaveArtwork: 0,
      missingFound: 1,
      restored: 0,
      stillMissing: 1,
      offline: true,
    });

    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: /reload missing artwork/i }));

    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith("error", "Connect to the internet to reload missing artwork.");
    });
  });
});
