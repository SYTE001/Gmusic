import type { PlaybackContext } from "../../types";
import { repository } from "../indexeddb/LibraryRepository";

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

export async function savePlaybackSession(session: PlaybackSession): Promise<void> {
  await repository.putPlaybackSession(session);
}

export async function loadPlaybackSession(): Promise<PlaybackSession | null> {
  return repository.getPlaybackSession();
}

export async function clearPlaybackSession(): Promise<void> {
  await repository.clearPlaybackSession();
}
