import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import {
  authorizeDesktopPaths,
  createDesktopSliceFile,
  isDesktopImportItem,
  isTauriRuntime,
  type DesktopImportItem,
} from "./desktop";
import {
  relinkTrackWithFile,
  resolveTrackSource,
  revalidateAccess,
} from "../file-access/FileAccessService";
import { repository } from "../indexeddb/LibraryRepository";
import { buildBackup } from "../backup/backupService";
import { registerServiceWorker } from "../offline/offlineService";
import type { Track } from "../../types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((path: string) => `http://asset.localhost/${encodeURIComponent(path)}`),
}));

function makeDesktopTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: "desk-1",
    title: "Desktop Track",
    artist: "Artist",
    album: "Album",
    trackNumber: 1,
    albumTrackCount: null,
    durationMs: 180_000,
    fileName: "song.flac",
    fileSize: 4_096,
    mimeType: "audio/flac",
    addedAt: 1_000,
    lastPlayedAt: null,
    playCount: 0,
    isLiked: false,
    availability: "available",
    accessMode: "desktop-path",
    desktopPath: "C:\\Music\\song.flac",
    fingerprint: "fp-1",
    metadataFromFilename: false,
    ...overrides,
  };
}

function setTauriWindow(enabled: boolean): void {
  const win = window as unknown as Record<string, unknown>;
  if (enabled) {
    win.__TAURI_INTERNALS__ = {};
  } else {
    delete win.__TAURI_INTERNALS__;
  }
}

describe("desktop platform boundary", () => {
  afterEach(() => {
    setTauriWindow(false);
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("detects Tauri runtime only when __TAURI_INTERNALS__ is present", () => {
    setTauriWindow(false);
    expect(isTauriRuntime()).toBe(false);
    setTauriWindow(true);
    expect(isTauriRuntime()).toBe(true);
  });

  it("identifies desktop import items without confusing File or handle objects", () => {
    const desktopItem: DesktopImportItem = {
      kind: "desktop-file",
      path: "C:\\Music\\song.mp3",
      name: "song.mp3",
      size: 100,
      mimeType: "audio/mpeg",
    };
    expect(isDesktopImportItem(desktopItem)).toBe(true);
    expect(isDesktopImportItem(new File(["a"], "a.mp3"))).toBe(false);
    expect(isDesktopImportItem(null)).toBe(false);
  });

  it("reads bounded file slices via IPC", async () => {
    const mockBytes = new Uint8Array([1, 2, 3, 4]).buffer;
    vi.mocked(invoke).mockResolvedValueOnce(mockBytes);

    const file = createDesktopSliceFile({
      path: "C:\\Music\\song.flac",
      name: "song.flac",
      size: 100,
      mimeType: "audio/flac",
    });

    const buf = await file.slice(10, 14).arrayBuffer();
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(invoke).toHaveBeenCalledWith("read_audio_file_slice", {
      path: "C:\\Music\\song.flac",
      offset: 10,
      length: 4,
    });
  });

  it("authorizes and resolves desktop-path tracks into asset URLs", async () => {
    setTauriWindow(true);
    vi.mocked(invoke).mockResolvedValue([{ path: "C:\\Music\\song.flac", exists: true }]);

    const track = makeDesktopTrack();
    const resolved = await resolveTrackSource(track);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(convertFileSrc).toHaveBeenCalledWith("C:\\Music\\song.flac");
      expect(resolved.url).toContain("http://asset.localhost/");
    }

    const statuses = await authorizeDesktopPaths(["C:\\Music\\song.flac"]);
    expect(statuses.get("C:\\Music\\song.flac")).toBe(true);
  });

  it("marks missing desktop files honestly during startup revalidation", async () => {
    setTauriWindow(true);
    vi.spyOn(repository, "getAudioBlob").mockResolvedValue(undefined);
    vi.mocked(invoke).mockResolvedValueOnce([
      { path: "C:\\Music\\present.flac", exists: true },
      { path: "C:\\Music\\moved.flac", exists: false },
    ]);

    const updates = await revalidateAccess([
      makeDesktopTrack({ id: "t-ok", desktopPath: "C:\\Music\\present.flac" }),
      makeDesktopTrack({ id: "t-missing", desktopPath: "C:\\Music\\moved.flac" }),
    ]);

    expect(updates.get("t-ok")).toBe("available");
    expect(updates.get("t-missing")).toBe("missing");
  });

  it("does not request fallback audio blobs for healthy desktop paths and reports only changed availability", async () => {
    setTauriWindow(true);
    const getAudioBlob = vi.spyOn(repository, "getAudioBlob").mockResolvedValue(undefined);
    vi.mocked(invoke).mockResolvedValueOnce([
      { path: "C:\\Music\\present.flac", exists: true },
      { path: "C:\\Music\\moved.flac", exists: false },
    ]);

    const present = makeDesktopTrack({ id: "present", desktopPath: "C:\\Music\\present.flac" });
    const missing = makeDesktopTrack({ id: "missing", desktopPath: "C:\\Music\\moved.flac" });
    const updates = await revalidateAccess([present, missing], { changedOnly: true });

    expect(getAudioBlob).toHaveBeenCalledTimes(1);
    expect(getAudioBlob).toHaveBeenCalledWith("missing");
    expect(updates.has("present")).toBe(false);
    expect(updates.get("missing")).toBe("missing");
  });

  it("leaves desktop availability unchanged when native path validation is temporarily unavailable", async () => {
    setTauriWindow(true);
    const getAudioBlob = vi.spyOn(repository, "getAudioBlob").mockResolvedValue(undefined);
    vi.mocked(invoke).mockRejectedValueOnce(new Error("temporary IPC failure"));
    const track = makeDesktopTrack({ id: "ipc-failure", desktopPath: "C:\\Music\\song.flac" });

    const updates = await revalidateAccess([track], { changedOnly: true });

    expect(updates.size).toBe(0);
    expect(getAudioBlob).not.toHaveBeenCalled();
  });

  it("relinks a track to a desktop file path", async () => {
    const deleteBlobSpy = vi.spyOn(repository, "deleteAudioBlob").mockResolvedValue(undefined);
    const updateTrackSpy = vi.spyOn(repository, "updateTrack").mockResolvedValue(undefined);

    const track = makeDesktopTrack({ availability: "missing", desktopPath: "C:\\Old\\song.flac" });
    const { updated, warning } = await relinkTrackWithFile(track, {
      kind: "desktop-file",
      path: "C:\\New\\song.flac",
      name: "song.flac",
      size: 4_096,
      mimeType: "audio/flac",
    });

    expect(warning).toBeNull();
    expect(updated.availability).toBe("available");
    expect(updated.accessMode).toBe("desktop-path");
    expect(updated.desktopPath).toBe("C:\\New\\song.flac");
    expect(deleteBlobSpy).toHaveBeenCalledWith(track.id);
    expect(updateTrackSpy).toHaveBeenCalledWith(track.id, {
      availability: "available",
      accessMode: "desktop-path",
      desktopPath: "C:\\New\\song.flac",
      broken: null,
    });
  });

  it("strips desktopPath from portable JSON backups", async () => {
    const track = makeDesktopTrack();
    vi.spyOn(repository, "listTracks").mockResolvedValue([track]);
    vi.spyOn(repository, "listPlaylists").mockResolvedValue([]);
    vi.spyOn(repository, "getPreferences").mockResolvedValue(undefined);
    vi.spyOn(repository, "getLyrics").mockResolvedValue(undefined);

    const backup = await buildBackup();
    expect(backup.tracks).toHaveLength(1);
    expect("desktopPath" in backup.tracks[0]).toBe(false);
    expect(backup.tracks[0].accessMode).toBe("session-only");
    expect(backup.tracks[0].availability).toBe("missing");
  });

  it("skips service worker registration inside Tauri runtime", () => {
    setTauriWindow(true);
    const registerSpy = vi.fn().mockResolvedValue({});
    Object.defineProperty(navigator, "serviceWorker", {
      value: { register: registerSpy },
      configurable: true,
    });

    registerServiceWorker();
    expect(registerSpy).not.toHaveBeenCalled();
  });
});
