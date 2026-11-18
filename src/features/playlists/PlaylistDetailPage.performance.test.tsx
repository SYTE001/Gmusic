import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { PlaylistDetailPage } from "./PlaylistDetailPage";
import { useLibraryStore } from "../../stores/libraryStore";
import { usePlaybackStore } from "../../stores/playbackStore";
import type { Track } from "../../types";

const observed = vi.hoisted(() => ({ contexts: new Set<string[]>(), idReads: 0 }));
vi.mock("../../components/TrackRow", () => ({
  TrackRow: ({ contextTrackIds }: { contextTrackIds: string[] }) => {
    observed.contexts.add(contextTrackIds);
    return null;
  },
}));
vi.mock("../../components/Artwork", () => ({ Artwork: () => null }));
vi.mock("../../components/StickyPageHeader", () => ({ StickyPageHeader: () => null }));
vi.mock("../library/useTrackActions", () => ({
  TrackActionsProvider: ({ children }: { children: React.ReactNode }) => children,
}));

function fixture(size: number): Track[] {
  return Array.from({ length: size }, (_, index) => {
    const id = `fixture-${index}`;
    return {
    get id() { observed.idReads += 1; return id; },
    title: `Synthetic Track ${index}`,
    artist: "Fixture Artist",
    album: "Fixture Album",
    durationMs: 180000,
    trackNumber: index + 1,
    albumTrackCount: size,
    fileName: `fixture-${index}.mp3`,
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
    };
  });
}

function mount(size: number) {
  const tracks = fixture(size);
  const ids = tracks.map((track) => track.id);
  useLibraryStore.setState({ tracks, playlists: [{ id: "fixture", name: "Fixture", description: "", trackIds: ids, createdAt: 1, updatedAt: 1 }] });
  observed.contexts.clear();
  observed.idReads = 0;
  return render(<MemoryRouter initialEntries={["/playlists/fixture"]}><Routes><Route path="/playlists/:id" element={<PlaylistDetailPage />} /></Routes></MemoryRouter>);
}

afterEach(cleanup);

it("records opt-in playlist parent profiling without pretending to measure WebView rendering", async () => {
  if (process.env.GMUSIC_BENCH !== "1") return;
  const results = [];
  for (const size of [100, 1000]) {
    const samples = [];
    let contexts = 0;
    let reads = 0;
    for (let run = 0; run < 9; run++) {
      const start = performance.now();
      mount(size);
      samples.push(performance.now() - start);
      contexts = observed.contexts.size;
      reads = observed.idReads;
      cleanup();
    }
    const sorted = [...samples].sort((a, b) => a - b);
    results.push({ workload: "playlist_parent_mount_jsdom", size, samples_ms: samples, p50_ms: sorted[4], p95_ms: sorted[8], context_arrays: contexts, track_id_reads: reads });
  }
  // Large-library computation only; the full 10k DOM remains separate manual QA.
  const tracks = fixture(10000);
  const ids = tracks.map((track) => track.id);
  const samples = [];
  for (let run = 0; run < 9; run++) {
    const start = performance.now();
    const byId = new Map(tracks.map((track) => [track.id, track]));
    const resolved = ids.map((id) => byId.get(id));
    const available = resolved.filter((track): track is Track => track !== undefined);
    const contextIds = available.map((track) => track.id);
    let checksum = 0;
    for (let index = 0; index < resolved.length; index++) checksum += contextIds.length;
    expect(checksum).toBe(100000000);
    samples.push(performance.now() - start);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  const sorted = [...samples].sort((a, b) => a - b);
  results.push({ workload: "optimized_playlist_algorithms_only", size: 10000, samples_ms: samples, p50_ms: sorted[4], p95_ms: sorted[8], context_arrays: 1, track_id_reads: observed.idReads });
  writeFileSync(process.env.GMUSIC_BENCH_OUTPUT!, JSON.stringify({ scope: "Node/jsdom parent only; TrackRow/artwork mocked. Not desktop paint, audio or native IPC.", results }, null, 2), { flag: "wx" });
}, 120000);

it("shares one context array and resolves library IDs with linear work", () => {
  mount(1000);
  expect(observed.contexts.size).toBe(1);
  expect(observed.idReads).toBeLessThanOrEqual(4100);
  expect([...observed.contexts][0]).toHaveLength(1000);
});

it("preserves duplicate playlist positions and excludes missing IDs from playback", () => {
  const tracks = fixture(3);
  useLibraryStore.setState({ tracks, playlists: [{ id: "fixture", name: "Fixture", description: "", trackIds: ["fixture-2", "missing", "fixture-0", "fixture-2"], createdAt: 1, updatedAt: 1 }] });
  observed.contexts.clear();
  render(<MemoryRouter initialEntries={["/playlists/fixture"]}><Routes><Route path="/playlists/:id" element={<PlaylistDetailPage />} /></Routes></MemoryRouter>);
  expect(observed.contexts.size).toBe(1);
  expect([...observed.contexts][0]).toEqual(["fixture-2", "fixture-0", "fixture-2"]);
});

it("isolates playlist parent from high-frequency playback clock updates", () => {
  mount(100);
  const before = observed.idReads;
  for (let index = 0; index < 100; index++) act(() => usePlaybackStore.setState({ currentTimeMs: index * 16 }));
  expect(observed.idReads).toBe(before);
});
