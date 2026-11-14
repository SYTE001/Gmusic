import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { repository } from "../indexeddb/LibraryRepository";
import {
  __resetArtworkCacheForTests,
  getArtworkUrl,
  reloadMissingArtwork,
} from "./artworkCache";
import {
  __resetArtworkServiceForTests,
  getAlbumArtworkCacheKey,
  getArtworkCacheKey,
  getCachedArtworkEntry,
} from "./artworkService";
import { __configureMusicBrainzForTests } from "./musicbrainzClient";
import { Artwork } from "../../components/Artwork";
import type { Track } from "../../types";

const makeSizedBlob = (sizeBytes: number): Blob =>
  new Blob([new Uint8Array(sizeBytes).fill(1)], { type: "image/jpeg" });

const makeTrack = (id: string, overrides: Partial<Track> = {}): Track =>
  ({
    id,
    title: `Song ${id}`,
    artist: "Integration Artist",
    album: "",
    fileName: `${id}.mp3`,
    addedAt: 0,
    availability: "available",
    broken: null,
    liked: false,
    playCount: 0,
    lastPlayedAt: null,
    ...overrides,
  }) as unknown as Track;

describe("Artwork Recovery End-to-End Integration", () => {
  let objUrlCounter = 0;
  let artworkStore: Map<string, Blob>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    await repository.clearAllData();
    localStorage.clear();
    __resetArtworkCacheForTests();
    __resetArtworkServiceForTests();
    __configureMusicBrainzForTests({ rateLimitMs: 0 });
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
    objUrlCounter = 0;
    URL.createObjectURL = vi.fn(() => `blob:int-${++objUrlCounter}`) as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;

    // jsdom's fake-indexeddb strips custom jsdom Blob prototypes via V8 structuredClone;
    // back repository artwork methods with a real Blob Map preserving size, type, and decode state.
    artworkStore = new Map<string, Blob>();
    vi.spyOn(repository, "getArtwork").mockImplementation(async (id) => artworkStore.get(id));
    vi.spyOn(repository, "putArtwork").mockImplementation(async (id, blob) => {
      artworkStore.set(id, blob);
    });
    vi.spyOn(repository, "deleteArtwork").mockImplementation(async (id) => {
      artworkStore.delete(id);
    });
    vi.spyOn(repository, "listArtworkTrackIds").mockImplementation(async () => new Set(artworkStore.keys()));
  });

  it("5 & 6: bypasses stale positive localStorage cache and retries 24h negative cache entries through real provider discovery", async () => {
    const staleTrack = makeTrack("t-stale-pos", {
      title: "Midnight City",
      artist: "M83",
      album: "Hurry Up, We're Dreaming",
    });
    const negTrack = makeTrack("t-neg-cache", {
      title: "Starlight",
      artist: "Muse",
      album: "Black Holes and Revelations",
    });

    await repository.putTracks([staleTrack, negTrack]);

    // Seed stale positive localStorage mapping pointing to a dead 404 URL
    const staleKey = getAlbumArtworkCacheKey(staleTrack);
    localStorage.setItem(
      `artwork_cache_v2:${staleKey}`,
      JSON.stringify({
        key: staleKey,
        artist: "M83",
        album: "Hurry Up, We're Dreaming",
        releaseGroupMbid: null,
        releaseMbid: null,
        url: "https://archive.org/dead-stale-cover.jpg",
        provider: "musicbrainz-caa",
        confidence: 95,
        timestamp: Date.now(),
        negative: false,
      }),
    );

    // Seed 24h negative cache entry for negTrack
    const negKey = getAlbumArtworkCacheKey(negTrack);
    localStorage.setItem(
      `artwork_cache_v2:${negKey}`,
      JSON.stringify({
        key: negKey,
        artist: "Muse",
        album: "Black Holes and Revelations",
        releaseGroupMbid: null,
        releaseMbid: null,
        url: null,
        provider: "none",
        confidence: 0,
        timestamp: Date.now(),
        negative: true,
      }),
    );

    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ close: vi.fn() })));

    const restoredBlobA = makeSizedBlob(301);
    const restoredBlobB = makeSizedBlob(302);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("musicbrainz.org/ws/2/release-group") || url.includes("musicbrainz.org/ws/2/release")) {
          return { ok: true, status: 200, json: async () => ({ "release-groups": [], releases: [] }) } as unknown as Response;
        }
        if (url.includes("itunes.apple.com/search")) {
          if (url.toLowerCase().includes("midnight")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                resultCount: 1,
                results: [
                  {
                    trackId: 1,
                    trackName: "Midnight City",
                    artistName: "M83",
                    collectionName: "Hurry Up, We're Dreaming",
                    artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/m83/100x100bb.jpg",
                  },
                ],
              }),
            } as unknown as Response;
          }
          if (url.toLowerCase().includes("starlight")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                resultCount: 1,
                results: [
                  {
                    trackId: 2,
                    trackName: "Starlight",
                    artistName: "Muse",
                    collectionName: "Black Holes and Revelations",
                    artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/muse/100x100bb.jpg",
                  },
                ],
              }),
            } as unknown as Response;
          }
        }
        if (url === "https://is1-ssl.mzstatic.com/image/thumb/m83/600x600bb.jpg") {
          return { ok: true, status: 200, blob: async () => restoredBlobA } as unknown as Response;
        }
        if (url === "https://is1-ssl.mzstatic.com/image/thumb/muse/600x600bb.jpg") {
          return { ok: true, status: 200, blob: async () => restoredBlobB } as unknown as Response;
        }
        return { ok: false, status: 404, blob: async () => new Blob() } as unknown as Response;
      }),
    );

    const summary = await reloadMissingArtwork([staleTrack, negTrack]);

    expect(summary).toMatchObject({
      totalTracks: 2,
      validPreserved: 0,
      missingDetected: 2,
      restored: 2,
      stillMissing: 0,
      providerFailures: 0,
      offline: false,
    });

    expect((await repository.getArtwork("t-stale-pos"))?.size).toBe(301);
    expect((await repository.getArtwork("t-neg-cache"))?.size).toBe(302);
    expect(getCachedArtworkEntry(staleTrack)?.url).toBe("https://is1-ssl.mzstatic.com/image/thumb/m83/600x600bb.jpg");
    expect(getCachedArtworkEntry(negTrack)?.url).toBe("https://is1-ssl.mzstatic.com/image/thumb/muse/600x600bb.jpg");
  });

  it("1, 2 & 10: preserves valid IDB artwork, replaces corrupted IDB blob, and updates mounted <Artwork /> component", async () => {
    const validTrack = makeTrack("t-idb-ok", { title: "Valid Song", artist: "Artist V" });
    const corruptTrack = makeTrack("t-idb-bad", { title: "Broken Song", artist: "Artist B" });
    await repository.putTracks([validTrack, corruptTrack]);

    const validBlob = makeSizedBlob(256);
    const corruptBlob = makeSizedBlob(333); // size 333 marks simulated corrupt image
    const replacementBlob = makeSizedBlob(512);

    await repository.putArtwork(validTrack.id, validBlob);
    await repository.putArtwork(corruptTrack.id, corruptBlob);

    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async (blob: Blob) => {
        if (blob.size === 333) {
          throw new Error("corrupted image payload");
        }
        return { close: vi.fn() } as unknown as ImageBitmap;
      }),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("musicbrainz.org")) {
          return { ok: true, status: 200, json: async () => ({ "release-groups": [], releases: [] }) } as unknown as Response;
        }
        if (url.includes("itunes.apple.com/search")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              resultCount: 1,
              results: [
                {
                  trackId: 99,
                  trackName: "Broken Song",
                  artistName: "Artist B",
                  collectionName: "Clean Album",
                  artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/clean/100x100bb.jpg",
                },
              ],
            }),
          } as unknown as Response;
        }
        if (url === "https://is1-ssl.mzstatic.com/image/thumb/clean/600x600bb.jpg") {
          return { ok: true, status: 200, blob: async () => replacementBlob } as unknown as Response;
        }
        return { ok: false, status: 404, blob: async () => new Blob() } as unknown as Response;
      }),
    );

    // Mount <Artwork /> while offline first so it cleans the corrupt blob and shows the fallback placeholder
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    render(<Artwork trackId={corruptTrack.id} alt="Broken Song" />);
    await waitFor(() => {
      expect(screen.getByRole("img", { name: /Broken Song — no artwork/i })).toBeTruthy();
    });

    // Re-seed corrupted blob and go online while <Artwork /> stays mounted
    await repository.putArtwork(corruptTrack.id, corruptBlob);
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });

    const summary = await reloadMissingArtwork([validTrack, corruptTrack]);

    expect(summary).toMatchObject({
      totalTracks: 2,
      validPreserved: 1,
      corruptedDetected: 1,
      restored: 1,
      stillMissing: 0,
    });

    // Valid artwork blob preserved untouched; corrupt artwork replaced cleanly
    expect((await repository.getArtwork(validTrack.id))?.size).toBe(256);
    expect((await repository.getArtwork(corruptTrack.id))?.size).toBe(512);

    // Mounted <Artwork /> updates automatically via subscription without unmounting/remounting
    await waitFor(() => {
      const img = screen.getByAltText("Broken Song") as HTMLImageElement;
      expect(img.tagName).toBe("IMG");
      expect(img.src).toBe(getArtworkUrl(corruptTrack.id));
    });
  });

  it("11: provider 503 outage counts providerFailures without faking success or poisoning negative cache", async () => {
    const track = makeTrack("t-503", { title: "Network Down", artist: "Artist N" });
    await repository.putTracks([track]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}), blob: async () => new Blob() }) as unknown as Response),
    );

    const summary = await reloadMissingArtwork([track]);

    expect(summary).toMatchObject({
      totalTracks: 1,
      validPreserved: 0,
      missingDetected: 1,
      restored: 0,
      stillMissing: 1,
      providerFailures: 1,
      offline: false,
    });
    expect(await repository.getArtwork("t-503")).toBeUndefined();
    const negKey = getArtworkCacheKey(track);
    expect(localStorage.getItem(`artwork_cache_v2:${negKey}`)).toBeNull();
  });
});
