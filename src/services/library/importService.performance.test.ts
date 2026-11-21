import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { Track } from "../../types";
import { createImportMatchIndex, findMatchingExistingTrack } from "./importService";

let fingerprintReads = 0;

function fixtureTrack(index: number): Track {
  const fingerprint = `${index.toString(16).padStart(32, "0")}:12000000:180000`;
  return {
    id: `fixture-${index}`,
    title: `Synthetic Track ${index}`,
    artist: "Fixture Artist",
    album: "Fixture Album",
    trackNumber: index + 1,
    albumTrackCount: null,
    durationMs: 180000,
    fileName: `fixture-${index}.mp3`,
    fileSize: 12000000,
    mimeType: "audio/mpeg",
    addedAt: index,
    lastPlayedAt: null,
    playCount: 0,
    isLiked: false,
    availability: "available",
    accessMode: "desktop-path",
    get fingerprint() {
      fingerprintReads += 1;
      return fingerprint;
    },
    metadataFromFilename: false,
  };
}

function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

it("records opt-in bulk duplicate matching work", () => {
  if (process.env.GMUSIC_BENCH !== "1") return;

  const results = [];
  for (const librarySize of [1000, 10000]) {
    const tracks = Array.from({ length: librarySize }, (_, index) => fixtureTrack(index));
    const index = createImportMatchIndex(tracks);
    const target = tracks[librarySize - 1];
    const file = new File(["fixture"], target.fileName, { type: "audio/mpeg" });
    const samples: number[] = [];
    let observedReads = 0;

    for (let run = 0; run < 15; run += 1) {
      fingerprintReads = 0;
      const started = performance.now();
      for (let query = 0; query < 100; query += 1) {
        const match = findMatchingExistingTrack({
          file,
          fingerprint: target.fingerprint,
          tailHash: null,
          durationMs: target.durationMs,
          normalizedTitle: "synthetic track",
          normalizedArtist: "fixture artist",
          rawTitle: target.title,
          rawArtist: target.artist,
          tracks,
          index,
        });
        expect(match?.match.id).toBe(target.id);
      }
      samples.push(performance.now() - started);
      observedReads = fingerprintReads;
    }

    results.push({
      workload: "duplicate_matching_100_late_exact_fingerprint_hits",
      librarySize,
      queries: 100,
      samples_ms: samples,
      p50_ms: percentile(samples, 0.5),
      p95_ms: percentile(samples, 0.95),
      fingerprint_reads: observedReads,
    });
  }

  writeFileSync(
    process.env.GMUSIC_BENCH_OUTPUT!,
    JSON.stringify(
      {
        scope: "Node/Vitest matching algorithm only; excludes file parsing, hashing, persistence, IPC, and UI rendering.",
        results,
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
}, 120000);
