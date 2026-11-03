import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { BrokenPage } from "./BrokenPage";
import { useLibraryStore } from "../../stores/libraryStore";
import { usePlaybackStore } from "../../stores/playbackStore";
import type { Track } from "../../types";

function createBrokenTrack(id: string, category: "corrupted" | "unsupported" | "decoding" | "missing" = "corrupted"): Track {
  return {
    id,
    title: `Broken Song ${id}`,
    artist: "Tester Artist",
    album: "Tester Album",
    trackNumber: 1,
    albumTrackCount: 10,
    durationMs: 200000,
    fileName: `broken-${id}.mp3`,
    fileSize: 4096,
    mimeType: "audio/mpeg",
    addedAt: Date.now(),
    lastPlayedAt: null,
    playCount: 0,
    isLiked: false,
    availability: "broken",
    accessMode: "stored-copy",
    fingerprint: `fp-${id}`,
    metadataFromFilename: false,
    broken: {
      isBroken: true,
      category,
      description: "Audio file cannot be decoded",
      failedAt: Date.now(),
      retryCount: 2,
    },
  };
}

describe("BrokenPage UI component", () => {
  beforeEach(() => {
    useLibraryStore.setState({
      tracks: [],
      playlists: [],
      status: "ready",
      loadError: null,
    });
  });

  it("renders empty state when there are no broken tracks", () => {
    render(
      <MemoryRouter>
        <BrokenPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("No broken tracks")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to Library" })).toBeTruthy();
  });

  it("lists affected broken tracks with preserved metadata and error badge", () => {
    const track = createBrokenTrack("b1", "decoding");
    useLibraryStore.setState({ tracks: [track] });

    render(
      <MemoryRouter>
        <BrokenPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("Broken Song b1")).toBeTruthy();
    expect(screen.getByText(/Tester Artist/)).toBeTruthy();
    expect(screen.getByText("Decoding failed")).toBeTruthy();
    expect(screen.getByText(/Audio file cannot be decoded/)).toBeTruthy();
  });

  it("triggers retry on clicking Retry button", () => {
    const track = createBrokenTrack("b2");
    useLibraryStore.setState({ tracks: [track] });

    const startTrackSpy = vi.fn();
    usePlaybackStore.setState({
      startTrack: startTrackSpy,
    });

    render(
      <MemoryRouter>
        <BrokenPage />
      </MemoryRouter>,
    );

    const retryBtn = screen.getByRole("button", { name: /Retry/i });
    fireEvent.click(retryBtn);

    expect(startTrackSpy).toHaveBeenCalledWith("b2", { autoplay: true });
  });

  it("restores track on clicking Restore button", async () => {
    const track = createBrokenTrack("b3");
    useLibraryStore.setState({ tracks: [track] });

    const restoreSpy = vi.fn(async () => {});
    useLibraryStore.setState({
      restoreBrokenTrack: restoreSpy,
    });

    render(
      <MemoryRouter>
        <BrokenPage />
      </MemoryRouter>,
    );

    const restoreBtn = screen.getByRole("button", { name: /Restore/i });
    await act(async () => {
      fireEvent.click(restoreBtn);
    });

    expect(restoreSpy).toHaveBeenCalledWith("b3");
  });

  it("opens confirmation dialog and removes track from library on confirm", async () => {
    const track = createBrokenTrack("b4");
    useLibraryStore.setState({ tracks: [track] });

    const removeTracksSpy = vi.fn(async () => {});
    useLibraryStore.setState({
      removeTracks: removeTracksSpy,
    });

    render(
      <MemoryRouter>
        <BrokenPage />
      </MemoryRouter>,
    );

    const removeBtn = screen.getByRole("button", { name: /Remove/i });
    fireEvent.click(removeBtn);

    // Confirmation dialog appears
    expect(screen.getByText("Remove broken track?")).toBeTruthy();

    const dialog = screen.getByRole("dialog", { name: "Remove broken track?" });
    const confirmBtn = within(dialog).getByRole("button", { name: "Remove" });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    expect(removeTracksSpy).toHaveBeenCalledWith(["b4"]);
  });
});
