import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../../types";
import { repository } from "../indexeddb/LibraryRepository";

/**
 * MigrationService is mocked at its two external boundaries — the Worker
 * client (r2StorageService) and the Postgres writer (cloudLibraryService) —
 * so tests observe the local data contract: nothing local is ever deleted,
 * failures are recoverable, and concurrency is bounded.
 */
const storage = vi.hoisted(() => ({
  /** When set, the simulated Worker rejects uploads for these track ids. */
  failingTrackIds: new Set<string>(),
  /** When set, the simulated Worker rejects `complete` (verification). */
  verificationFailsFor: new Set<string>(),
  /** Objects the client asked the Worker to delete after a failed upload. */
  cleanedUpObjects: [] as string[],
  uploads: 0,
  concurrencyPeak: 0,
  inFlight: 0,
  /** MIME type the client declared per audio upload-url request. */
  audioMimeByTrack: new Map<string, string>(),
  /** MIME type the client declared per artwork upload-url request. */
  artworkMimeByTrack: new Map<string, string>(),
  /** MIME type the client sent to `completeUpload`, per object key. */
  completeMimeByObject: new Map<string, string>(),
}));

vi.mock("../cloud/r2StorageService", () => ({
  CloudStorageError: class CloudStorageError extends Error {
    readonly kind: string;
    readonly status: number | null;
    constructor(kind: string, message: string, status: number | null = null) {
      super(message);
      this.name = "CloudStorageError";
      this.kind = kind;
      this.status = status;
    }
  },
  requestUploadUrl: async ({
    trackId,
    fileName,
    mimeType,
    sizeBytes,
    kind,
  }: {
    trackId: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    kind?: "audio" | "artwork";
  }) => {
    if (storage.failingTrackIds.has(trackId)) {
      throw new (class extends Error {})("The upload was rejected (500).");
    }
    storage.uploads += 1;
    // Mirrors the real Worker: the object key and the signed Content-Type
    // both follow the extension and the declared MIME type.
    const extension = fileName.split(".").pop() ?? "mp3";
    const category = kind ?? "audio";
    if (category === "artwork") storage.artworkMimeByTrack.set(trackId, mimeType);
    else storage.audioMimeByTrack.set(trackId, mimeType);
    return {
      objectKey: `users/u-1/tracks/${trackId}/${category}.${extension}`,
      uploadUrl: `https://r2/put/${trackId}/${category}`,
      expiresIn: 120,
      requiredHeaders: { "content-type": mimeType },
      sizeBytes,
    };
  },
  completeUpload: async ({
    objectKey,
    sizeBytes,
    mimeType,
  }: {
    objectKey: string;
    trackId: string;
    sizeBytes: number;
    mimeType: string;
  }) => {
    if (storage.verificationFailsFor.has(objectKey)) {
      throw new (class extends Error {})("verification failed");
    }
    storage.completeMimeByObject.set(objectKey, mimeType);
    return { objectKey, size: sizeBytes, etag: "etag", contentType: mimeType };
  },
  /** Records rejected-object cleanup attempts. */
  deleteCloudObject: async (objectKey: string) => {
    storage.cleanedUpObjects.push(objectKey);
    return [objectKey];
  },
}));

const library = vi.hoisted(() => ({
  upserted: [] as Track[],
}));

vi.mock("../cloud/cloudLibraryService", () => ({
  upsertCloudTracks: async (tracks: Track[]) => {
    library.upserted.push(...tracks);
    return tracks.map((track) => ({ objectKey: track.objectKey ?? null, reconciledWith: null }));
  },
}));

import {
  cancelMigration,
  initialMigrationProgress,
  planMigration,
  resolveAudioMimeType,
  retryFailedItems,
  runMigration,
} from "./migrationService";
import { forgetSessionFile, rememberSessionFile } from "../file-access/FileAccessService";

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: `t-${Math.random().toString(36).slice(2, 8)}`,
    title: "Song",
    artist: "Artist",
    album: "",
    trackNumber: null,
    albumTrackCount: null,
    durationMs: 60000,
    fileName: "song.mp3",
    fileSize: 1000,
    mimeType: "audio/mpeg",
    addedAt: Date.now(),
    lastPlayedAt: null,
    playCount: 0,
    isLiked: false,
    availability: "available",
    accessMode: "stored-copy",
    fingerprint: `fp-${Math.random()}`,
    metadataFromFilename: false,
    ...overrides,
  };
}

async function storedTracks(count: number): Promise<Track[]> {
  const tracks: Track[] = [];
  for (let index = 0; index < count; index += 1) {
    const track = makeTrack({ id: `stored-${index}` });
    tracks.push(track);
    await repository.putTracks([track]);
    await repository.putAudioBlob(track.id, new Blob([new Uint8Array(1000)], { type: "audio/mpeg" }));
  }
  return tracks;
}

describe("resolveAudioMimeType", () => {
  it("lets the file name win over mislabeled metadata for known formats", () => {
    expect(resolveAudioMimeType("song.m4a", "audio/mpeg")).toBe("audio/mp4");
    expect(resolveAudioMimeType("song.m4b", "audio/mpeg")).toBe("audio/mp4");
    expect(resolveAudioMimeType("song.mp4", "audio/mpeg")).toBe("audio/mp4");
    expect(resolveAudioMimeType("song.aac", "audio/mpeg")).toBe("audio/aac");
    expect(resolveAudioMimeType("song.wav", "audio/mpeg")).toBe("audio/wav");
    expect(resolveAudioMimeType("song.flac", "audio/mpeg")).toBe("audio/flac");
    expect(resolveAudioMimeType("song.ogg", "audio/mpeg")).toBe("audio/ogg");
    expect(resolveAudioMimeType("song.opus", "audio/mpeg")).toBe("audio/opus");
    expect(resolveAudioMimeType("SONG.M4A", "audio/mpeg")).toBe("audio/mp4");
  });

  it("keeps the canonical type for already-correct metadata", () => {
    expect(resolveAudioMimeType("song.mp3", "audio/mpeg")).toBe("audio/mpeg");
    expect(resolveAudioMimeType("song.m4a", "audio/mp4")).toBe("audio/mp4");
    expect(resolveAudioMimeType("song.mp3", "audio/mp3")).toBe("audio/mpeg");
    expect(resolveAudioMimeType("song.wav", "audio/wav")).toBe("audio/wav");
    expect(resolveAudioMimeType("song.flac", "audio/flac")).toBe("audio/flac");
    expect(resolveAudioMimeType("song.ogg", "audio/ogg")).toBe("audio/ogg");
  });

  it("trusts a real audio type for extensions the app does not know", () => {
    expect(resolveAudioMimeType("track.xyz", "audio/ogg")).toBe("audio/ogg");
    expect(resolveAudioMimeType("track.xyz", " AUDIO/OPUS ")).toBe("audio/opus");
  });

  it("falls back to the MP3 default when nothing usable is known", () => {
    expect(resolveAudioMimeType("song")).toBe("audio/mpeg");
    expect(resolveAudioMimeType("song.xyz", "")).toBe("audio/mpeg");
    expect(resolveAudioMimeType("song.xyz", "application/octet-stream")).toBe("audio/mpeg");
    expect(resolveAudioMimeType("song.xyz", undefined)).toBe("audio/mpeg");
  });
});

describe("migration planning", () => {
  beforeEach(async () => {
    await repository.clearAllData();
    storage.failingTrackIds.clear();
    storage.verificationFailsFor.clear();
    storage.uploads = 0;
    storage.cleanedUpObjects = [];
    storage.concurrencyPeak = 0;
    storage.inFlight = 0;
    storage.audioMimeByTrack.clear();
    storage.artworkMimeByTrack.clear();
    storage.completeMimeByObject.clear();
    library.upserted = [];
    // The presigned PUT goes to the object store, never the test network.
    vi.stubGlobal("fetch", async () => new Response("", { status: 200 }));
  });

  it("classifies tracks whose local audio is reachable as uploadable", async () => {
    const tracks = await storedTracks(2);
    const plan = await planMigration(tracks);
    expect(plan.items.filter((item) => item.status === "pending")).toHaveLength(2);
    expect(plan.needsAccess).toHaveLength(0);
    expect(plan.missing).toHaveLength(0);
  });

  it("marks tracks whose stored handle can no longer be opened as needs-access", async () => {
    const track = makeTrack({ id: "handle-1", accessMode: "handle" });
    // A retained handle whose file can no longer be read (moved, or permission
    // no longer granted silently): opening it fails, so the track is not
    // silently skipped from the migration plan.
    const unusableHandle = { kind: "file", name: "song.mp3" };
    await repository.putHandle(track.id, unusableHandle as unknown as FileSystemFileHandle);
    const plan = await planMigration([track]);
    expect(plan.items[0]!.status).toBe("needs-access");
    expect(plan.needsAccess).toHaveLength(1);
  });

  it("marks tracks with no reachable audio at all as missing", async () => {
    const track = makeTrack({ id: "gone-1", accessMode: "session-only" });
    const plan = await planMigration([track]);
    expect(plan.items[0]!.status).toBe("missing");
    expect(plan.missing).toHaveLength(1);
  });

  it("skips tracks that already have a verified cloud copy", async () => {
    const track = makeTrack({ id: "clouded", cloudStatus: "ready", objectKey: "users/u-1/tracks/clouded/audio.mp3" });
    const plan = await planMigration([track]);
    expect(plan.items[0]!.status).toBe("done");
  });
});

describe("migration run", () => {
  beforeEach(async () => {
    await repository.clearAllData();
    storage.failingTrackIds.clear();
    storage.verificationFailsFor.clear();
    storage.uploads = 0;
    storage.cleanedUpObjects = [];
    storage.concurrencyPeak = 0;
    storage.inFlight = 0;
    storage.audioMimeByTrack.clear();
    storage.artworkMimeByTrack.clear();
    storage.completeMimeByObject.clear();
    library.upserted = [];
    // The presigned PUT goes to the object store, never the test network.
    vi.stubGlobal("fetch", async () => new Response("", { status: 200 }));
  });

  it("uploads, verifies, and persists cloud metadata for each reachable track", async () => {
    const tracks = await storedTracks(2);
    const progress = { ...initialMigrationProgress(), items: (await planMigration(tracks)).items };

    await runMigration(tracks, progress);

    expect(progress.state).toBe("complete");
    expect(progress.succeeded).toBe(2);
    expect(progress.failed).toBe(0);
    // Cloud metadata was written only for verified uploads.
    expect(library.upserted).toHaveLength(2);
    expect(library.upserted.every((track) => track.objectKey !== null)).toBe(true);
    // Local records were UPDATED, never deleted: the audio copies are intact.
    for (const track of tracks) {
      expect(await repository.getAudioBlob(track.id)).toBeTruthy();
      const stored = await repository.getTrack(track.id);
      expect(stored?.cloudStatus).toBe("ready");
      expect(stored?.objectKey).toBe(`users/u-1/tracks/${track.id}/audio.mp3`);
      expect(stored?.accessMode).toBe("stored-copy");
    }
  });

  it("keeps local data untouched when the Worker rejects an upload", async () => {
    const tracks = await storedTracks(2);
    storage.failingTrackIds.add(tracks[1]!.id);
    const progress = { ...initialMigrationProgress(), items: (await planMigration(tracks)).items };

    await runMigration(tracks, progress);

    expect(progress.state).toBe("complete");
    expect(progress.succeeded).toBe(1);
    expect(progress.failed).toBe(1);
    expect(progress.items.find((item) => item.status === "failed")?.error).toBeTruthy();
    // The local audio copy survives the failure verbatim.
    expect(await repository.getAudioBlob(tracks[1]!.id)).toBeTruthy();
    const stored = await repository.getTrack(tracks[1]!.id);
    expect(stored?.cloudStatus).toBeUndefined(); // never marked uploaded
  });

  it("re-failing verification leaves the track failed and local data intact", async () => {
    const tracks = await storedTracks(1);
    storage.verificationFailsFor.add(`users/u-1/tracks/${tracks[0]!.id}/audio.mp3`);
    const progress = { ...initialMigrationProgress(), items: (await planMigration(tracks)).items };

    await runMigration(tracks, progress);

    expect(progress.failed).toBe(1);
    expect(library.upserted).toHaveLength(0); // nothing was marked complete
    expect(await repository.getAudioBlob(tracks[0]!.id)).toBeTruthy();
  });

  it("retries only the failed items, and a repeated upload attempt converges", async () => {
    const tracks = await storedTracks(1);
    storage.failingTrackIds.add(tracks[0]!.id);
    const progress = { ...initialMigrationProgress(), items: (await planMigration(tracks)).items };
    await runMigration(tracks, progress);
    expect(progress.failed).toBe(1);

    storage.failingTrackIds.clear();
    retryFailedItems(progress);
    await runMigration(tracks, progress);
    expect(progress.state).toBe("complete");
    expect(progress.succeeded).toBe(1);
    expect(progress.failed).toBe(0);
    // No duplicate cloud metadata: one row per stable id.
    expect(library.upserted.filter((track) => track.id === tracks[0]!.id)).toHaveLength(1);
  });

  it("runs at most `concurrency` uploads at a time", async () => {
    const tracks = await storedTracks(6);
    const originalFetch = globalThis.fetch;
    let active = 0;
    let peak = 0;
    // Observe concurrency through the shared Worker mock by wrapping fetch;
    // the simulated PUT goes through the real fetch on the presigned URL.
    vi.stubGlobal("fetch", async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Response("", { status: 200 });
    });
    try {
      const progress = { ...initialMigrationProgress(), items: (await planMigration(tracks)).items };
      await runMigration(tracks, progress, { concurrency: 2 });
      expect(peak).toBeLessThanOrEqual(2);
      expect(progress.succeeded).toBe(6);
    } finally {
      vi.unstubAllGlobals();
      void originalFetch;
    }
  });

  it("removes the unclaimed object when an upload is rejected mid-way", async () => {
    const tracks = await storedTracks(1);
    storage.verificationFailsFor.add(`users/u-1/tracks/${tracks[0]!.id}/audio.mp3`);
    const progress = { ...initialMigrationProgress(), items: (await planMigration(tracks)).items };

    await runMigration(tracks, progress);

    expect(progress.failed).toBe(1);
    // The object was PUT but never verified, so the client asked the Worker
    // to delete it — no audio lingers in R2 without metadata.
    expect(storage.cleanedUpObjects).toEqual([`users/u-1/tracks/${tracks[0]!.id}/audio.mp3`]);
    // And nothing local was marked uploaded.
    const stored = await repository.getTrack(tracks[0]!.id);
    expect(stored?.cloudStatus ?? "local").toBe("local");
  });

  it("cancels between files, leaving pending items and all local data intact", async () => {
    const tracks = await storedTracks(4);
    const progress = { ...initialMigrationProgress(), items: (await planMigration(tracks)).items };

    // One upload at a time; cancel as soon as the first one starts.
    let started = false;
    vi.stubGlobal("fetch", async () => {
      started = true;
      await new Promise((wait) => setTimeout(wait, 20));
      return new Response("", { status: 200 });
    });
    const run = runMigration(tracks, progress, { concurrency: 1 });
    while (!started) await new Promise((wait) => setTimeout(wait, 5));
    cancelMigration();
    await run;

    expect(progress.state).toBe("cancelled");
    const doneCount = progress.items.filter((item) => item.status === "done").length;
    expect(doneCount).toBeLessThan(4);
    expect(doneCount).toBeGreaterThanOrEqual(1);
    expect(progress.items.some((item) => item.status === "pending")).toBe(true);
    // Nothing local was deleted by stopping early, and only the tracks that
    // actually finished were marked uploaded — never the pending ones.
    for (const track of tracks) {
      expect(await repository.getAudioBlob(track.id)).toBeTruthy();
    }
    const pendingIds = new Set(progress.items.filter((item) => item.status === "pending").map((item) => item.trackId));
    for (const trackId of pendingIds) {
      const stored = await repository.getTrack(trackId);
      expect(stored?.cloudStatus ?? "local").toBe("local");
    }
  });

  it("never deletes the local audio copy during a successful migration", async () => {
    const tracks = await storedTracks(1);
    const progress = { ...initialMigrationProgress(), items: (await planMigration(tracks)).items };
    await runMigration(tracks, progress);
    expect(await repository.getAudioBlob(tracks[0]!.id)).toBeTruthy();
    const stored = await repository.getTrack(tracks[0]!.id);
    expect(stored?.availability).toBe("available");
  });

  it("uploads an .m4a file whose metadata says audio/mpeg as audio/mp4", async () => {
    const track = makeTrack({ id: "m4a-1", fileName: "song.m4a", mimeType: "audio/mpeg" });
    await repository.putTracks([track]);
    await repository.putAudioBlob(track.id, new Blob([new Uint8Array(1000)], { type: "audio/mpeg" }));

    const putContentTypes: string[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      putContentTypes.push(headers?.["content-type"] ?? "");
      return new Response("", { status: 200 });
    });

    const progress = { ...initialMigrationProgress(), items: (await planMigration([track])).items };
    await runMigration([track], progress);

    expect(progress.state).toBe("complete");
    expect(progress.succeeded).toBe(1);
    // The presigned request, the PUT Content-Type, and the verification call
    // all carried the extension-derived type — never the mislabeled metadata.
    expect(storage.audioMimeByTrack.get("m4a-1")).toBe("audio/mp4");
    expect(putContentTypes).toEqual(["audio/mp4"]);
    expect(storage.completeMimeByObject.get("users/u-1/tracks/m4a-1/audio.m4a")).toBe("audio/mp4");
    // The local copy survived the upload untouched.
    expect(await repository.getAudioBlob(track.id)).toBeTruthy();
  });

  it("keeps uploading .mp3 files as audio/mpeg", async () => {
    const track = makeTrack({ id: "mp3-1", fileName: "song.mp3", mimeType: "audio/mpeg" });
    await repository.putTracks([track]);
    await repository.putAudioBlob(track.id, new Blob([new Uint8Array(1000)], { type: "audio/mpeg" }));

    const progress = { ...initialMigrationProgress(), items: (await planMigration([track])).items };
    await runMigration([track], progress);

    expect(storage.audioMimeByTrack.get("mp3-1")).toBe("audio/mpeg");
    expect(storage.completeMimeByObject.get("users/u-1/tracks/mp3-1/audio.mp3")).toBe("audio/mpeg");
  });

  it("resolves the upload MIME from the file name for File System Access handles", async () => {
    const track = makeTrack({ id: "handle-m4a", fileName: "song.m4a", mimeType: "audio/mpeg", accessMode: "handle" });
    await repository.putTracks([track]);
    // A retained handle whose file reports the wrong MIME type, as browsers
    // and OS pickers regularly do for .m4a audio.
    const handle = {
      kind: "file" as const,
      name: "song.m4a",
      getFile: async () => new File([new Uint8Array(1000)], "song.m4a", { type: "audio/mpeg" }),
    };
    const spy = vi.spyOn(repository, "getHandle").mockResolvedValue(handle as unknown as FileSystemFileHandle);
    try {
      const progress = { ...initialMigrationProgress(), items: (await planMigration([track])).items };
      await runMigration([track], progress);

      expect(progress.state).toBe("complete");
      expect(storage.audioMimeByTrack.get("handle-m4a")).toBe("audio/mp4");
      expect(storage.completeMimeByObject.get("users/u-1/tracks/handle-m4a/audio.m4a")).toBe("audio/mp4");
    } finally {
      spy.mockRestore();
    }
  });

  it("resolves the upload MIME from the file name for session files", async () => {
    const track = makeTrack({ id: "session-m4a", fileName: "song.m4a", mimeType: "audio/mpeg", accessMode: "session-only" });
    await repository.putTracks([track]);
    rememberSessionFile(track.id, new File([new Uint8Array(1000)], "song.m4a", { type: "audio/mpeg" }));
    try {
      const progress = { ...initialMigrationProgress(), items: (await planMigration([track])).items };
      await runMigration([track], progress);

      expect(progress.state).toBe("complete");
      expect(storage.audioMimeByTrack.get("session-m4a")).toBe("audio/mp4");
      expect(storage.completeMimeByObject.get("users/u-1/tracks/session-m4a/audio.m4a")).toBe("audio/mp4");
    } finally {
      forgetSessionFile(track.id);
    }
  });

  it("labels artwork uploads with the artwork blob type, not the audio resolution", async () => {
    const track = makeTrack({ id: "artwork-1", fileName: "song.m4a", mimeType: "audio/mp4" });
    await repository.putTracks([track]);
    await repository.putAudioBlob(track.id, new Blob([new Uint8Array(1000)], { type: "audio/mp4" }));
    // The artwork blob is served directly: this jsdom/fake-indexeddb build
    // drops a Blob's type over the round trip, while real browsers keep it.
    const artwork = new Blob([new Uint8Array(64)], { type: "image/png" });
    const spy = vi.spyOn(repository, "getArtwork").mockResolvedValue(artwork);
    try {
      const progress = { ...initialMigrationProgress(), items: (await planMigration([track])).items };
      await runMigration([track], progress);

      expect(progress.state).toBe("complete");
      // The audio upload still used the extension-derived audio type, while
      // the artwork upload kept its own image type — the MIME fix did not
      // leak from audio into artwork.
      expect(storage.audioMimeByTrack.get("artwork-1")).toBe("audio/mp4");
      expect(storage.artworkMimeByTrack.get("artwork-1")).toBe("image/png");
    } finally {
      spy.mockRestore();
    }
  });
});
