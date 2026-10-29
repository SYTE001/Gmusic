import type { RepeatMode } from "../../types";

/**
 * Pure playback-queue transitions (rules §7: deterministic queue operations).
 * Kept side-effect free so behavior is unit-testable.
 */

export type QueueShape = {
  queueTrackIds: string[];
  queueIndex: number;
  repeatMode: RepeatMode;
};

/** Index for an automatic or explicit advance; null means stop playback. */
export function nextIndex(queue: QueueShape): number | null {
  const { queueTrackIds, queueIndex, repeatMode } = queue;
  if (queueTrackIds.length === 0) return null;
  const next = queueIndex + 1;
  if (next < queueTrackIds.length) return next;
  if (repeatMode === "all") return 0;
  return null;
}

/** Index for the previous action; 0 clamps when already at the start. */
export function previousIndex(queue: QueueShape): number | null {
  const { queueTrackIds, queueIndex, repeatMode } = queue;
  if (queueTrackIds.length === 0) return null;
  const prev = queueIndex - 1;
  if (prev >= 0) return prev;
  if (repeatMode === "all") return queueTrackIds.length - 1;
  return 0;
}

export function shuffleArray<T>(items: T[], rng: () => number = Math.random): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Shuffled play order with `first` pinned at the start (the track the user
 * started from), then the rest in random order.
 */
export function shuffledQueue(contextTrackIds: string[], first: string | null, rng: () => number = Math.random): string[] {
  const remaining = contextTrackIds.filter((id) => id !== first);
  const shuffledRest = shuffleArray(remaining, rng);
  if (first !== null && contextTrackIds.includes(first)) return [first, ...shuffledRest];
  return shuffledRest;
}

export function insertNext(queueTrackIds: string[], queueIndex: number, trackId: string): { queueTrackIds: string[]; queueIndex: number } {
  const copy = [...queueTrackIds];
  copy.splice(queueIndex + 1, 0, trackId);
  return { queueTrackIds: copy, queueIndex };
}

export function appendToQueue(queueTrackIds: string[], trackId: string): string[] {
  return [...queueTrackIds, trackId];
}

export function removeQueueAt(
  queueTrackIds: string[],
  queueIndex: number,
  removeIndex: number,
): { queueTrackIds: string[]; queueIndex: number } {
  if (removeIndex < 0 || removeIndex >= queueTrackIds.length) return { queueTrackIds, queueIndex };
  const copy = [...queueTrackIds];
  copy.splice(removeIndex, 1);
  let newIndex = queueIndex;
  if (removeIndex < queueIndex) newIndex -= 1;
  else if (removeIndex === queueIndex) {
    // The current track was removed: point at whatever took its place.
    newIndex = Math.min(queueIndex, copy.length - 1);
    if (newIndex < 0) newIndex = 0;
  }
  return { queueTrackIds: copy, queueIndex: newIndex };
}

export function moveQueueItem(
  queueTrackIds: string[],
  queueIndex: number,
  from: number,
  to: number,
): { queueTrackIds: string[]; queueIndex: number } {
  if (from === to || from < 0 || to < 0 || from >= queueTrackIds.length || to >= queueTrackIds.length) {
    return { queueTrackIds, queueIndex };
  }
  const copy = [...queueTrackIds];
  const [moved] = copy.splice(from, 1);
  copy.splice(to, 0, moved);
  let newIndex = queueIndex;
  if (queueIndex === from) newIndex = to;
  else if (from < queueIndex && to >= queueIndex) newIndex = queueIndex - 1;
  else if (from > queueIndex && to <= queueIndex) newIndex = queueIndex + 1;
  return { queueTrackIds: copy, queueIndex: newIndex };
}

export function clearUpcoming(queueTrackIds: string[], queueIndex: number): string[] {
  return queueTrackIds.slice(0, queueIndex + 1);
}
