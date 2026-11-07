import type { Track } from "../../types";
import { repository, type PendingMetadataSync } from "../indexeddb/LibraryRepository";
import { cloudConfigured, currentAuthState } from "./cloudAuthService";
import { upsertCloudTracks } from "./cloudLibraryService";

/**
 * CloudMetadataSyncService — synchronizes track metadata (title and description)
 * to Supabase with offline retention and automatic retry queuing.
 */

export async function syncTrackMetadata(track: Track): Promise<void> {
  if (!cloudConfigured()) return;
  const auth = await currentAuthState();
  if (auth.status !== "authenticated") return;

  try {
    await upsertCloudTracks([track]);
    await repository.removePendingMetadataSync(track.id).catch(() => undefined);
  } catch (error) {
    const pendingItem: PendingMetadataSync = {
      trackId: track.id,
      title: track.title,
      description: track.description ?? "",
      queuedAt: Date.now(),
      lastError: error instanceof Error ? error.message : "Synchronization failed.",
    };
    await repository.putPendingMetadataSync(pendingItem).catch(() => undefined);
    throw error;
  }
}

export async function retryPendingMetadataSync(): Promise<{ cleared: number; remaining: number }> {
  if (!cloudConfigured()) {
    const count = (await repository.listPendingMetadataSync()).length;
    return { cleared: 0, remaining: count };
  }
  const auth = await currentAuthState();
  if (auth.status !== "authenticated") {
    const count = (await repository.listPendingMetadataSync()).length;
    return { cleared: 0, remaining: count };
  }

  const pending = await repository.listPendingMetadataSync();
  if (pending.length === 0) return { cleared: 0, remaining: 0 };

  let cleared = 0;
  for (const item of pending) {
    const track = await repository.getTrack(item.trackId);
    if (!track) {
      // Track was deleted locally; clear the queue entry
      await repository.removePendingMetadataSync(item.trackId);
      cleared += 1;
      continue;
    }

    try {
      await upsertCloudTracks([track]);
      await repository.removePendingMetadataSync(item.trackId);
      cleared += 1;
    } catch (error) {
      await repository.putPendingMetadataSync({
        ...item,
        lastError: error instanceof Error ? error.message : "Synchronization failed.",
      });
    }
  }

  const remaining = (await repository.listPendingMetadataSync()).length;
  return { cleared, remaining };
}
