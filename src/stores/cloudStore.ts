import { create } from "zustand";
// libraryStore imports cloudStore statically; cloudStore needs the library
// only inside actions, never at module-eval time, so the cycle is safe.
import { useLibraryStore } from "./libraryStore";
import type { Playlist, Track, TrackLyrics } from "../types";
import { repository, type PendingCloudDeletion } from "../services/indexeddb/LibraryRepository";
import { toast } from "./toastStore";
import {
  CloudAuthError,
  cloudConfigured,
  currentAuthState,
  signInWithEmail,
  signOutCloud,
  signUpWithEmail,
  snapshotAuth,
  subscribeToAuthChanges,
  workerConfigured,
  type CloudAuthState,
} from "../services/cloud/cloudAuthService";
import {
  deleteCloudTrackMetadata,
  fetchCloudLibrary,
  snapshotToLocalEntities,
  upsertCloudLyrics,
  upsertCloudPlaylists,
  upsertCloudTracks,
} from "../services/cloud/cloudLibraryService";
import { deleteCloudObject, resetCloudStorageState } from "../services/cloud/r2StorageService";
import {
  cancelMigration as cancelMigrationRun,
  initialMigrationProgress,
  planMigration,
  runMigration,
  retryFailedItems,
  type MigrationProgress,
} from "../services/cloud/migrationService";

/**
 * CloudStore — authentication state, library synchronization, and the local →
 * cloud migration (spec §4/§5/§6).
 *
 * Every failure is contained: a failed sync never mutates local data, and the
 * local library is always the source of truth for playback.
 */

export type SyncStatus = "idle" | "syncing" | "synced" | "error";

export type SyncError = { message: string; at: number } | null;

type CloudState = CloudAuthState & {
  syncStatus: SyncStatus;
  syncError: SyncError;
  /** True when Supabase env vars exist; drives UI visibility. */
  available: boolean;
  migration: MigrationProgress;
  authError: string | null;
  busy: boolean;

  init: () => Promise<void>;
  initAuth: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  syncNow: () => Promise<void>;
  startMigration: (concurrency?: number) => Promise<void>;
  /** Uploads a specific selection (used by the per-track menu). */
  uploadSelected: (trackIds: string[]) => Promise<void>;
  retryMigration: () => Promise<void>;
  setMigrationPlan: (progress: MigrationProgress) => void;
  cancelMigration: () => void;
  resetAuthError: () => void;
};

/**
 * Merges a fetched cloud snapshot into the local library (spec §5 point 4/7).
 * Local records are never dropped: cloud tracks are added, shared ids are
 * reconciled field-by-field, and playlists/likes/lyrics are merged.
 */
export function mergeCloudIntoLocal(localTracks: Track[], cloudTracks: Track[]): Track[] {
  // `byId` is the working set; the returned array is rebuilt from it so a
  // merge can never hand back a stale pre-merge object reference.
  const byId = new Map(localTracks.map((track) => [track.id, track]));
  const merged: Track[] = localTracks;
  const byFingerprint = new Map(
    merged.filter((track) => track.fingerprint).map((track) => [track.fingerprint as string, track]),
  );
  for (const cloud of cloudTracks) {
    const byIdMatch = byId.get(cloud.id);
    if (byIdMatch) {
      // Keep the local copy plugged into the same cloud object; metadata the
      // user already has locally (e.g. an edited title) wins unless the local
      // track was never synced.
      byId.set(cloud.id, {
        ...byIdMatch,
        objectKey: cloud.objectKey ?? byIdMatch.objectKey ?? null,
        artworkObjectKey: cloud.artworkObjectKey ?? byIdMatch.artworkObjectKey ?? null,
        storageProvider: cloud.objectKey ? "r2" : byIdMatch.storageProvider ?? null,
        cloudStatus: cloud.objectKey ? "ready" : byIdMatch.cloudStatus ?? "local",
        lastSyncedAt: cloud.lastSyncedAt ?? byIdMatch.lastSyncedAt ?? null,
        playCount: Math.max(byIdMatch.playCount, cloud.playCount),
        lastPlayedAt: (byIdMatch.lastPlayedAt ?? 0) >= (cloud.lastPlayedAt ?? 0) ? byIdMatch.lastPlayedAt : cloud.lastPlayedAt,
        isLiked: byIdMatch.cloudStatus === "ready" ? cloud.isLiked : byIdMatch.isLiked,
      });
      continue;
    }
    const byFingerprintMatch = cloud.fingerprint ? byFingerprint.get(cloud.fingerprint) : undefined;
    if (byFingerprintMatch) {
      // Same audio under different ids on two devices: link the local track to
      // the existing cloud object. Duplicates are reconciled, never created.
      const updated: Track = {
        ...byFingerprintMatch,
        objectKey: cloud.objectKey ?? byFingerprintMatch.objectKey ?? null,
        storageProvider: cloud.objectKey ? "r2" : byFingerprintMatch.storageProvider ?? null,
        cloudStatus: cloud.objectKey ? "ready" : byFingerprintMatch.cloudStatus ?? "local",
        lastSyncedAt: cloud.lastSyncedAt ?? byFingerprintMatch.lastSyncedAt ?? null,
      };
      byId.set(byFingerprintMatch.id, updated);
      continue;
    }
    if (!byId.has(cloud.id)) merged.push(cloud);
    byId.set(cloud.id, cloud);
    if (cloud.fingerprint) byFingerprint.set(cloud.fingerprint, cloud);
  }
  return [...byId.values()];
}

export function mergePlaylists(local: Playlist[], cloud: Playlist[]): Playlist[] {
  const byId = new Map(local.map((playlist) => [playlist.id, playlist]));
  for (const cloudPlaylist of cloud) {
    const existing = byId.get(cloudPlaylist.id);
    if (!existing) {
      byId.set(cloudPlaylist.id, cloudPlaylist);
      continue;
    }
    if ((cloudPlaylist.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
      byId.set(cloudPlaylist.id, { ...cloudPlaylist, trackIds: dedupeIds(cloudPlaylist.trackIds) });
    }
  }
  return [...byId.values()];
}

function dedupeIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

export const useCloudStore = create<CloudState>((set, get) => ({
  ...snapshotAuth(null),
  available: cloudConfigured(),
  syncStatus: "idle",
  syncError: null,
  migration: initialMigrationProgress(),
  authError: null,
  busy: false,

  init: async () => {
    await get().initAuth();
  },

  initAuth: async () => {
    if (!cloudConfigured()) {
      set({ ...snapshotAuth(null), available: false });
      return;
    }
    set({ available: true });
    try {
      const state = await currentAuthState();
      set({ ...state, authError: null });
    } catch {
      set({ ...snapshotAuth(null) });
    }
    // Real-time session changes (sign in/out in another tab, token refresh).
    subscribeToAuthChanges((state) => set({ ...state, authError: null }));
  },

  signIn: async (email, password) => {
    set({ authError: null, busy: true });
    try {
      await signInWithEmail(email, password);
      const state = await currentAuthState();
      set({ ...state, busy: false });
    } catch (error) {
      set({ busy: false, authError: error instanceof CloudAuthError ? error.message : "Sign-in failed." });
      throw error;
    }
  },

  signUp: async (email, password) => {
    set({ authError: null, busy: true });
    try {
      await signUpWithEmail(email, password);
      set({ busy: false });
    } catch (error) {
      set({ busy: false, authError: error instanceof CloudAuthError ? error.message : "Sign-up failed." });
      throw error;
    }
  },

  signOut: async () => {
    set({ busy: true });
    try {
      await signOutCloud();
      resetCloudStorageState();
    } finally {
      set({ ...snapshotAuth(null), busy: false, syncStatus: "idle", syncError: null, migration: initialMigrationProgress() });
    }
  },

  syncNow: async () => {
    if (!cloudConfigured()) return;
    const auth = get();
    if (auth.status !== "authenticated") {
      set({ syncError: { message: "Sign in to sync your library.", at: Date.now() }, syncStatus: "error" });
      return;
    }
    set({ syncStatus: "syncing", syncError: null });
    try {
      const snapshot = await fetchCloudLibrary();
      const cloudEntities = snapshotToLocalEntities(snapshot);

      // Pull: merge cloud rows into the local library without dropping any.
      const localTracks = await repository.listTracks();
      const mergedTracks = mergeCloudIntoLocal(localTracks, cloudEntities.tracks);
      const localPlaylists = await repository.listPlaylists();
      const mergedPlaylists = mergePlaylists(localPlaylists, cloudEntities.playlists);
      await repository.putTracks(mergedTracks);
      for (const playlist of mergedPlaylists) await repository.putPlaylist(playlist);

      // Lyrics: prefer the newer of local and cloud per track.
      for (const cloudLyrics of cloudEntities.lyrics) {
        const localLyrics = await repository.getLyrics(cloudLyrics.trackId);
        if (!localLyrics || cloudLyrics.updatedAt > localLyrics.updatedAt) {
          await repository.putLyrics(cloudLyrics);
        }
      }

      // Push local-only state back up: tracks, playlists, likes, lyric edits.
      const tracksToPush = mergedTracks;
      await upsertCloudTracks(tracksToPush);
      await upsertCloudPlaylists(mergedPlaylists);
      const localLyricsList: TrackLyrics[] = [];
      for (const track of mergedTracks) {
        const lyrics = await repository.getLyrics(track.id);
        if (lyrics) localLyricsList.push(lyrics);
      }
      await upsertCloudLyrics(localLyricsList);

      // Finish any cloud deletion that a previous run had to leave halfway;
      // entries only drop out once their objects AND metadata are both gone.
      try {
        const pending = await retryPendingCloudDeletions();
        if (pending.remaining > 0) {
          toast(
            "info",
            `${pending.remaining} cloud deletion${pending.remaining === 1 ? "" : "s"} still finishing — it will be retried on the next sync.`,
          );
        }
      } catch {
        // Sweeping is best-effort; a failure here must not fail the sync.
      }

      set({ syncStatus: "synced", syncError: null });
      // Persist the merged library into the store the UI reads from, without
      // dropping the in-memory playback state.
      useLibraryStore.setState({ tracks: mergedTracks, playlists: mergedPlaylists });
    } catch (error) {
      // A failed sync must never lose local data. Nothing above deletes.
      set({
        syncStatus: "error",
        syncError: { message: error instanceof Error ? error.message : "Sync failed.", at: Date.now() },
      });
      toast("error", "Cloud sync failed. Your local library is unchanged.");
    }
  },

  startMigration: async (concurrency) => {
    if (get().status !== "authenticated") {
      toast("error", "Sign in to move your library to the cloud.");
      return;
    }
    if (!workerConfigured()) {
      toast("error", "Cloud storage is not configured on this build.");
      return;
    }
    const tracks = useLibraryStore.getState().tracks;
    set({ busy: true });
    try {
      const plan = await planMigration(tracks);
      const progress: MigrationProgress = {
        ...initialMigrationProgress(),
        items: plan.items,
      };
      set({ migration: progress });
      await runMigration(tracks, progress, {
        concurrency,
        onProgress: (updated) => set({ migration: updated }),
      });
      const fresh = await repository.listTracks();
      useLibraryStore.setState({ tracks: fresh });
      const failed = progress.items.filter((item) => item.status === "failed").length;
      const succeeded = progress.items.filter((item) => item.status === "done").length;
      if (failed > 0) toast("error", `${succeeded} uploaded, ${failed} failed. Your local files are untouched.`);
      else toast("success", `${succeeded} tracks verified in cloud storage. Local copies are kept.`);
    } finally {
      set({ busy: false });
    }
  },

  retryMigration: async () => {
    const progress = retryFailedItems(get().migration);
    set({ migration: { ...progress } });
    await get().startMigration();
  },

  setMigrationPlan: (migration) => set({ migration }),

  uploadSelected: async (trackIds) => {
    if (get().status !== "authenticated") {
      toast("error", "Sign in to upload tracks to the cloud.");
      return;
    }
    const tracks = useLibraryStore.getState().tracks;
    const selected = new Set(trackIds);
    const targets = tracks.filter((track) => selected.has(track.id) && track.cloudStatus !== "ready");
    if (targets.length === 0) {
      toast("info", "Already in cloud storage.");
      return;
    }
    set({ busy: true });
    try {
      const plan = await planMigration(targets);
      const progress: MigrationProgress = {
        ...initialMigrationProgress(),
        items: plan.items.filter((item) => selected.has(item.trackId)),
      };
      set({ migration: progress });
      await runMigration(tracks, progress, {
        onProgress: (updated) => set({ migration: updated }),
      });
      const fresh = await repository.listTracks();
      useLibraryStore.setState({ tracks: fresh });
      const failedCount = progress.items.filter((item) => item.status === "failed").length;
      const succeededCount = progress.items.filter((item) => item.status === "done").length;
      if (failedCount > 0) toast("error", `“${targets[0]?.title}” could not be uploaded. Nothing was removed locally.`);
      else toast("success", succeededCount === 1 ? `“${targets[0]?.title}” is stored in the cloud.` : `${succeededCount} tracks stored in the cloud.`);
    } finally {
      set({ busy: false });
    }
  },

  cancelMigration: () => {
    // The migration run observes this between files; the in-flight upload
    // finishes first so a partial object can never be mistaken for complete.
    cancelMigrationRun();
    set((state) => ({ migration: { ...state.migration, state: "cancelling" } }));
  },

  resetAuthError: () => set({ authError: null }),
}));

/**
 * Deletes the cloud copy of a track: R2 objects first, then metadata. Both
 * halves are idempotent, so the order is chosen for failure safety:
 *
 *  - objects first: if metadata removal then fails, a track row remains that
 *    visibly points at a missing object (retryable, surfaced in the UI);
 *  - had it been metadata first, a dead R2 object with no row pointing at it
 *    would be unreachable garbage that nobody can find again.
 *
 * Either way, a failure records the work left in IndexedDB so the next sync
 * finishes it — no deletion is ever abandoned partway.
 */
export async function removeTrackFromCloud(track: Track): Promise<void> {
  const objectKey = track.objectKey ?? null;
  try {
    if (objectKey) {
      // The Worker deletes every object under the track prefix (artwork too),
      // and reports back exactly which keys it removed.
      await deleteCloudObject(objectKey);
    }
    await deleteCloudTrackMetadata(track.id);
  } catch (error) {
    // Record the half-finished deletion so syncNow can finish it later, then
    // surface the failure to the caller. Local data is untouched either way.
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
 * Finishes every half-completed cloud deletion recorded in IndexedDB. Each
 * entry is removed only once its objects AND metadata are both gone, so the
 * catalog can never agree to leave something behind.
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
