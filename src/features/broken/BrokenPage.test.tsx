import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { BrokenPage } from "./BrokenPage";
import { useLibraryStore } from "../../stores/libraryStore";
import { usePlaybackStore } from "../../stores/playbackStore";
import type { Track } from "../../types";

function createBrokenTrack(
  id: string,
  category: "corrupted" | "unsupported" | "decoding" | "missing" = "corrupted",
  overrides?: Partial<Track>,
): Track {
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
      summary: "This audio file could not be decoded.",
      originalMessage: "MEDIA_ERR_DECODE (3): Audio decoder pipeline encountered unrecoverable bitstream error",
      errorCode: "MEDIA_ERR_DECODE (3)",
      failedAt: 1700000000000,
      retryCount: 2,
    },
    ...overrides,
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

  it("lists affected broken tracks with preserved metadata, summary, original message, and error code", () => {
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
    expect(screen.getByText("This audio file could not be decoded.")).toBeTruthy();
    expect(
      screen.getByText("MEDIA_ERR_DECODE (3): Audio decoder pipeline encountered unrecoverable bitstream error"),
    ).toBeTruthy();
    expect(screen.getByText("MEDIA_ERR_DECODE (3)")).toBeTruthy();
  });

  it("highlights target track when navigated with ?trackId query parameter", () => {
    // Mock scrollIntoView
    window.HTMLElement.prototype.scrollIntoView = vi.fn();

    const track1 = createBrokenTrack("t1");
    const track2 = createBrokenTrack("t2-target");
    useLibraryStore.setState({ tracks: [track1, track2] });

    render(
      <MemoryRouter initialEntries={["/broken?trackId=t2-target"]}>
        <BrokenPage />
      </MemoryRouter>,
    );

    const targetEl = document.getElementById("broken-track-t2-target");
    expect(targetEl).toBeTruthy();
    expect(targetEl?.className).toContain("ring-");
    expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
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

  it("separates Broken/corrupted, Missing local files, Permission required, and Cloud unavailable without marking permission tracks as broken", async () => {
    const corrupted = createBrokenTrack("c1", "corrupted");
    const missing: Track = {
      ...createBrokenTrack("m1", "missing"),
      title: "Missing Song m1",
      availability: "missing",
      broken: null,
    };
    const permRequired: Track = {
      ...createBrokenTrack("p1"),
      title: "Permission Song p1",
      accessMode: "handle",
      availability: "permission-required",
      broken: null,
    };
    const cloudOffline: Track = {
      ...createBrokenTrack("cl1"),
      title: "Cloud Song cl1",
      accessMode: "cloud",
      availability: "offline",
      objectKey: "users/u-1/tracks/cl1/audio.mp3",
      broken: null,
    };

    const grantSpy = vi.fn(async () => true);
    useLibraryStore.setState({
      tracks: [corrupted, missing, permRequired, cloudOffline],
      grantFileAccess: grantSpy,
    });

    render(
      <MemoryRouter>
        <BrokenPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole("region", { name: "Broken / corrupted" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Missing local files" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Permission required" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Cloud unavailable" })).toBeTruthy();

    expect(screen.getByText("Permission Song p1")).toBeTruthy();
    expect(screen.getByText("Grant access to this audio file.")).toBeTruthy();

    const grantBtn = screen.getByRole("button", { name: "Grant access" });
    await act(async () => {
      fireEvent.click(grantBtn);
    });
    expect(grantSpy).toHaveBeenCalledWith("p1");
  });
});
