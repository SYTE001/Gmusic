import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "../../types";
import { repository } from "../indexeddb/LibraryRepository";
import { isTauriRuntime } from "../platform/desktop";
import {
  cacheDesktopRemoteArtwork,
  extractDesktopEmbeddedArtwork,
  invalidateDesktopArtworkCache,
  readDesktopCachedArtworkBlob,
  resolveDesktopArtwork,
  type NativeArtworkResult,
} from "../platform/artwork";
import {
  __resetArtworkServiceForTests,
  invalidateArtworkCacheForTrack,
  resolveArtworkForTrack,
} from "./artworkService";
import {
  __resetArtworkCacheForTests,
  loadArtworkUrl,
} from "./artworkCache";
import { importAudioItems } from "../library/importService";
import { probeAudioUrl } from "../metadata";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => new ArrayBuffer(0)),
  convertFileSrc: vi.fn((path: string) => `http://asset.localhost/${encodeURIComponent(path)}`),
}));

vi.mock("../platform/desktop", async (original) => ({
  ...(await original<typeof import("../platform/desktop")>()),
  isTauriRuntime: vi.fn(() => true),
}));

vi.mock("../platform/artwork", () => ({
  extractDesktopEmbeddedArtwork: vi.fn(),
  resolveDesktopArtwork: vi.fn(),
  cacheDesktopRemoteArtwork: vi.fn(),
  readDesktopCachedArtworkBlob: vi.fn(),
  invalidateDesktopArtworkCache: vi.fn(),
}));

vi.mock("../metadata", async (original) => ({
  ...(await original<typeof import("../metadata")>()),
  probeAudioUrl: vi.fn(async () => ({ supported: true, durationMs: 210_000 })),
}));

const sampleDesktopTrack: Track = {
  id: "desk-art-1",
  title: "One More Time",
  artist: "Daft Punk",
  album: "Discovery",
  trackNumber: 1,
  albumTrackCount: 14,
  durationMs: 320_000,
  fileName: "01 - One More Time.flac",
  fileSize: 20_000_000,
  mimeType: "audio/flac",
  addedAt: 1000,
  lastPlayedAt: null,
  playCount: 0,
  isLiked: false,
  availability: "available",
  accessMode: "desktop-path",
  desktopPath: "C:\\Music\\Daft Punk\\01 - One More Time.flac",
  fingerprint: "fp-daft-1",
  metadataFromFilename: false,
};

const baseNativeResult: NativeArtworkResult = {
  url: "https://coverartarchive.org/release-group/11111111-2222-3333-4444-555555555555/front-500",
  source: "musicbrainz-caa",
  releaseGroupMbid: "11111111-2222-3333-4444-555555555555",
  releaseMbid: null,
  confidence: 95,
  album: "Discovery",
  artist: "Daft Punk",
  transientFailure: false,
  fromCache: false,
  offline: false,
  contentHash: "hash123",
  mimeType: "image/jpeg",
  width: 500,
  height: 500,
  cachedPath: "C:\\Cache\\artwork-v1\\blobs\\hash123_500.jpg",
  thumbPath500: "C:\\Cache\\artwork-v1\\blobs\\hash123_500.jpg",
  thumbPath256: "C:\\Cache\\artwork-v1\\blobs\\hash123_256.jpg",
  originalPath: "C:\\Cache\\artwork-v1\\blobs\\hash123_orig.jpg",
  failedHttpRequests: 0,
};

describe("native desktop artwork integration", () => {
  let objCounter = 0;
  let artworkStore: Map<string, Blob>;

  beforeEach(async () => {
    await repository.clearAllData();
    localStorage.clear();
    __resetArtworkServiceForTests();
    __resetArtworkCacheForTests();
    objCounter = 0;
    URL.createObjectURL = vi.fn(() => `blob:native-${++objCounter}`) as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ close: vi.fn() })));
    artworkStore = new Map<string, Blob>();
    vi.spyOn(repository, "getArtwork").mockImplementation(async (id) => artworkStore.get(id));
    vi.spyOn(repository, "putArtwork").mockImplementation(async (id, blob) => {
      artworkStore.set(id, blob);
    });
    vi.spyOn(repository, "putTrackWithFiles").mockImplementation(async (track, files) => {
      await repository.putTracks([track]);
      if (files.artwork) {
        artworkStore.set(track.id, files.artwork);
      }
    });
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    vi.mocked(extractDesktopEmbeddedArtwork).mockReset().mockResolvedValue(null);
    vi.mocked(resolveDesktopArtwork).mockReset().mockResolvedValue(null);
    vi.mocked(cacheDesktopRemoteArtwork).mockReset().mockResolvedValue(null);
    vi.mocked(readDesktopCachedArtworkBlob).mockReset().mockResolvedValue(null);
    vi.mocked(invalidateDesktopArtworkCache).mockReset().mockResolvedValue(undefined);
    vi.mocked(probeAudioUrl).mockReset().mockResolvedValue({ supported: true, durationMs: 210_000 });
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses native Rust artwork resolution on desktop and materializes cached disk thumbnail into IndexedDB", async () => {
    const cachedBlob = new Blob([new Uint8Array(256).fill(7)], { type: "image/jpeg" });
    vi.mocked(resolveDesktopArtwork).mockResolvedValueOnce(baseNativeResult);
    vi.mocked(readDesktopCachedArtworkBlob).mockResolvedValueOnce(cachedBlob);

    const res = await resolveArtworkForTrack(sampleDesktopTrack);
    expect(resolveDesktopArtwork).toHaveBeenCalledWith(
      expect.objectContaining({
        id: sampleDesktopTrack.id,
        title: "One More Time",
        artist: "Daft Punk",
      }),
      expect.objectContaining({
        size: "500",
        downloadAndCache: true,
      }),
    );
    expect(res.source).toBe("musicbrainz-caa");
    expect(res.url).toBe("blob:native-1");
    expect((await repository.getArtwork(sampleDesktopTrack.id))?.size).toBe(256);
  });

  it("recovers previously cached desktop disk artwork while offline without making web requests", async () => {
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    const cachedBlob = new Blob([new Uint8Array(256).fill(8)], { type: "image/jpeg" });
    vi.mocked(resolveDesktopArtwork).mockResolvedValueOnce({
      ...baseNativeResult,
      source: "cache",
      fromCache: true,
      offline: true,
    });
    vi.mocked(readDesktopCachedArtworkBlob).mockResolvedValueOnce(cachedBlob);

    await repository.putTracks([sampleDesktopTrack]);
    const url = await loadArtworkUrl(sampleDesktopTrack);
    expect(url).toBe("blob:native-1");
    expect(resolveDesktopArtwork).toHaveBeenCalledOnce();
  });

  it("extracts embedded cover art via native Rust during desktop import when JS tag slice has no artwork", async () => {
    const embeddedBlob = new Blob([new Uint8Array(300).fill(9)], { type: "image/png" });
    vi.mocked(extractDesktopEmbeddedArtwork).mockResolvedValueOnce(embeddedBlob);

    const outcome = await importAudioItems(
      [
        {
          kind: "desktop-file",
          path: "C:\\Music\\song.ogg",
          name: "Artist - Song.ogg",
          size: 4096,
          mimeType: "audio/ogg",
        },
      ],
      { existingTracks: [], storeCopies: false },
    );

    expect(outcome.added).toBe(1);
    const addedTrack = outcome.newTracks![0];
    expect(extractDesktopEmbeddedArtwork).toHaveBeenCalledWith(
      "C:\\Music\\song.ogg",
      expect.any(String),
      "500",
    );
    const savedArt = await repository.getArtwork(addedTrack.id);
    expect(savedArt?.size).toBe(300);
  });

  it("forwards cache invalidation to native Rust disk cache on desktop", () => {
    invalidateArtworkCacheForTrack(sampleDesktopTrack);
    expect(invalidateDesktopArtworkCache).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "One More Time",
        artist: "Daft Punk",
        includeAlbum: true,
      }),
    );
  });

  it("preserves shared album cache when invalidating a single track with includeAlbum: false", async () => {
    const cachedBlob = new Blob([new Uint8Array(256).fill(7)], { type: "image/jpeg" });
    vi.mocked(resolveDesktopArtwork).mockResolvedValueOnce(baseNativeResult);
    vi.mocked(readDesktopCachedArtworkBlob).mockResolvedValueOnce(cachedBlob);

    await resolveArtworkForTrack(sampleDesktopTrack);
    vi.mocked(invalidateDesktopArtworkCache).mockClear();

    invalidateArtworkCacheForTrack(sampleDesktopTrack, {
      includeAlbum: false,
      markUrlFailed: false,
    });
    expect(invalidateDesktopArtworkCache).toHaveBeenCalledWith(
      expect.objectContaining({
        trackId: sampleDesktopTrack.id,
        title: "One More Time",
        artist: "Daft Punk",
        album: "Discovery",
        includeAlbum: false,
      }),
    );

    // Sibling track in the same album still hits the shared album cache
    const siblingTrack: Track = {
      ...sampleDesktopTrack,
      id: "desk-art-2",
      title: "Aerodynamic",
    };
    const siblingRes = await resolveArtworkForTrack(siblingTrack);
    expect(siblingRes.source).toBe("cache");
    expect(siblingRes.url).toBe(baseNativeResult.url);
  });
});
