import type { PlaybackContext } from "../../types";
import { STORES, requestToPromise, withTransaction } from "../indexeddb/db";

/**
 * Saved playback session (queue + position), stored in the prefs store.
 * Persisted at sensible intervals — never per animation frame (PRD §7.6).
 */

export type PlaybackSession = {
  queueTrackIds: string[];
  queueIndex: number;
  contextTrackIds: string[];
  context: PlaybackContext | null;
  currentTrackId: string | null;
  positionMs: number;
  savedAt: number;
};

type SessionRecord = { name: "playback"; session: PlaybackSession };

export async function savePlaybackSession(session: PlaybackSession): Promise<void> {
  await withTransaction([STORES.prefs], "readwrite", (tx) => {
    tx.objectStore(STORES.prefs).put({ name: "playback", session } satisfies SessionRecord);
  });
}

export async function loadPlaybackSession(): Promise<PlaybackSession | null> {
  try {
    const record = await withTransaction([STORES.prefs], "readonly", (tx) =>
      requestToPromise(tx.objectStore(STORES.prefs).get("playback") as IDBRequest<SessionRecord | undefined>),
    );
    return record?.session ?? null;
  } catch {
    return null;
  }
}

export async function clearPlaybackSession(): Promise<void> {
  await withTransaction([STORES.prefs], "readwrite", (tx) => {
    tx.objectStore(STORES.prefs).delete("playback");
  });
}
