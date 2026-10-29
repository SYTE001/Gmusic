import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { LyricsView } from "./LyricsView";
import { usePlaybackStore } from "../../stores/playbackStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { repository } from "../../services/indexeddb/LibraryRepository";
import type { Track, TrackLyrics } from "../../types";

/**
 * Hidden/throttled-tab behavior (feature spec §3): when requestAnimationFrame
 * is suspended (background window) but audio keeps playing, the highlighted
 * line must keep following the store's timeupdate-driven clock. This stubs
 * rAF completely — the worst real-world throttling.
 */

vi.stubGlobal("requestAnimationFrame", (() => 0) as typeof requestAnimationFrame);
vi.stubGlobal("cancelAnimationFrame", (() => undefined) as typeof cancelAnimationFrame);

const track: Track = {
  id: "throttle-track",
  title: "Throttle Song",
  artist: "Artist",
  album: "",
  trackNumber: null,
  albumTrackCount: null,
  durationMs: 60000,
  fileName: "t.wav",
  fileSize: 1,
  mimeType: "audio/wav",
  addedAt: 1,
  lastPlayedAt: null,
  playCount: 0,
  isLiked: false,
  availability: "available",
  accessMode: "stored-copy",
  fingerprint: null,
  metadataFromFilename: false,
};

const lyrics: TrackLyrics = {
  trackId: track.id,
  format: "lrc",
  lines: [
    { timeMs: 1000, text: "first line" },
    { timeMs: 5000, text: "second line" },
    { timeMs: 10000, text: "third line" },
  ],
  offsetMs: 0,
  updatedAt: 1,
  skippedLines: 0,
  sourceName: "a.lrc",
};

describe("LyricsView under rAF throttling", () => {
  beforeEach(async () => {
    await repository.clearAllData();
    await repository.putLyrics(lyrics);
    useLibraryStore.setState({ tracks: [track], playlists: [], status: "ready", loadError: null });
    usePlaybackStore.setState({
      currentTrackId: track.id,
      isPlaying: true,
      status: "ready",
      currentTimeMs: 0,
      durationMs: 60000,
      queueTrackIds: [track.id],
      queueIndex: 0,
      contextTrackIds: [track.id],
      context: { type: "library", label: "L" },
      engine: null,
    });
  });

  it("still advances the highlighted line from store time when rAF never fires", async () => {
    render(
      <MemoryRouter>
        <LyricsView />
      </MemoryRouter>,
    );

    // Audio "plays": only timeupdate-driven store updates arrive.
    usePlaybackStore.setState({ currentTimeMs: 6000 });
    await waitFor(() => {
      const active = document.querySelector('[role="listitem"][data-active="true"]');
      expect(active?.textContent).toBe("second line");
    });

    // A later position highlights the next line — never stuck, never skipped.
    usePlaybackStore.setState({ currentTimeMs: 12000 });
    await waitFor(() => {
      const active = document.querySelector('[role="listitem"][data-active="true"]');
      expect(active?.textContent).toBe("third line");
    });
  });

  it("shows no active line before the first timestamp", async () => {
    render(
      <MemoryRouter>
        <LyricsView />
      </MemoryRouter>,
    );
    usePlaybackStore.setState({ currentTimeMs: 500, isPlaying: true });
    await waitFor(() => {
      expect(screen.getAllByRole("listitem").length).toBe(3);
    });
    expect(document.querySelector('[role="listitem"][data-active="true"]')).toBeNull();
  });
});
