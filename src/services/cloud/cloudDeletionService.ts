import type { Track } from "../../types";
import { repository, type PendingCloudDeletion } from "../indexeddb/LibraryRepository";
import { deleteCloudObject } from "./r2StorageService";
import { deleteCloudTrackMetadata } from "./cloudLibraryService";
import { currentAuthState } from "./cloudAuthService";

/**
 * Deletes the cloud copy of a track: R2 objects first, then metadata.
 * Both halves are idempotent.
 */
export async function removeTrackFromCloud(track: Track): Promise<void> {
  const auth = await currentAuthState();
  if (auth.status !== "authenticated") return;

  const objectKey = track.objectKey ?? null;
  try {
    if (objectKey) {
      await deleteCloudObject(objectKey);
    }
    await deleteCloudTrackMetadata(track.id);
  } catch (error) {
    const pending: PendingCloudDeletion = {
      trackId: track.id,
      objectKey,
      firstAttemptedAt: Date.now(),
      lastError: error instanceof Error ? error.message : "The deletion could not be completed.",
    };
    await repository.putPendingCloudDeletion(pending).catch(() => undefined);
    throw error;
  }
}

/**
 * Finishes every half-completed cloud deletion recorded in IndexedDB.
 */
export async function retryPendingCloudDeletions(): Promise<{ cleared: number; remaining: number }> {
  const pending = await repository.listPendingCloudDeletions();
  if (pending.length === 0) return { cleared: 0, remaining: 0 };

  let cleared = 0;
  for (const entry of pending) {
    let failed: string | null = null;
    if (entry.objectKey) {
      failed = await deleteCloudObject(entry.objectKey).then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : "The object could not be removed."),
      );
    }
    if (failed === null) {
      failed = await deleteCloudTrackMetadata(entry.trackId).then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : "The metadata could not be removed."),
      );
    }
    if (failed !== null) {
      await repository.putPendingCloudDeletion({
        trackId: entry.trackId,
        objectKey: entry.objectKey,
        firstAttemptedAt: entry.firstAttemptedAt,
        lastError: failed,
      });
      continue;
    }
    await repository.removePendingCloudDeletion(entry.trackId);
    cleared += 1;
  }
  const remaining = (await repository.listPendingCloudDeletions()).length;
  return { cleared, remaining };
}
