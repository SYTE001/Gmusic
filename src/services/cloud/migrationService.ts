import type { Track } from "../../types";
import { repository } from "../indexeddb/LibraryRepository";
import { getSessionFile, queryHandlePermission } from "../file-access/FileAccessService";
import { completeUpload, deleteCloudObject, requestUploadUrl, CloudStorageError } from "./r2StorageService";
import { upsertCloudTracks } from "./cloudLibraryService";

/**
 * MigrationService — uploads local audio to R2 (spec §6).
 *
 * Contract, deliberately strict:
 *  - The original file, the IndexedDB audio copy, and the file handle are
 *    NEVER touched. Removing a local copy is a separate, explicit action the
 *    user takes only after the cloud copy and metadata are confirmed.
 *  - Cloud metadata is written only after the Worker verifies the object.
 *  - Authentication, network, upload, or database failures leave every local
 *    record exactly as it was. Failures are collected for retry.
 *  - Bounded concurrency keeps large libraries from exhausting memory.
 */

export type MigrationItemStatus = "pending" | "needs-access" | "missing" | "done" | "failed";

export type MigrationItem = {
  trackId: string;
  title: string;
  artist: string;
  /** Track columns in the library list, not the upload itself. */
  artworkUploaded: boolean;
  status: MigrationItemStatus;
  /** Present once the item has succeeded; the R2 key it was uploaded under. */
  objectKey: string | null;
  /** Present only after the item failed; a human-readable reason. */
  error: string | null;
};

export type MigrationProgress = {
  state: "idle" | "running" | "cancelling" | "complete" | "cancelled";
  total: number;
  done: number;
  succeeded: number;
  failed: number;
  skipped: number;
  currentTrackId: string | null;
  currentTitle: string | null;
  items: MigrationItem[];
  startedAt: number | null;
  finishedAt: number | null;
};

export type MigrationOptions = {
  concurrency?: number;
  onProgress?: (progress: MigrationProgress) => void;
};

export const DEFAULT_MIGRATION_CONCURRENCY = 2;
const UPLOAD_ATTEMPTS = 2;

export function initialMigrationProgress(): MigrationProgress {
  return {
    state: "idle",
    total: 0,
    done: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    currentTrackId: null,
    currentTitle: null,
    items: [],
    startedAt: null,
    finishedAt: null,
  };
}

function describeFailure(error: unknown): string {
  if (error instanceof CloudStorageError) return error.message;
  if (error instanceof Error) return error.message;
  return "Unknown error";
}

/**
 * Canonical MIME type per audio extension, matching the allow-list the Worker
 * enforces (worker/src/keys.ts). Keys are lowercase, values are the type the
 * Worker signs and verifies for that extension.
 */
const AUDIO_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  m4b: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  wave: "audio/wav",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/opus",
  flac: "audio/flac",
  weba: "audio/webm",
  webm: "audio/webm",
};

/**
 * Resolves the MIME type an audio upload must declare. The file name's
 * extension decides for every format the app and the Worker recognize,
 * because the detected metadata is frequently wrong: browsers and OS pickers
 * routinely label `.m4a` files `audio/mpeg`, which the Worker rejects for
 * that extension. For an extension the app does not know, the detected type
 * is trusted when it is a real audio type; otherwise the upload falls back
 * to the MP3 default so the Worker, not the client, has the final say.
 */
export function resolveAudioMimeType(fileName: string, detectedMimeType?: string | null): string {
  const extension = fileName.match(/\.([^.]+)$/)?.[1]?.toLowerCase() ?? "";
  const known = AUDIO_MIME_BY_EXTENSION[extension];
  if (known) return known;
  const detected = (detectedMimeType ?? "").trim().toLowerCase();
  if (detected.startsWith("audio/")) return detected;
  return "audio/mpeg";
}

/**
 * Resolves the usable local audio for a track — a handle with granted
 * permission, a stored copy, or a session file — without prompting. Returns
 * null when nothing is reachable right now; `planMigration` reports those
 * tracks separately so the user can re-link them.
 */
export async function resolveLocalAudioForTrack(track: Track): Promise<File | null> {
  const handle = await repository.getHandle(track.id);
  if (handle) {
    if ((await queryHandlePermission(handle)) !== "granted") return null;
    try {
      return await handle.getFile();
    } catch {
      return null;
    }
  }
  const blob = await repository.getAudioBlob(track.id);
  if (blob) {
    return blob instanceof File
      ? blob
      : new File([blob], track.fileName, { type: resolveAudioMimeType(track.fileName, track.mimeType || blob.type) });
  }
  const sessionFile = getSessionFile(track.id);
  return sessionFile ?? null;
}

/**
 * Builds the migration plan. Tracks are classified rather than silently
 * skipped: a track whose audio cannot currently be reached shows up as
 * "needs-access" or "missing" with an explicit re-link path.
 */
export async function planMigration(tracks: Track[]): Promise<{
  items: MigrationItem[];
  needsAccess: MigrationItem[];
  missing: MigrationItem[];
}> {
  const items: MigrationItem[] = [];
  for (const track of tracks) {
    const item: MigrationItem = {
      trackId: track.id,
      title: track.title,
      artist: track.artist,
      artworkUploaded: false,
      status: "pending",
      objectKey: track.objectKey ?? null,
      error: null,
    };
    if (track.cloudStatus === "ready" && track.objectKey) {
      item.status = "done";
      items.push(item);
      continue;
    }
    const file = await resolveLocalAudioForTrack(track);
    if (file) {
      items.push(item);
      continue;
    }
    const handle = await repository.getHandle(track.id);
    item.status = handle ? "needs-access" : "missing";
    items.push(item);
  }
  return {
    items,
    needsAccess: items.filter((item) => item.status === "needs-access"),
    missing: items.filter((item) => item.status === "missing"),
  };
}

/** Cancels the in-flight migration. Pending items stay pending for a retry. */
let cancelRequested = false;

export function cancelMigration(): void {
  cancelRequested = true;
}

function recompute(progress: MigrationProgress): void {
  progress.total = progress.items.length;
  progress.succeeded = progress.items.filter((item) => item.status === "done").length;
  progress.failed = progress.items.filter((item) => item.status === "failed").length;
  progress.skipped = progress.items.filter((item) => item.status === "missing" || item.status === "needs-access").length;
  progress.done = progress.succeeded + progress.failed;
}

/**
 * Uploads one object (audio or artwork) with a bounded retry. Presigning
 * alone proves nothing — the Worker verifies the stored object before the
 * caller is allowed to treat the upload as complete.
 */
async function uploadOne(
  track: Track,
  file: File | Blob,
  mimeType: string,
  kind: "audio" | "artwork",
): Promise<string> {
  const { objectKey, uploadUrl, uploadIntent, requiredHeaders } = await requestUploadUrl({
    trackId: track.id,
    fileName: kind === "audio" ? track.fileName : "artwork",
    mimeType,
    sizeBytes: file.size,
    kind,
  });

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(uploadUrl, {
        method: "PUT",
        body: file,
        // The same MIME type that presigned the URL also labels the bytes on
        // the wire and is verified by the Worker afterwards.
        headers: { ...requiredHeaders, "content-type": mimeType },
      });
    } catch (error) {
      lastError = error;
      // Transient network failure: retry once, then report.
      if (attempt < UPLOAD_ATTEMPTS) continue;
      throw new CloudStorageError("network", "The file could not be uploaded. Check your connection and try again.");
    }
    if (response.ok) {
      try {
        const verified = await completeUpload({
          objectKey,
          uploadIntent,
          trackId: track.id,
          sizeBytes: file.size,
          mimeType,
        });
        return verified.objectKey;
      } catch (error) {
        // The bytes landed but the upload was rejected (wrong size, wrong
        // metadata, or the verify call could not be served). Remove the
        // unclaimed object so R2 never holds audio with no metadata pointing
        // at it. A failure here is best-effort: the /complete step keeps
        // rejecting it, so it can never be marked uploaded by mistake.
        await deleteCloudObject(objectKey).catch(() => undefined);
        throw error;
      }
    }
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
      throw new CloudStorageError("server", `The upload was rejected (${response.status}).`);
    }
    lastError = new CloudStorageError("server", `Upload failed (${response.status}). Retrying…`);
  }
  throw lastError instanceof Error
    ? lastError
    : new CloudStorageError("network", "The file could not be uploaded.");
}

/**
 * Runs the migration over the pending items of a plan, `concurrency` items at
 * a time. Runs are independent: the caller owns the progress object, and a
 * retry only needs `retryFailedItems` plus another `runMigration`.
 */
export async function runMigration(
  allTracks: Track[],
  progress: MigrationProgress,
  options: MigrationOptions = {},
): Promise<MigrationProgress> {
  if (progress.state === "running") return progress;
  const concurrency = Math.max(1, Math.min(8, options.concurrency ?? DEFAULT_MIGRATION_CONCURRENCY));
  cancelRequested = false;

  const queue = progress.items.filter((item) => item.status === "pending");
  const remaining = [...queue];

  const emit = () => {
    recompute(progress);
    options.onProgress?.({ ...progress, items: progress.items.map((item) => ({ ...item })) });
  };

  progress.state = "running";
  progress.startedAt = progress.startedAt ?? Date.now();
  emit();

  const processItem = async (item: MigrationItem) => {
    const track = allTracks.find((candidate) => candidate.id === item.trackId);
    if (!track) {
      item.status = "failed";
      item.error = "This track is no longer in your library.";
      return;
    }
    progress.currentTrackId = track.id;
    progress.currentTitle = track.title;
    emit();

    const file = await resolveLocalAudioForTrack(track);
    if (!file) {
      item.status = "failed";
      item.error = "The audio file could not be opened. Use “Locate file” to re-link it, then retry.";
      return;
    }

    try {
      // The upload MIME type follows the file name, not the blob's own
      // metadata, so a mislabeled `.m4a` is never sent as `audio/mpeg`.
      const mimeType = resolveAudioMimeType(track.fileName, file.type);
      const objectKey = await uploadOne(track, file, mimeType, "audio");

      // Artwork follows the audio only after the audio object is verified;
      // a failed artwork upload must not mark the whole track as failed.
      const artwork = await repository.getArtwork(track.id);
      let artworkKey: string | null = null;
      if (artwork) {
        try {
          artworkKey = await uploadOne(
            track,
            artwork,
            artwork.type || "image/jpeg",
            "artwork",
          );
          item.artworkUploaded = true;
        } catch {
          // Non-fatal: the track is playable; artwork can be re-synced later.
          artworkKey = track.artworkObjectKey ?? null;
        }
      }

      // Only after verification: persist cloud metadata, then update the
      // LOCAL record. Neither deletes the other's data.
      const updated: Track = {
        ...track,
        objectKey,
        artworkObjectKey: artworkKey,
        storageProvider: "r2",
        cloudStatus: "ready",
        lastSyncedAt: Date.now(),
      };
      await upsertCloudTracks([updated]);
      await repository.updateTrack(track.id, {
        objectKey,
        artworkObjectKey: artworkKey,
        storageProvider: "r2",
        cloudStatus: "ready",
        lastSyncedAt: Date.now(),
      });
      item.status = "done";
      item.objectKey = objectKey;
      item.error = null;
    } catch (error) {
      if (error instanceof CloudStorageError && error.kind === "cancelled") return;
      item.status = "failed";
      item.error = describeFailure(error);
      // Local data is deliberately untouched on failure.
    }
  };

  // Bounded concurrency: at most `concurrency` files are read or uploaded at
  // once, so a large library cannot exhaust the device's memory.
  const workers: Promise<void>[] = [];
  for (let index = 0; index < concurrency; index += 1) {
    workers.push(
      (async () => {
        while (remaining.length > 0) {
          if (cancelRequested) return;
          const item = remaining.shift();
          if (!item) return;
          await processItem(item);
        }
      })(),
    );
  }
  await Promise.all(workers);

  progress.currentTrackId = null;
  progress.currentTitle = null;
  progress.finishedAt = Date.now();
  progress.state = cancelRequested || remaining.length > 0 ? "cancelled" : "complete";
  recompute(progress);
  emit();
  return progress;
}

/** Requeues only the failed items of a finished run for another attempt. */
export function retryFailedItems(progress: MigrationProgress): MigrationProgress {
  for (const item of progress.items) {
    if (item.status === "failed") {
      item.status = "pending";
      item.error = null;
    }
  }
  progress.state = "idle";
  progress.finishedAt = null;
  return progress;
}
