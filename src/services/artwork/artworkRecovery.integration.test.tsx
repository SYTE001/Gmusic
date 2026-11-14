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
import { __configureItunesForTests } from "./itunesClient";
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
    __configureItunesForTests({ rateLimitMs: 0, retryDelayMs: 0 });
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

  it("Scenario 1 & 2: restores via MusicBrainz RG + CAA 200 and falls back cleanly to iTunes when MusicBrainz returns empty", async () => {
    const RG_ID = "11111111-1111-4111-8111-111111111111";
    const mbTrack = makeTrack("s1-mb", {
      title: "Midnight City",
      artist: "M83",
      album: "Hurry Up, We're Dreaming",
    });
    const itunesTrack = makeTrack("s2-itunes", {
      title: "Don’t Start Now",
      artist: "Dua Lipa",
      album: "Future Nostalgia",
    });
    await repository.putTracks([mbTrack, itunesTrack]);

    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ close: vi.fn() })));
    const mbBlob = makeSizedBlob(401);
    const itunesBlob = makeSizedBlob(402);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = decodeURIComponent(String(input)).replace(/\+/g, " ").toLowerCase();
        if (url.includes("/ws/2/release-group") || url.includes("/api/musicbrainz/release-group")) {
          if (url.includes("hurry up")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                "release-groups": [
                  {
                    id: RG_ID,
                    title: "Hurry Up, We're Dreaming",
                    score: 100,
                    "primary-type": "Album",
                    "artist-credit": [{ name: "M83" }],
                  },
                ],
              }),
            } as unknown as Response;
          }
          return { ok: true, status: 200, json: async () => ({ "release-groups": [] }) } as unknown as Response;
        }
        if (url.includes("/ws/2/release") || url.includes("/api/musicbrainz/release")) {
          return { ok: true, status: 200, json: async () => ({ releases: [] }) } as unknown as Response;
        }
        if (url.includes(`coverartarchive.org/release-group/${RG_ID}`)) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              images: [
                {
                  front: true,
                  approved: true,
                  image: "https://coverartarchive.org/release/m83-full.jpg",
                  thumbnails: { "500": "https://coverartarchive.org/release/m83-500.jpg" },
                },
              ],
            }),
          } as unknown as Response;
        }
        if (url.includes("itunes.apple.com/search")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              resultCount: 1,
              results: [
                {
                  trackId: 202,
                  trackName: "Don't Start Now",
                  artistName: "Dua Lipa",
                  collectionName: "Future Nostalgia",
                  artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/dualipa/100x100bb.jpg",
                },
              ],
            }),
          } as unknown as Response;
        }
        if (String(input) === "https://coverartarchive.org/release/m83-500.jpg") {
          return { ok: true, status: 200, blob: async () => mbBlob } as unknown as Response;
        }
        if (String(input) === "https://is1-ssl.mzstatic.com/image/thumb/dualipa/600x600bb.jpg") {
          return { ok: true, status: 200, blob: async () => itunesBlob } as unknown as Response;
        }
        return { ok: false, status: 404, blob: async () => new Blob() } as unknown as Response;
      }),
    );

    const summary = await reloadMissingArtwork([mbTrack, itunesTrack]);

    expect(summary).toMatchObject({
      totalTracks: 2,
      missingDetected: 2,
      restored: 2,
      stillMissing: 0,
      providerFailedTracks: 0,
      failedHttpRequests: 0,
    });
    expect((await repository.getArtwork("s1-mb"))?.size).toBe(401);
    expect((await repository.getArtwork("s2-itunes"))?.size).toBe(402);

    const mbDiag = summary.diagnostics.find((d) => d.trackId === "s1-mb");
    expect(mbDiag?.musicbrainz.classification).toBe("ok");
    expect(mbDiag?.caa.releaseGroupClassification).toBe("ok");
    expect(mbDiag?.selectedArtworkHost).toBe("coverartarchive.org");

    const itunesDiag = summary.diagnostics.find((d) => d.trackId === "s2-itunes");
    expect(itunesDiag?.musicbrainz.classification).toBe("not-found");
    expect(itunesDiag?.itunes.classification).toBe("ok");
    expect(itunesDiag?.selectedArtworkHost).toBe("is1-ssl.mzstatic.com");
  });

  it("Scenario 3: recovers via CAA Release fallback when MusicBrainz RG CAA returns 404", async () => {
    const RG_ID = "22222222-2222-4222-8222-222222222222";
    const REL_ID = "33333333-3333-4333-8333-333333333333";
    const track = makeTrack("s3-rel-caa", {
      title: "Time",
      artist: "Pink Floyd",
      album: "The Dark Side of the Moon",
    });
    await repository.putTracks([track]);

    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ close: vi.fn() })));
    const relBlob = makeSizedBlob(403);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/ws/2/release-group") || url.includes("/api/musicbrainz/release-group")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              "release-groups": [
                {
                  id: RG_ID,
                  title: "The Dark Side of the Moon",
                  score: 100,
                  "primary-type": "Album",
                  "artist-credit": [{ name: "Pink Floyd" }],
                },
              ],
            }),
          } as unknown as Response;
        }
        if (url.includes("coverartarchive.org/release-group/")) {
          return { ok: false, status: 404, json: async () => ({}), blob: async () => new Blob() } as unknown as Response;
        }
        if (url.includes("/ws/2/release") || url.includes("/api/musicbrainz/release")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              releases: [
                {
                  id: REL_ID,
                  title: "The Dark Side of the Moon",
                  score: 100,
                  "artist-credit": [{ name: "Pink Floyd" }],
                  "cover-art-archive": { artwork: true, front: true },
                  "release-group": { id: RG_ID, "primary-type": "Album" },
                },
              ],
            }),
          } as unknown as Response;
        }
        if (url.includes(`coverartarchive.org/release/${REL_ID}`)) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              images: [
                {
                  front: true,
                  approved: true,
                  image: "https://coverartarchive.org/release/dsotm-full.jpg",
                  thumbnails: { "500": "https://coverartarchive.org/release/dsotm-500.jpg" },
                },
              ],
            }),
          } as unknown as Response;
        }
        if (url === "https://coverartarchive.org/release/dsotm-500.jpg") {
          return { ok: true, status: 200, blob: async () => relBlob } as unknown as Response;
        }
        return { ok: false, status: 404, blob: async () => new Blob() } as unknown as Response;
      }),
    );

    const summary = await reloadMissingArtwork([track]);

    expect(summary).toMatchObject({ restored: 1, stillMissing: 0, providerFailedTracks: 0 });
    expect((await repository.getArtwork("s3-rel-caa"))?.size).toBe(403);
    expect(summary.diagnostics[0].caa.releaseGroupClassification).toBe("not-found");
    expect(summary.diagnostics[0].caa.releaseClassification).toBe("ok");
  });

  it("Scenario 4 & 5: cleans YouTube channel/title noise, unbracketed feat., compound bands, and collaborator order", async () => {
    const ytTrack = makeTrack("s4-yt", {
      title: "Taylor Swift - Blank Space (Official Video) [HD]",
      artist: "TaylorSwiftVEVO",
      album: "",
    });
    const collabTrack = makeTrack("s5-collab", {
      title: "See You Again feat. Kali Uchis [2024 Remaster]",
      artist: "Tyler, The Creator",
      album: "",
    });
    const reorderedTrack = makeTrack("s5-reorder", {
      title: "One Kiss (Explicit)",
      artist: "Calvin Harris & Dua Lipa",
      album: "",
    });
    await repository.putTracks([ytTrack, collabTrack, reorderedTrack]);

    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ close: vi.fn() })));
    const blobYt = makeSizedBlob(404);
    const blobCollab = makeSizedBlob(405);
    const blobReorder = makeSizedBlob(406);
    const queriedUrls: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const rawUrl = String(input);
        queriedUrls.push(rawUrl);
        const url = decodeURIComponent(rawUrl).toLowerCase();
        if (url.includes("musicbrainz.org/ws/2/release")) {
          return { ok: true, status: 200, json: async () => ({ "release-groups": [], releases: [] }) } as unknown as Response;
        }
        if (url.includes("itunes.apple.com/search")) {
          if (url.includes("blank space")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                resultCount: 1,
                results: [
                  {
                    trackId: 404,
                    trackName: "Blank Space",
                    artistName: "Taylor Swift",
                    collectionName: "1989",
                    artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/ts/100x100bb.jpg",
                  },
                ],
              }),
            } as unknown as Response;
          }
          if (url.includes("see you again")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                resultCount: 1,
                results: [
                  {
                    trackId: 405,
                    trackName: "See You Again (feat. Kali Uchis)",
                    artistName: "Tyler, The Creator",
                    collectionName: "Flower Boy",
                    artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/tyler/100x100bb.jpg",
                  },
                ],
              }),
            } as unknown as Response;
          }
          if (url.includes("one kiss")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                resultCount: 1,
                results: [
                  {
                    trackId: 406,
                    trackName: "One Kiss",
                    artistName: "Dua Lipa, Calvin Harris",
                    collectionName: "Dua Lipa",
                    artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/onekiss/100x100bb.jpg",
                  },
                ],
              }),
            } as unknown as Response;
          }
        }
        if (rawUrl === "https://is1-ssl.mzstatic.com/image/thumb/ts/600x600bb.jpg") {
          return { ok: true, status: 200, blob: async () => blobYt } as unknown as Response;
        }
        if (rawUrl === "https://is1-ssl.mzstatic.com/image/thumb/tyler/600x600bb.jpg") {
          return { ok: true, status: 200, blob: async () => blobCollab } as unknown as Response;
        }
        if (rawUrl === "https://is1-ssl.mzstatic.com/image/thumb/onekiss/600x600bb.jpg") {
          return { ok: true, status: 200, blob: async () => blobReorder } as unknown as Response;
        }
        return { ok: false, status: 404, blob: async () => new Blob() } as unknown as Response;
      }),
    );

    const summary = await reloadMissingArtwork([ytTrack, collabTrack, reorderedTrack]);

    expect(summary).toMatchObject({ restored: 3, stillMissing: 0, providerFailedTracks: 0 });
    expect((await repository.getArtwork("s4-yt"))?.size).toBe(404);
    expect((await repository.getArtwork("s5-collab"))?.size).toBe(405);
    expect((await repository.getArtwork("s5-reorder"))?.size).toBe(406);
    expect(queriedUrls.some((u) => decodeURIComponent(u).toLowerCase().includes("taylorswiftvevo"))).toBe(false);
  });

  it("Scenario 6: verifies missing-album song via MusicBrainz release recording lookup before CAA recovery", async () => {
    const REL_ID = "44444444-4444-4444-8444-444444444444";
    const RG_ID = "55555555-5555-4555-8555-555555555555";
    const track = makeTrack("s6-no-album", {
      title: "Secret Deep Cut",
      artist: "Indie Band",
      album: "",
    });
    await repository.putTracks([track]);

    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ close: vi.fn() })));
    const albumBlob = makeSizedBlob(407);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/ws/2/release-group") || url.includes("/api/musicbrainz/release-group")) {
          return { ok: true, status: 200, json: async () => ({ "release-groups": [] }) } as unknown as Response;
        }
        if (url.includes(`/ws/2/release/${REL_ID}`) || url.includes(`/api/musicbrainz/release/${REL_ID}`)) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: REL_ID,
              title: "Parent Album",
              "artist-credit": [{ name: "Indie Band" }],
              "cover-art-archive": { artwork: true, front: true },
              media: [{ tracks: [{ title: "Secret Deep Cut" }] }],
            }),
          } as unknown as Response;
        }
        if (url.includes("/ws/2/release?") || url.includes("/api/musicbrainz/release?")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              releases: [
                {
                  id: REL_ID,
                  title: "Parent Album",
                  score: 96,
                  "artist-credit": [{ name: "Indie Band" }],
                  "cover-art-archive": { artwork: true, front: true },
                  "release-group": { id: RG_ID, "primary-type": "Album" },
                },
              ],
            }),
          } as unknown as Response;
        }
        if (url.includes(`coverartarchive.org/release/${REL_ID}`)) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              images: [
                {
                  front: true,
                  approved: true,
                  image: "https://coverartarchive.org/release/parent-full.jpg",
                  thumbnails: { "500": "https://coverartarchive.org/release/parent-500.jpg" },
                },
              ],
            }),
          } as unknown as Response;
        }
        if (url === "https://coverartarchive.org/release/parent-500.jpg") {
          return { ok: true, status: 200, blob: async () => albumBlob } as unknown as Response;
        }
        return { ok: false, status: 404, blob: async () => new Blob() } as unknown as Response;
      }),
    );

    const summary = await reloadMissingArtwork([track]);

    expect(summary).toMatchObject({ restored: 1, stillMissing: 0, providerFailedTracks: 0 });
    expect((await repository.getArtwork("s6-no-album"))?.size).toBe(407);
    expect(summary.diagnostics[0].musicbrainz.directReleaseFallback.classification).toBe("ok");
  });

  it("Scenario 7: classifies rejected low-confidence candidates as CANDIDATE_REJECTED without counting network failure", async () => {
    const RG_ID = "66666666-6666-4666-8666-666666666666";
    const track = makeTrack("s7-reject", {
      title: "Rare Song",
      artist: "Real Artist",
      album: "Real Album",
    });
    await repository.putTracks([track]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/ws/2/release-group") || url.includes("/api/musicbrainz/release-group")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              "release-groups": [
                {
                  id: RG_ID,
                  title: "Completely Different Compilation",
                  score: 40,
                  "primary-type": "Compilation",
                  "artist-credit": [{ name: "Various Artists" }],
                },
              ],
            }),
          } as unknown as Response;
        }
        if (url.includes("/ws/2/release") || url.includes("/api/musicbrainz/release")) {
          return { ok: true, status: 200, json: async () => ({ releases: [] }) } as unknown as Response;
        }
        if (url.includes("itunes.apple.com/search")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              resultCount: 1,
              results: [
                {
                  trackId: 999,
                  trackName: "Totally Unrelated Track",
                  artistName: "Unrelated Band",
                  collectionName: "Unrelated Record",
                  artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/bad/100x100bb.jpg",
                },
              ],
            }),
          } as unknown as Response;
        }
        return { ok: false, status: 404, blob: async () => new Blob() } as unknown as Response;
      }),
    );

    const summary = await reloadMissingArtwork([track]);

    expect(summary).toMatchObject({
      restored: 0,
      stillMissing: 1,
      noMatchCount: 1,
      providerFailedTracks: 0,
      failedHttpRequests: 0,
    });
    expect(summary.failedTracks[0].primaryReason).toBe("CANDIDATE_REJECTED");
  });

  it("Scenario 8: classifies HTTP 429 rate limits and timeouts cleanly with exact affected-track vs HTTP counts", async () => {
    const rateTrack = makeTrack("s8-429", { title: "Song A", artist: "Artist A", album: "Album A" });
    const timeoutTrack = makeTrack("s8-timeout", { title: "Song B", artist: "Artist B", album: "Album B" });
    await repository.putTracks([rateTrack, timeoutTrack]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = decodeURIComponent(String(input)).replace(/\+/g, " ").toLowerCase();
        if (url.includes("artist a") || url.includes("song a")) {
          return { ok: false, status: 429, json: async () => ({}), blob: async () => new Blob() } as unknown as Response;
        }
        const abortErr = new Error("Aborted");
        abortErr.name = "AbortError";
        throw abortErr;
      }),
    );

    const summary = await reloadMissingArtwork([rateTrack, timeoutTrack]);

    expect(summary).toMatchObject({
      restored: 0,
      stillMissing: 2,
      providerFailedTracks: 2,
    });
    expect(summary.failedHttpRequests).toBeGreaterThanOrEqual(4);
    expect(summary.diagnostics.find((d) => d.trackId === "s8-429")?.primaryReason).toBe("PROVIDER_RATE_LIMITED");
    expect(summary.diagnostics.find((d) => d.trackId === "s8-timeout")?.primaryReason).toBe("PROVIDER_TIMEOUT");
  });

  it("Scenario 9: excludes dead CDN URLs on fallback (9A) and classifies total download failure as IMAGE_DOWNLOAD_FAILED (9B)", async () => {
    const fallbackTrack = makeTrack("s9-fallback", {
      title: "Phoenix",
      artist: "Daft Punk",
      album: "Wolfgang",
    });
    const deadTrack = makeTrack("s9-dead-img", {
      title: "Broken Cover",
      artist: "Missing CDN",
      album: "Dead Album",
    });
    await repository.putTracks([fallbackTrack, deadTrack]);

    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ close: vi.fn() })));
    const goodBlob = makeSizedBlob(409);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const rawUrl = String(input);
        const url = decodeURIComponent(rawUrl).toLowerCase();
        if (url.includes("musicbrainz.org/ws/2/release")) {
          return { ok: true, status: 200, json: async () => ({ "release-groups": [], releases: [] }) } as unknown as Response;
        }
        if (url.includes("itunes.apple.com/search")) {
          if (url.includes("daft punk")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                resultCount: 2,
                results: [
                  {
                    trackId: 901,
                    trackName: "Phoenix",
                    artistName: "Daft Punk",
                    collectionName: "Wolfgang",
                    artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/dead-first/100x100bb.jpg",
                  },
                  {
                    trackId: 902,
                    trackName: "Phoenix",
                    artistName: "Daft Punk",
                    collectionName: "Wolfgang",
                    artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/live-second/100x100bb.jpg",
                  },
                ],
              }),
            } as unknown as Response;
          }
          if (url.includes("missing cdn")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                resultCount: 1,
                results: [
                  {
                    trackId: 903,
                    trackName: "Broken Cover",
                    artistName: "Missing CDN",
                    collectionName: "Dead Album",
                    artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/never-loads/100x100bb.jpg",
                  },
                ],
              }),
            } as unknown as Response;
          }
        }
        if (rawUrl === "https://is1-ssl.mzstatic.com/image/thumb/live-second/600x600bb.jpg") {
          return { ok: true, status: 200, blob: async () => goodBlob } as unknown as Response;
        }
        return { ok: false, status: 404, blob: async () => new Blob() } as unknown as Response;
      }),
    );

    const summary = await reloadMissingArtwork([fallbackTrack, deadTrack]);

    expect(summary).toMatchObject({
      restored: 1,
      stillMissing: 1,
      imageValidationErrorCount: 1,
    });
    expect((await repository.getArtwork("s9-fallback"))?.size).toBe(409);
    const deadDiag = summary.diagnostics.find((d) => d.trackId === "s9-dead-img");
    expect(deadDiag?.primaryReason).toBe("IMAGE_DOWNLOAD_FAILED");
    expect(deadDiag?.selectedArtworkHost).toBe("is1-ssl.mzstatic.com");
  });

  it("Scenario 10: classifies undecodable remote payload as IMAGE_DECODE_FAILED", async () => {
    const track = makeTrack("s10-decode", {
      title: "HTML Mask Cover",
      artist: "Decode Artist",
      album: "Decode Album",
    });
    await repository.putTracks([track]);

    vi.stubGlobal("createImageBitmap", vi.fn(async () => {
      throw new Error("Invalid image data");
    }));
    const htmlBlob = new Blob(["<html>not an image</html>"], { type: "text/html" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const rawUrl = String(input);
        if (rawUrl.includes("musicbrainz.org/ws/2/release")) {
          return { ok: true, status: 200, json: async () => ({ "release-groups": [], releases: [] }) } as unknown as Response;
        }
        if (rawUrl.includes("itunes.apple.com/search")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              resultCount: 1,
              results: [
                {
                  trackId: 1001,
                  trackName: "HTML Mask Cover",
                  artistName: "Decode Artist",
                  collectionName: "Decode Album",
                  artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/html-bad/100x100bb.jpg",
                },
              ],
            }),
          } as unknown as Response;
        }
        if (rawUrl === "https://is1-ssl.mzstatic.com/image/thumb/html-bad/600x600bb.jpg") {
          return { ok: true, status: 200, blob: async () => htmlBlob } as unknown as Response;
        }
        return { ok: false, status: 404, blob: async () => new Blob() } as unknown as Response;
      }),
    );

    const summary = await reloadMissingArtwork([track]);

    expect(summary).toMatchObject({
      restored: 0,
      stillMissing: 1,
      imageValidationErrorCount: 1,
      providerFailedTracks: 0,
    });
    expect(summary.failedTracks[0].primaryReason).toBe("IMAGE_DECODE_FAILED");
    expect(await repository.getArtwork("s10-decode")).toBeUndefined();
  });

  it("Scenario 11: skips external provider calls and records METADATA_INSUFFICIENT for generic placeholder tags", async () => {
    const track = makeTrack("s11-meta", {
      title: "Track 01",
      artist: "Unknown Artist",
      album: "",
      fileName: "Track 01.mp3",
    });
    await repository.putTracks([track]);

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const summary = await reloadMissingArtwork([track]);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      restored: 0,
      stillMissing: 1,
      noMatchCount: 1,
      providerFailedTracks: 0,
      failedHttpRequests: 0,
    });
    expect(summary.failedTracks[0].primaryReason).toBe("METADATA_INSUFFICIENT");
    expect(summary.failedTracks[0].musicbrainz.skipped).toBe(true);
  });

  it("Scenario 12: records INDEXEDDB_WRITE_FAILED when persistence throws QuotaExceededError", async () => {
    const track = makeTrack("s12-idb", {
      title: "Quota Song",
      artist: "Storage Artist",
      album: "Storage Album",
    });
    await repository.putTracks([track]);
    vi.spyOn(repository, "putArtwork").mockRejectedValue(new DOMException("Quota exceeded", "QuotaExceededError"));

    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ close: vi.fn() })));
    const validBlob = makeSizedBlob(412);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const rawUrl = String(input);
        if (rawUrl.includes("musicbrainz.org/ws/2/release")) {
          return { ok: true, status: 200, json: async () => ({ "release-groups": [], releases: [] }) } as unknown as Response;
        }
        if (rawUrl.includes("itunes.apple.com/search")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              resultCount: 1,
              results: [
                {
                  trackId: 1201,
                  trackName: "Quota Song",
                  artistName: "Storage Artist",
                  collectionName: "Storage Album",
                  artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/quota/100x100bb.jpg",
                },
              ],
            }),
          } as unknown as Response;
        }
        if (rawUrl === "https://is1-ssl.mzstatic.com/image/thumb/quota/600x600bb.jpg") {
          return { ok: true, status: 200, blob: async () => validBlob } as unknown as Response;
        }
        return { ok: false, status: 404, blob: async () => new Blob() } as unknown as Response;
      }),
    );

    const summary = await reloadMissingArtwork([track]);

    expect(summary).toMatchObject({
      restored: 0,
      stillMissing: 1,
      storageErrorCount: 1,
      providerFailedTracks: 0,
    });
    expect(summary.failedTracks[0].primaryReason).toBe("INDEXEDDB_WRITE_FAILED");
    expect(summary.failedTracks[0].indexedDb.attempted).toBe(true);
    expect(summary.failedTracks[0].indexedDb.ok).toBe(false);
  });

  it("Mixed Library Accuracy: separates preserved valid artwork, genuine CAA/iTunes no-match, and provider failures cleanly", async () => {
    const RG_NO_CAA = "77777777-7777-4777-8777-777777777777";
    const validTrack = makeTrack("mix-valid", { title: "Kept", artist: "Kept Artist" });
    const caaMissing = makeTrack("mix-caa-404", {
      title: "Obscure B-Side",
      artist: "Cult Band",
      album: "Basement Tapes",
    });
    const noneFound = makeTrack("mix-none", {
      title: "Completely Unreleased Demo",
      artist: "Garage Solo",
      album: "Bedroom Demo",
    });
    const outageTrack = makeTrack("mix-503", {
      title: "Server Flake",
      artist: "Flaky Label",
      album: "Flake LP",
    });

    await repository.putTracks([validTrack, caaMissing, noneFound, outageTrack]);
    await repository.putArtwork(validTrack.id, makeSizedBlob(512));
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ close: vi.fn() })));

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = decodeURIComponent(String(input)).replace(/\+/g, " ").toLowerCase();
        if (url.includes("flaky") || url.includes("server flake")) {
          return { ok: false, status: 503, json: async () => ({}), blob: async () => new Blob() } as unknown as Response;
        }
        if (url.includes("/ws/2/release-group") || url.includes("/api/musicbrainz/release-group")) {
          if (url.includes("basement tapes")) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                "release-groups": [
                  {
                    id: RG_NO_CAA,
                    title: "Basement Tapes",
                    score: 100,
                    "primary-type": "Album",
                    "artist-credit": [{ name: "Cult Band" }],
                  },
                ],
              }),
            } as unknown as Response;
          }
          return { ok: true, status: 200, json: async () => ({ "release-groups": [] }) } as unknown as Response;
        }
        if (url.includes("/ws/2/release") || url.includes("/api/musicbrainz/release")) {
          return { ok: true, status: 200, json: async () => ({ releases: [] }) } as unknown as Response;
        }
        if (url.includes(`coverartarchive.org/release-group/${RG_NO_CAA}`)) {
          return { ok: false, status: 404, json: async () => ({}), blob: async () => new Blob() } as unknown as Response;
        }
        if (url.includes("itunes.apple.com/search")) {
          return { ok: true, status: 200, json: async () => ({ resultCount: 0, results: [] }) } as unknown as Response;
        }
        return { ok: false, status: 404, blob: async () => new Blob() } as unknown as Response;
      }),
    );

    const summary = await reloadMissingArtwork([validTrack, caaMissing, noneFound, outageTrack]);

    expect(summary).toMatchObject({
      totalTracks: 4,
      validPreserved: 1,
      missingDetected: 3,
      restored: 0,
      stillMissing: 3,
      noMatchCount: 2,
      providerFailedTracks: 1,
      failedHttpRequests: 4,
    });
    expect((await repository.getArtwork("mix-valid"))?.size).toBe(512);
    expect(summary.failedTracks.find((d) => d.trackId === "mix-caa-404")?.primaryReason).toBe("CAA_ARTWORK_NOT_FOUND");
    expect(summary.failedTracks.find((d) => d.trackId === "mix-none")?.primaryReason).toBe("NO_PROVIDER_MATCH");
    expect(summary.failedTracks.find((d) => d.trackId === "mix-503")?.primaryReason).toBe("NETWORK_ERROR");
  });
});
