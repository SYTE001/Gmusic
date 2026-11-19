import { cleanup, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { PlaylistsPage } from "./PlaylistsPage";
import { useLibraryStore } from "../../stores/libraryStore";
import type { Playlist, Track } from "../../types";

const observed = vi.hoisted(() => ({ artworkKeys: [] as Array<string | null>, subtitles: [] as string[], idReads: 0 }));

vi.mock("../../components/ArtworkCard", () => ({
  ArtworkCard: ({ artworkKey, subtitle }: { artworkKey: string | null; subtitle: string }) => {
    observed.artworkKeys.push(artworkKey);
    observed.subtitles.push(subtitle);
    return null;
  },
}));
vi.mock("./CreatePlaylistModal", () => ({ CreatePlaylistModal: () => null }));

function fixture(librarySize: number, playlistCount: number, tracksPerPlaylist: number): { tracks: Track[]; playlists: Playlist[] } {
  const tracks = Array.from({ length: librarySize }, (_, index) => {
    const id = `fixture-${index}`;
    return {
      get id() {
        observed.idReads += 1;
        return id;
      },
      title: `Synthetic Track ${index}`,
      artist: "Fixture Artist",
      album: "Fixture Album",
      durationMs: 180000,
      trackNumber: index + 1,
      albumTrackCount: librarySize,
      fileName: `${id}.mp3`,
      fileSize: 12000000,
      mimeType: "audio/mpeg",
      addedAt: index,
      lastPlayedAt: null,
      playCount: 0,
      isLiked: false,
      availability: "available",
      accessMode: "desktop-path",
      fingerprint: null,
      metadataFromFilename: false,
    } satisfies Track;
  });
  const playlists = Array.from({ length: playlistCount }, (_, playlistIndex) => ({
    id: `playlist-${playlistIndex}`,
    name: `Playlist ${playlistIndex}`,
    description: "",
    trackIds: Array.from({ length: tracksPerPlaylist }, (_, itemIndex) =>
      `fixture-${(playlistIndex * tracksPerPlaylist + itemIndex) % librarySize}`,
    ),
    createdAt: playlistIndex,
    updatedAt: playlistIndex,
  }));
  return { tracks, playlists };
}

function mount(librarySize: number, playlistCount: number, tracksPerPlaylist: number) {
  const data = fixture(librarySize, playlistCount, tracksPerPlaylist);
  useLibraryStore.setState(data);
  observed.artworkKeys = [];
  observed.subtitles = [];
  observed.idReads = 0;
  return render(
    <MemoryRouter initialEntries={["/playlists"]}>
      <Routes>
        <Route path="/playlists" element={<PlaylistsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

afterEach(cleanup);

it("resolves playlist summaries with work linear in library plus membership count", () => {
  mount(10000, 40, 100);
  expect(observed.artworkKeys).toHaveLength(40);
  expect(observed.artworkKeys[0]).toBe("fixture-0");
  expect(observed.idReads).toBeLessThanOrEqual(15000);
});

it("preserves duplicate memberships and excludes missing tracks from summaries", () => {
  const data = fixture(3, 0, 0);
  data.playlists = [{
    id: "mixed",
    name: "Mixed",
    description: "",
    trackIds: ["fixture-2", "missing", "fixture-0", "fixture-2"],
    createdAt: 1,
    updatedAt: 1,
  }];
  useLibraryStore.setState(data);
  observed.artworkKeys = [];
  observed.subtitles = [];
  observed.idReads = 0;
  render(
    <MemoryRouter initialEntries={["/playlists"]}>
      <Routes><Route path="/playlists" element={<PlaylistsPage />} /></Routes>
    </MemoryRouter>,
  );

  expect(observed.artworkKeys).toEqual(["fixture-2"]);
  expect(observed.subtitles).toEqual(["3 songs · 9 min"]);
});

it("records opt-in playlist navigation profiling without claiming WebView paint", async () => {
  if (process.env.GMUSIC_BENCH !== "1") return;
  const results = [];
  for (const workload of [
    { librarySize: 1000, playlistCount: 20, tracksPerPlaylist: 50 },
    { librarySize: 10000, playlistCount: 40, tracksPerPlaylist: 100 },
  ]) {
    const samples = [];
    let idReads = 0;
    for (let run = 0; run < 15; run += 1) {
      const start = performance.now();
      mount(workload.librarySize, workload.playlistCount, workload.tracksPerPlaylist);
      samples.push(performance.now() - start);
      idReads = observed.idReads;
      cleanup();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    results.push({
      workload: "playlists_route_parent_mount_jsdom",
      ...workload,
      samples_ms: samples,
      p50_ms: percentile(samples, 0.5),
      p95_ms: percentile(samples, 0.95),
      track_id_reads: idReads,
    });
  }
  writeFileSync(
    process.env.GMUSIC_BENCH_OUTPUT!,
    JSON.stringify(
      {
        scope: "Node/jsdom parent route with ArtworkCard and modal mocked. Includes React mount and playlist summary computation; excludes WebView paint, image decode, SQLite and Tauri IPC.",
        results,
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
}, 120000);
