import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheDesktopRemoteArtwork,
  extractDesktopEmbeddedArtwork,
  invalidateDesktopArtworkCache,
  readDesktopCachedArtworkBlob,
  resolveDesktopArtwork,
  type NativeArtworkResult,
} from "./artwork";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  convertFileSrc: vi.fn((p: string) => `http://asset.localhost/${encodeURIComponent(p)}`),
}));

const sampleResult: NativeArtworkResult = {
  url: "https://is1-ssl.mzstatic.com/image/thumb/600x600bb.jpg",
  source: "itunes",
  releaseGroupMbid: null,
  releaseMbid: null,
  confidence: 92,
  album: "Discovery",
  artist: "Daft Punk",
  transientFailure: false,
  fromCache: false,
  offline: false,
  contentHash: "abc123",
  mimeType: "image/jpeg",
  width: 500,
  height: 500,
  cachedPath: "C:\\Cache\\artwork-v1\\blobs\\abc123_500.jpg",
  thumbPath500: "C:\\Cache\\artwork-v1\\blobs\\abc123_500.jpg",
  thumbPath256: "C:\\Cache\\artwork-v1\\blobs\\abc123_256.jpg",
  originalPath: "C:\\Cache\\artwork-v1\\blobs\\abc123_orig.jpg",
  failedHttpRequests: 0,
};

beforeEach(() => {
  invoke.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  vi.restoreAllMocks();
});

describe("desktop artwork platform adapter", () => {
  it("never invokes Tauri IPC on web runtime", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    expect(await extractDesktopEmbeddedArtwork("C:\\Music\\song.flac", "t1")).toBeNull();
    expect(await resolveDesktopArtwork({ id: "t1", title: "Song", artist: "Artist" })).toBeNull();
    expect(await cacheDesktopRemoteArtwork({ id: "t1", title: "Song", artist: "Artist" }, "https://mzstatic.com/a.jpg")).toBeNull();
    expect(await readDesktopCachedArtworkBlob("C:\\Cache\\a.jpg")).toBeNull();
    await invalidateDesktopArtworkCache({ trackId: "t1", title: "Song", artist: "Artist" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("extracts embedded artwork on desktop and returns a typed Blob", async () => {
    const rawBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]).buffer;
    invoke
      .mockResolvedValueOnce({ ...sampleResult, source: "embedded", mimeType: "image/png", cachedPath: "C:\\Cache\\art.png" })
      .mockResolvedValueOnce(rawBytes);

    const blob = await extractDesktopEmbeddedArtwork("C:\\Music\\song.flac", "t1", "500");
    expect(blob).toBeInstanceOf(Blob);
    expect(blob?.type).toBe("image/png");
    expect(blob?.size).toBe(8);
    expect(invoke).toHaveBeenNthCalledWith(1, "extract_desktop_embedded_artwork", {
      path: "C:\\Music\\song.flac",
      trackId: "t1",
      size: "500",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "read_desktop_cached_artwork_bytes", {
      path: "C:\\Cache\\art.png",
    });
  });

  it("resolves desktop artwork and validates the IPC response shape", async () => {
    invoke.mockResolvedValueOnce(sampleResult);
    const res = await resolveDesktopArtwork(
      { id: "t1", title: "One More Time", artist: "Daft Punk", album: "Discovery", durationMs: 320_000, desktopPath: "C:\\Music\\01.flac" },
      { size: "500", forceRefresh: true, excludeUrls: ["https://bad.example/1.jpg"], downloadAndCache: true },
    );
    expect(res).toEqual(sampleResult);
    expect(invoke).toHaveBeenCalledWith("resolve_desktop_artwork", {
      request: {
        track: {
          id: "t1",
          title: "One More Time",
          artist: "Daft Punk",
          album: "Discovery",
          durationMs: 320_000,
        },
        desktopPath: "C:\\Music\\01.flac",
        size: "500",
        forceRefresh: true,
        offline: false,
        excludeUrls: ["https://bad.example/1.jpg"],
        downloadAndCache: true,
      },
    });
  });

  it("rejects malformed native artwork responses and falls back cleanly", async () => {
    invoke.mockResolvedValueOnce({ invalid: true });
    expect(await resolveDesktopArtwork({ id: "t1", title: "Song", artist: "Artist" })).toBeNull();
  });

  it("forwards desktop cache invalidation requests", async () => {
    invoke.mockResolvedValueOnce(undefined);
    await invalidateDesktopArtworkCache({
      trackId: "t1",
      title: "One More Time",
      artist: "Daft Punk",
      album: "Discovery",
    });
    expect(invoke).toHaveBeenCalledWith("invalidate_desktop_artwork_cache", {
      request: {
        trackId: "t1",
        title: "One More Time",
        artist: "Daft Punk",
        album: "Discovery",
      },
    });
  });
});
