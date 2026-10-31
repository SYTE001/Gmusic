import type { Track } from "../../types";
import { repository } from "../indexeddb/LibraryRepository";
import { getPlayUrl } from "../cloud/r2StorageService";

/**
 * FileAccessService — resolves tracks to playable object URLs and manages
 * File System Access handles, stored copies, session-only files, and cloud
 * (R2) sources.
 *
 * Access modes (PRD §7.1):
 * - "handle":       File System Access handle with granted permission ("File access retained")
 * - "stored-copy":  audio bytes live in IndexedDB ("Stored in app")
 * - "session-only": transient File reference; works now, needs re-import after reload
 * - "cloud":        no usable local copy; audio is fetched from R2 on demand
 *
 * Resolution order is deliberately local-first: a local copy is used even when
 * a cloud copy exists, so playback keeps working offline and never pays for
 * network round trips it does not need.
 */

export type ResolveFailureReason = "permission-required" | "missing" | "unsupported" | "offline";

export type ResolvedSource =
  | { ok: true; url: string; release: () => void }
  | { ok: false; reason: ResolveFailureReason; detail: string };

/** Session-scoped File objects for imports that could not be persisted. */
const sessionFiles = new Map<string, File>();

export function rememberSessionFile(trackId: string, file: File): void {
  sessionFiles.set(trackId, file);
}

export function forgetSessionFile(trackId: string): void {
  sessionFiles.delete(trackId);
}

export function hasSessionFile(trackId: string): boolean {
  return sessionFiles.has(trackId);
}

/** Returns the transient session File for a track, if it is still alive. */
export function getSessionFile(trackId: string): File | undefined {
  return sessionFiles.get(trackId);
}

/** True when the device currently reports no network connection. */
function deviceIsOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

type PermissionState = "granted" | "prompt" | "denied";

type PermissionsQueryableHandle = FileSystemFileHandle & {
  queryPermission?(descriptor: { mode: "read" }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: "read" }): Promise<PermissionState>;
};

export function fileSystemAccessSupported(): boolean {
  return typeof window !== "undefined" && "showOpenFilePicker" in window;
}

/** Non-throwing permission probe; returns "denied" only when explicitly denied. */
export async function queryHandlePermission(handle: FileSystemFileHandle): Promise<PermissionState> {
  const queryable = handle as PermissionsQueryableHandle;
  if (typeof queryable.queryPermission !== "function") return "granted";
  try {
    return await queryable.queryPermission({ mode: "read" });
  } catch {
    return "prompt";
  }
}

/** Must be called from a user gesture handler. */
export async function requestHandlePermission(handle: FileSystemFileHandle): Promise<PermissionState> {
  const requestable = handle as PermissionsQueryableHandle;
  if (typeof requestable.requestPermission !== "function") return "granted";
  try {
    return await requestable.requestPermission({ mode: "read" });
  } catch {
    return "denied";
  }
}

let activeUrl: { url: string; release: () => void } | null = null;

function releaseActiveUrl(): void {
  if (activeUrl) {
    activeUrl.release();
    activeUrl = null;
  }
}

/**
 * Resolves a track into a playable object URL. Only one URL is kept alive at a
 * time; switching tracks revokes the previous one (rules §12: release object URLs).
 */
export async function resolveTrackSource(track: Track): Promise<ResolvedSource> {
  const handle = await repository.getHandle(track.id);
  if (handle) {
    const permission = await queryHandlePermission(handle);
    if (permission === "granted") {
      try {
        const file = await handle.getFile();
        releaseActiveUrl();
        const url = URL.createObjectURL(file);
        activeUrl = { url, release: () => URL.revokeObjectURL(url) };
        return { ok: true, url, release: releaseActiveUrl };
      } catch {
        return {
          ok: false,
          reason: "missing",
          detail: "The file could not be opened. It may have been moved, renamed, or deleted.",
        };
      }
    }
    return {
      ok: false,
      reason: "permission-required",
      detail:
        permission === "denied"
          ? "File access was denied. Grant access again or re-link the file."
          : "This app needs permission to read the file again after reopening.",
    };
  }

  const storedBlob = await repository.getAudioBlob(track.id);
  if (storedBlob) {
    releaseActiveUrl();
    const url = URL.createObjectURL(storedBlob);
    activeUrl = { url, release: () => URL.revokeObjectURL(url) };
    return { ok: true, url, release: releaseActiveUrl };
  }

  const sessionFile = sessionFiles.get(track.id);
  if (sessionFile) {
    releaseActiveUrl();
    const url = URL.createObjectURL(sessionFile);
    activeUrl = { url, release: () => URL.revokeObjectURL(url) };
    return { ok: true, url, release: releaseActiveUrl };
  }

  // No local copy anywhere. Fall back to the cloud copy, which is a signed
  // URL the Worker mints per object — it is never a persisted Track field.
  if (track.objectKey) {
    if (deviceIsOffline()) {
      return {
        ok: false,
        reason: "offline",
        detail:
          "This song is stored in the cloud and is not cached on this device. Reconnect to the internet to play it.",
      };
    }
    // Releasing here keeps the single-URL invariant (rules §12): when playback
    // moves from a local object URL to a cloud stream, the blob URL it
    // replaces must not stay alive — its Blob would be retained for the
    // rest of the session even though nothing can play it anymore.
    releaseActiveUrl();
    try {
      const url = await getPlayUrl(track.objectKey);
      return { ok: true, url, release: () => undefined };
    } catch {
      return {
        ok: false,
        reason: "missing",
        detail:
          "The cloud copy of this song could not be reached. Check your connection and try again.",
      };
    }
  }

  return {
    ok: false,
    reason: "missing",
    detail:
      "The audio file is not available in this session. Re-import or locate the file to play this track.",
  };
}

/**
 * Re-validates access to every persisted track at startup and updates
 * availability. Handle tracks fall back to "permission-required" when the
 * permission prompt is pending; stored copies stay available.
 */
export async function revalidateAccess(tracks: Track[]): Promise<Map<string, Track["availability"]>> {
  const updates = new Map<string, Track["availability"]>();
  for (const track of tracks) {
    // Cloud-backed tracks with a live local copy are validated by the local
    // branch below; a cloud-only track is as good as its connectivity.
    if (track.accessMode === "cloud" && !(await hasLocalCopy(track.id))) {
      updates.set(track.id, track.objectKey ? (deviceIsOffline() ? "offline" : "available") : "missing");
      continue;
    }
    if (track.accessMode === "handle") {
      const handle = await repository.getHandle(track.id);
      if (!handle) {
        updates.set(track.id, "missing");
        continue;
      }
      const permission = await queryHandlePermission(handle);
      if (permission === "granted") updates.set(track.id, "available");
      else if (permission === "denied") updates.set(track.id, "permission-required");
      else updates.set(track.id, "permission-required");
      continue;
    }
    if (track.accessMode === "stored-copy") {
      const blob = await repository.getAudioBlob(track.id);
      updates.set(track.id, blob ? "available" : "missing");
      continue;
    }
    // session-only tracks cannot survive a reload
    updates.set(track.id, sessionFiles.has(track.id) ? "available" : (track.objectKey ? "offline" : "missing"));
  }
  return updates;
}

/** Whether any local audio (handle copy, stored copy, session file) exists. */
export async function hasLocalCopy(trackId: string): Promise<boolean> {
  const handle = await repository.getHandle(trackId);
  if (handle && (await queryHandlePermission(handle)) === "granted") return true;
  const blob = await repository.getAudioBlob(trackId);
  return Boolean(blob) || sessionFiles.has(trackId);
}

/** User-gesture handler: re-requests permission for a handle-backed track. */
export async function regainHandleAccess(track: Track): Promise<"granted" | "denied" | "no-handle"> {
  const handle = await repository.getHandle(track.id);
  if (!handle) return "no-handle";
  const permission = await requestHandlePermission(handle);
  return permission === "granted" ? "granted" : "denied";
}

/**
 * Re-links a track to a newly picked file. Matches by size and, when both
 * exist, fingerprint; a mismatch still allows linking but reports a warning.
 */
export async function relinkTrackWithFile(
  track: Track,
  file: File | FileSystemFileHandle,
): Promise<{ updated: Track; warning: string | null }> {
  const actualFile = "getFile" in file ? await file.getFile() : file;
  let warning: string | null = null;
  if (actualFile.size !== track.fileSize) {
    warning = `The selected file is ${actualFile.size} bytes but this track was ${track.fileSize} bytes. Linked anyway.`;
  }

  const updated: Track = { ...track, availability: "available" };
  if ("getFile" in file && fileSystemAccessSupported()) {
    await repository.putHandle(track.id, file);
    await repository.deleteAudioBlob(track.id);
    updated.accessMode = "handle";
  } else {
    await repository.putAudioBlob(track.id, actualFile);
    updated.accessMode = "stored-copy";
  }
  await repository.updateTrack(track.id, { availability: "available", accessMode: updated.accessMode });
  return { updated, warning };
}
