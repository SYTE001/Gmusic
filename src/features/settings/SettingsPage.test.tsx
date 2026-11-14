import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsPage } from "./SettingsPage";
import { useLibraryStore } from "../../stores/libraryStore";
import { repository } from "../../services/indexeddb/LibraryRepository";
import { __resetArtworkCacheForTests } from "../../services/artwork/artworkCache";
import { __resetArtworkServiceForTests } from "../../services/artwork/artworkService";
import { __configureMusicBrainzForTests } from "../../services/artwork/musicbrainzClient";
import { toast } from "../../stores/toastStore";
import type { Track } from "../../types";

vi.mock("./CloudAccountSection", () => ({
  CloudAccountSection: () => null,
}));

vi.mock("./CloudMigrationSection", () => ({
  CloudMigrationSection: () => null,
}));

vi.mock("./LibraryMetadataSection", () => ({
  LibraryMetadataSection: () => null,
}));

vi.mock("../../stores/toastStore", () => ({
  toast: vi.fn(),
}));

const makeTrack = (id: string, overrides: Partial<Track> = {}): Track =>
  ({
    id,
    title: `Song ${id}`,
    artist: "Artist",
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

const makeSizedBlob = (sizeBytes: number): Blob =>
  new Blob([new Uint8Array(sizeBytes).fill(1)], { type: "image/jpeg" });

describe("SettingsPage — Reload missing artwork (end-to-end)", () => {
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
    URL.createObjectURL = vi.fn(() => `blob:settings-${Math.random()}`) as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
    useLibraryStore.setState({ tracks: [] });

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

  it("disables the button when the library has no tracks", () => {
    render(<SettingsPage />);
    const button = screen.getByRole("button", { name: /reload missing artwork/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("validates IndexedDB blobs, preserves valid art, replaces corrupt art, and reports accurate summary counts", async () => {
    const validTrack = makeTrack("s-valid", { title: "Valid", artist: "Artist 1" });
    const corruptTrack = makeTrack("s-corrupt", { title: "BadBlob", artist: "Artist 2" });
    const missingTrack = makeTrack("s-missing", { title: "Lost", artist: "Artist 3" });

    await repository.putTracks([validTrack, corruptTrack, missingTrack]);
    await repository.putArtwork(validTrack.id, makeSizedBlob(256));
    await repository.putArtwork(corruptTrack.id, makeSizedBlob(333));
    useLibraryStore.setState({ tracks: [validTrack, corruptTrack, missingTrack] });

    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async (blob: Blob) => {
        if (blob.size === 333) throw new Error("corrupt");
        return { close: vi.fn() } as unknown as ImageBitmap;
      }),
    );

    const newBlob = makeSizedBlob(512);
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
                  trackId: 10,
                  trackName: url.toLowerCase().includes("badblob") ? "BadBlob" : "Lost",
                  artistName: url.toLowerCase().includes("badblob") ? "Artist 2" : "Artist 3",
                  artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/x/100x100bb.jpg",
                },
              ],
            }),
          } as unknown as Response;
        }
        if (url === "https://is1-ssl.mzstatic.com/image/thumb/x/600x600bb.jpg") {
          return { ok: true, status: 200, blob: async () => newBlob } as unknown as Response;
        }
        return { ok: false, status: 404, blob: async () => new Blob() } as unknown as Response;
      }),
    );

    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: /reload missing artwork/i }));

    await waitFor(() => {
      const expectedSummary =
        "Scanned 3: 1 valid preserved · Detected 1 missing, 1 broken/corrupted · Restored 2, 0 still missing.";
      expect(screen.getByText(expectedSummary)).toBeTruthy();
      expect(toast).toHaveBeenCalledWith("success", expectedSummary);
    });

    expect((await repository.getArtwork(validTrack.id))?.size).toBe(256);
    expect((await repository.getArtwork(corruptTrack.id))?.size).toBe(512);
    expect((await repository.getArtwork(missingTrack.id))?.size).toBe(512);
  });

  it("reports validated counts instead of assuming IndexedDB keys mean valid when all tracks truly pass validation", async () => {
    const t1 = makeTrack("s-all-valid");
    await repository.putTracks([t1]);
    await repository.putArtwork(t1.id, makeSizedBlob(256));
    useLibraryStore.setState({ tracks: [t1] });
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ close: vi.fn() })));

    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: /reload missing artwork/i }));

    await waitFor(() => {
      const msg = "Scanned 1 track: all 1 validated and preserved.";
      expect(screen.getByText(msg)).toBeTruthy();
      expect(toast).toHaveBeenCalledWith("info", msg);
    });
  });

  it("reports provider failures honestly without claiming success", async () => {
    const t1 = makeTrack("s-err", { title: "Fail Song", artist: "Artist" });
    await repository.putTracks([t1]);
    useLibraryStore.setState({ tracks: [t1] });
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ close: vi.fn() })));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}), blob: async () => new Blob() }) as unknown as Response),
    );

    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: /reload missing artwork/i }));

    await waitFor(() => {
      const msg =
        "Scanned 1: 0 valid preserved · Detected 1 missing · Restored 0, 1 still missing · 1 provider failure.";
      expect(screen.getByText(msg)).toBeTruthy();
      expect(toast).toHaveBeenCalledWith("error", msg);
    });
  });

  it("reports offline status without deleting persisted valid artwork", async () => {
    const valid = makeTrack("s-off-ok");
    const missing = makeTrack("s-off-miss");
    await repository.putTracks([valid, missing]);
    await repository.putArtwork(valid.id, makeSizedBlob(256));
    useLibraryStore.setState({ tracks: [valid, missing] });
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ close: vi.fn() })));
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });

    render(<SettingsPage />);
    fireEvent.click(screen.getByRole("button", { name: /reload missing artwork/i }));

    await waitFor(() => {
      const msg = "Connect to the internet to recover missing or broken artwork (1 valid kept).";
      expect(screen.getByText(msg)).toBeTruthy();
      expect(toast).toHaveBeenCalledWith("error", msg);
    });
    expect((await repository.getArtwork(valid.id))?.size).toBe(256);
  });
});
