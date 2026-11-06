import type { Track } from "../../types";
import { repository } from "../indexeddb/LibraryRepository";
import { getSessionFile, queryHandlePermission, requestHandlePermission } from "../file-access/FileAccessService";
import { completeUpload, deleteCloudObject, getPlayUrl, requestUploadUrl, CloudStorageError } from "./r2StorageService";
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

export type UploadDiagnostics = {
  trackId: string;
  title: string;
  extension: string;
  mimeType: string;
  fileSize: number;
  attempt: number;
  requestStage: "request-upload-url" | "put" | "verification" | "metadata-upsert";
  httpStatus: number | null;
  errorName: string;
  errorMessage: string;
  isVerificationFailure: boolean;
};

export function logUploadDiagnostics(diag: UploadDiagnostics): void {
  if (typeof import.meta !== "undefined" && import.meta.env?.DEV) {
    console.info("[UploadDiagnostics]", diag);
  }
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
export async function resolveLocalAudioForTrack(
  track: Track,
  options: { promptForPermission?: boolean } = {},
): Promise<File | null> {
  const handle = await repository.getHandle(track.id);
  if (handle) {
    let permission = await queryHandlePermission(handle);
    // Only valid inside a user gesture (the migration is started by a click).
    if (permission !== "granted" && options.promptForPermission) permission = await requestHandlePermission(handle);
    if (permission === "granted") {
      try {
        const file = await handle.getFile();
        if (track.availability !== "available") {
          await repository.updateTrack(track.id, { availability: "available" }).catch(() => undefined);
        }
        return file;
      } catch {
        // Fall through to check stored copy or session file
      }
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
 * True when R2 already holds an object under `objectKey` whose byte length
 * equals the local file's. Probes with a one-byte ranged GET on a fresh play
 * URL; any failure means "not verified", so the caller uploads normally.
 */
async function existingObjectMatches(objectKey: string, expectedSize: number): Promise<boolean> {
  try {
    const url = await getPlayUrl(objectKey, { forceFresh: true });
    const response = await fetch(url, { headers: { range: "bytes=0-0" } });
    if (response.status === 206) {
      const total = Number(response.headers.get("content-range")?.split("/")[1]);
      return total === expectedSize;
    }
    if (response.ok) return Number(response.headers.get("content-length")) === expectedSize;
    return false;
  } catch {
    return false;
  }
}

/**
 * Uploads one object (audio or artwork) with a bounded retry. Presigning
 * alone proves nothing — the Worker verifies the stored object before the
 * caller is allowed to treat the upload as complete.
 *
 * Every attempt mints a fresh upload URL and a fresh signed intent: the
 * presigned PUT and the intent carry the same short expiry (120s by default),
 * and reusing either one after a retry delay fails the whole upload with
 * "The upload intent has expired." One URL must never outlive the attempt
 * that requested it.
 */
async function uploadOne(
  track: Track,
  file: File | Blob,
  mimeType: string,
  kind: "audio" | "artwork",
): Promise<string> {
  const extension = (kind === "audio" ? track.fileName : "artwork")
    .match(/\.([^.]+)$/)?.[1]
    ?.toLowerCase() ?? "";

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
    // A fresh intent and URL per attempt. `requestUploadUrl` also re-checks
    // size and MIME against the Worker's allow-list, so a retry can never
    // reuse a URL whose terms no longer match the file.
    let uploadInfo: {
      objectKey: string;
      uploadUrl: string;
      uploadIntent?: string;
      requiredHeaders: Record<string, string>;
    };
    try {
      uploadInfo = await requestUploadUrl({
        trackId: track.id,
        fileName: kind === "audio" ? track.fileName : "artwork",
        mimeType,
        sizeBytes: file.size,
        kind,
      });
    } catch (error) {
      lastError = error;
      const errorName = error instanceof Error ? error.name : "UnknownError";
      const errorMessage = error instanceof Error ? error.message : String(error);
      const httpStatus = error instanceof CloudStorageError ? error.status : null;
      logUploadDiagnostics({
        trackId: track.id,
        title: track.title,
        extension,
        mimeType,
        fileSize: file.size,
        attempt,
        requestStage: "request-upload-url",
        httpStatus,
        errorName,
        errorMessage,
        isVerificationFailure: false,
      });
      // Permanent 4xx failures from Worker (e.g. 400 bad MIME or 413 too large)
      // should not be retried blindly.
      if (httpStatus && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 && httpStatus !== 429) {
        throw error;
      }
      if (attempt < UPLOAD_ATTEMPTS) continue;
      throw error;
    }

    const { objectKey, uploadUrl, uploadIntent, requiredHeaders } = uploadInfo;
    const requiredContentType = requiredHeaders["content-type"] ?? mimeType;

    let response: Response;
    try {
      response = await fetch(uploadUrl, {
        method: "PUT",
        body: file,
        // The same MIME type that presigned the URL also labels the bytes on
        // the wire and is verified by the Worker afterwards.
        headers: { ...requiredHeaders, "content-type": requiredContentType },
      });
    } catch (error) {
      lastError = error;
      const errorName = error instanceof Error ? error.name : "UnknownError";
      const errorMessage = error instanceof Error ? error.message : String(error);
      logUploadDiagnostics({
        trackId: track.id,
        title: track.title,
        extension,
        mimeType: requiredContentType,
        fileSize: file.size,
        attempt,
        requestStage: "put",
        httpStatus: null,
        errorName,
        errorMessage,
        isVerificationFailure: false,
      });

      // Transient network failure: retry once with a fresh URL, then report.
      if (attempt < UPLOAD_ATTEMPTS) continue;

      const isOffline = typeof navigator !== "undefined" && navigator.onLine === false;
      const reasonMsg = isOffline
        ? "You are currently offline. Check your connection and try again."
        : `Upload PUT failed (${errorName}: ${errorMessage}).`;
      throw new CloudStorageError("network", reasonMsg);
    }

    if (!response.ok) {
      const status = response.status;
      let responseBody = "";
      try {
        responseBody = await response.text();
      } catch {
        // Body reading is best-effort
      }
      const detail = responseBody ? `HTTP ${status}: ${responseBody.slice(0, 150)}` : `HTTP ${status}`;
      logUploadDiagnostics({
        trackId: track.id,
        title: track.title,
        extension,
        mimeType: requiredContentType,
        fileSize: file.size,
        attempt,
        requestStage: "put",
        httpStatus: status,
        errorName: "HttpError",
        errorMessage: detail,
        isVerificationFailure: false,
      });

      // Do not retry permanent 4xx validation failures blindly (Phase 4).
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        throw new CloudStorageError("server", `The upload was rejected (${detail}).`, status);
      }
      lastError = new CloudStorageError("server", `Upload failed (${detail}). Retrying…`, status);
      continue;
    }

    try {
      const verified = await completeUpload({
        objectKey,
        uploadIntent,
        trackId: track.id,
        sizeBytes: file.size,
        mimeType: requiredContentType,
      });
      return verified.objectKey;
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      const errorMessage = error instanceof Error ? error.message : String(error);
      const httpStatus = error instanceof CloudStorageError ? error.status : null;
      logUploadDiagnostics({
        trackId: track.id,
        title: track.title,
        extension,
        mimeType: requiredContentType,
        fileSize: file.size,
        attempt,
        requestStage: "verification",
        httpStatus,
        errorName,
        errorMessage,
        isVerificationFailure: true,
      });

      // The bytes landed but the upload was rejected (wrong size, wrong
      // metadata, or the verify call could not be served). Remove the
      // unclaimed object so R2 never holds audio with no metadata pointing
      // at it. A failure here is best-effort: the /complete step keeps
      // rejecting it, so it can never be marked uploaded by mistake.
      await deleteCloudObject(objectKey).catch(() => undefined);
      throw error;
    }
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

  const queue = progress.items.filter(
    (item) => item.status === "pending" || item.status === "needs-access",
  );
  const remaining = [...queue];

  // Pre-request handle permissions upfront while the user gesture is active,
  // before any slow network upload can consume transient activation.
  for (const item of remaining) {
    if (cancelRequested) break;
    const track = allTracks.find((candidate) => candidate.id === item.trackId);
    if (!track) continue;
    const handle = await repository.getHandle(track.id);
    if (handle) {
      const current = await queryHandlePermission(handle);
      if (current !== "granted") {
        const granted = await requestHandlePermission(handle);
        if (granted === "granted") {
          item.status = "pending";
          item.error = null;
          if (track.availability !== "available") {
            await repository.updateTrack(track.id, { availability: "available" }).catch(() => undefined);
          }
        }
      } else if (item.status === "needs-access") {
        item.status = "pending";
        item.error = null;
      }
    }
  }

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

    const file = await resolveLocalAudioForTrack(track, { promptForPermission: true });
    if (!file) {
      const handle = await repository.getHandle(track.id);
      item.status = handle ? "needs-access" : "failed";
      item.error = handle
        ? "File access was not granted. Allow access to the file, then retry."
        : "The audio file could not be opened. Use “Locate file” to re-link it, then retry.";
      return;
    }

    const mimeType = resolveAudioMimeType(track.fileName, file.type);
    try {
      // The upload MIME type follows the file name, not the blob's own
      // metadata, so a mislabeled `.m4a` is never sent as `audio/mpeg`.
      await repository.updateTrack(track.id, { cloudStatus: "uploading" });

      // Retry after a partial failure: the object may already be in R2 with
      // only the metadata step missing. Reuse it (verified, never re-PUT).
      let objectKey: string | null = null;
      if (track.objectKey && (await existingObjectMatches(track.objectKey, file.size))) {
        objectKey = track.objectKey;
      } else {
        objectKey = await uploadOne(track, file, mimeType, "audio");
        // Remember the verified key before touching Postgres so a database
        // failure can be retried without uploading the audio a second time.
        await repository.updateTrack(track.id, { objectKey, storageProvider: "r2", cloudStatus: "uploading" });
      }

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
        availability: "available",
        objectKey,
        artworkObjectKey: artworkKey,
        storageProvider: "r2",
        cloudStatus: "ready",
        lastSyncedAt: Date.now(),
      };
      await upsertCloudTracks([updated]);
      await repository.updateTrack(track.id, {
        availability: "available",
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
      if (!(error instanceof CloudStorageError)) {
        logUploadDiagnostics({
          trackId: track.id,
          title: track.title,
          extension: track.fileName.match(/\.([^.]+)$/)?.[1]?.toLowerCase() ?? "",
          mimeType,
          fileSize: file.size,
          attempt: 1,
          requestStage: "metadata-upsert",
          httpStatus: null,
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorMessage: error instanceof Error ? error.message : String(error),
          isVerificationFailure: false,
        });
      }
      item.status = "failed";
      item.error = describeFailure(error);
      // Local audio is deliberately untouched on failure. Only the status is
      // recorded; any verified objectKey stays so the retry skips the upload.
      await repository.updateTrack(track.id, { cloudStatus: "failed" }).catch(() => undefined);
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

/** Requeues failed and access-blocked items of a finished run for another attempt. */
export function retryFailedItems(progress: MigrationProgress): MigrationProgress {
  for (const item of progress.items) {
    if (item.status === "failed" || item.status === "needs-access") {
      item.status = "pending";
      item.error = null;
    }
  }
  progress.state = "idle";
  progress.finishedAt = null;
  return progress;
}
