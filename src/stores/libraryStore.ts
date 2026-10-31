import { create } from "zustand";
import type { ImportOutcome, Playlist, Track } from "../types";
import { DBError } from "../services/indexeddb/db";
import { repository } from "../services/indexeddb/LibraryRepository";
import {
  regainHandleAccess,
  revalidateAccess,
  relinkTrackWithFile,
} from "../services/file-access/FileAccessService";
import { importAudioItems, type ImportItem, type ImportProgress } from "../services/library/importService";
import {
  clearPlaybackSession,
  loadPlaybackSession,
  savePlaybackSession,
} from "../services/library/playbackSession";
import { createId, debounce } from "../utils/misc";
import { bindPlaybackHelpers, usePlaybackStore } from "./playbackStore";
import { useSettingsStore } from "./settingsStore";
import { toast } from "./toastStore";
import { bindLyricsTrackLookup } from "./lyricsStore";
import { useCloudStore, removeTrackFromCloud } from "./cloudStore";
import { invalidatePlayUrl } from "../services/cloud/r2StorageService";

export type LibraryStatus = "loading" | "ready" | "error";

type LibraryState = {
  tracks: Track[];
  playlists: Playlist[];
  status: LibraryStatus;
  loadError: string | null;
  importProgress: ImportProgress | null;
  lastImportOutcome: ImportOutcome | null;

  init: () => Promise<void>;
  importItems: (items: ImportItem[]) => Promise<ImportOutcome>;
  removeTracks: (ids: string[]) => Promise<void>;
  toggleLike: (trackId: string) => Promise<void>;
  setLiked: (trackId: string, liked: boolean) => Promise<void>;

  createPlaylist: (name: string) => Promise<Playlist>;
  renamePlaylist: (playlistId: string, name: string) => Promise<void>;
  deletePlaylist: (playlistId: string) => Promise<void>;
  addToPlaylist: (playlistId: string, trackIds: string[]) => Promise<void>;
  removeFromPlaylist: (playlistId: string, trackId: string) => Promise<void>;
  reorderPlaylist: (playlistId: string, from: number, to: number) => Promise<void>;

  grantFileAccess: (trackId: string) => Promise<boolean>;
  relinkTrack: (trackId: string, file: File | FileSystemFileHandle) => Promise<void>;
  markTrackPlayed: (trackId: string) => Promise<void>;
  clearLibrary: () => Promise<void>;
  /** Applies a cloud-side patch (object key, status, sync stamp) to one track. */
  applyCloudUpdate: (trackId: string, patch: Partial<Track>) => Promise<void>;
  /** Removes the local audio copy for a track whose cloud copy is confirmed. */
  removeLocalAudioCopy: (trackId: string) => Promise<void>;
  /** Downloads and stores a local copy of a cloud track (explicit action). */
  keepLocalCopyFromCloud: (trackId: string) => Promise<void>;
};

function sessionPayload(): ReturnType<typeof savePlaybackSession> | null {
  const playback = usePlaybackStore.getState();
  if (!playback.currentTrackId) return null;
  // The store clock may lag real playback in throttled tabs; correct it from
  // the audio element before anything is saved or shown.
  playback.syncFromEngine();
  const fresh = usePlaybackStore.getState();
  return savePlaybackSession({
    queueTrackIds: fresh.queueTrackIds,
    queueIndex: fresh.queueIndex,
    contextTrackIds: fresh.contextTrackIds,
    context: fresh.context,
    currentTrackId: fresh.currentTrackId,
    positionMs: Math.round(fresh.currentTimeMs),
    savedAt: Date.now(),
  });
}

const persistSession = debounce(() => {
  const payload = sessionPayload();
  if (!payload) void clearPlaybackSession();
}, 1200);

/** Called on pause/track change; flushes immediately rather than debounced. */
function persistSessionNow(): void {
  persistSession.cancel();
  const payload = sessionPayload();
  if (!payload) void clearPlaybackSession();
}

export function schedulePlaybackSessionPersist(): void {
  persistSession();
}

export function flushPlaybackSessionNow(): void {
  persistSessionNow();
}

/**
 * Pushes library changes to the cloud after local writes have already
 * succeeded. Cloud failures never roll the local change back; they surface
 * as a toast and the next sync reconciles. Idempotent by construction.
 */
const scheduleCloudPush = debounce(() => {
  const cloud = useCloudStore.getState();
  if (cloud.status !== "authenticated") return;
  void cloud.syncNow().catch(() => undefined);
}, 1500);

export const useLibraryStore = create<LibraryState>((set, get) => ({
  tracks: [],
  playlists: [],
  status: "loading",
  loadError: null,
  importProgress: null,
  lastImportOutcome: null,

  init: async () => {
    bindLyricsTrackLookup((id) => get().tracks.find((track) => track.id === id));
    bindPlaybackHelpers({
      getTrackForPlayback: async (id) => get().tracks.find((track) => track.id === id),
      currentTrack: () => {
        const playback = usePlaybackStore.getState();
        return get().tracks.find((track) => track.id === playback.currentTrackId);
      },
      notifyTrackStarted: async (trackId) => {
        schedulePlaybackSessionPersist();
        await get().markTrackPlayed(trackId);
      },
      markTrackAvailability: async (trackId, availability) => {
        const tracks = get().tracks;
        const current = tracks.find((track) => track.id === trackId);
        if (!current) return;
        if (current.availability === availability) return; // nothing to mark or heal
        await repository.updateTrack(trackId, { availability });
        set({ tracks: tracks.map((track) => (track.id === trackId ? { ...track, availability } : track)) });
      },
      persistPrefs: () => {
        const playback = usePlaybackStore.getState();
        const settings = useSettingsStore.getState();
        settings.update({ volume: playback.volume, shuffle: playback.shuffleEnabled, repeatMode: playback.repeatMode });
      },
      persistPosition: () => {
        schedulePlaybackSessionPersist();
      },
    });

    try {
      const [tracks, playlists] = await Promise.all([repository.listTracks(), repository.listPlaylists()]);

      // Re-check file availability after a reload.
      const availabilityUpdates = await revalidateAccess(tracks);
      const effectiveTracks =
        availabilityUpdates.size > 0
          ? tracks.map((track) => (availabilityUpdates.has(track.id) ? { ...track, availability: availabilityUpdates.get(track.id)! } : track))
          : tracks;
      const changed = [...availabilityUpdates.entries()].map(([id, availability]) => ({ id, availability }));
      if (changed.length > 0) {
        await Promise.all(changed.map(({ id, availability }) => repository.updateTrack(id, { availability })));
      }

      set({ tracks: effectiveTracks, playlists, status: "ready" });

      // Restore last session (paused; playback needs a user gesture).
      const session = await loadPlaybackSession();
      if (session?.currentTrackId && effectiveTracks.some((track) => track.id === session.currentTrackId)) {
        usePlaybackStore.getState().restoreQueue({
          queueTrackIds: session.queueTrackIds.filter((id) => effectiveTracks.some((track) => track.id === id)),
          queueIndex: session.queueIndex,
          contextTrackIds: session.contextTrackIds.filter((id) => effectiveTracks.some((track) => track.id === id)),
          context: session.context,
          currentTrackId: session.currentTrackId,
          positionMs: session.positionMs,
        });
      }
    } catch (error) {
      const message =
        error instanceof DBError
          ? error.message
          : "Your library could not be loaded from this device's storage.";
      set({ status: "error", loadError: message });
    }
  },

  importItems: async (items) => {
    const { tracks } = get();
    const { prefs } = useSettingsStore.getState();
    set({ importProgress: { done: 0, total: items.length, currentName: "" } });
    try {
      const outcome = await importAudioItems(items, {
        existingTracks: tracks,
        storeCopies: prefs.storeAudioCopies,
        onProgress: (progress) => set({ importProgress: progress }),
      });
      if (outcome.added > 0) {
        const fresh = await repository.listTracks();
        set({ tracks: fresh });
      }
      set({ lastImportOutcome: outcome });
      return outcome;
    } finally {
      set({ importProgress: null });
    }
  },

  removeTracks: async (ids) => {
    const idSet = new Set(ids);
    const tracks = get().tracks.filter((track) => idSet.has(track.id));

    // Cloud cleanup happens after the local removal is committed. A failure
    // here is reported but never blocks the user's local action, and local
    // data is already safe.
    const cloudBacked = tracks.filter((track) => track.objectKey);
    if (cloudBacked.length > 0 && useCloudStore.getState().status === "authenticated") {
      void Promise.allSettled(cloudBacked.map((track) => removeTrackFromCloud(track))).then((results) => {
        const failed = results.filter((result) => result.status === "rejected").length;
        if (failed > 0) {
          toast(
            "error",
            `${failed} cloud cop${failed === 1 ? "y" : "ies"} could not be removed yet — it will be finished automatically on the next sync.`,
          );
        }
        for (const track of cloudBacked) invalidatePlayUrl(track.objectKey as string);
      });
    }

    await repository.deleteTracks(ids);
    set({
      tracks: get().tracks.filter((track) => !idSet.has(track.id)),
      playlists: get().playlists.map((playlist) => ({
        ...playlist,
        trackIds: playlist.trackIds.filter((id) => !idSet.has(id)),
      })),
    });
    // Playlists that referenced removed tracks lose those references — persist that.
    await Promise.all(get().playlists.map((playlist) => repository.putPlaylist(playlist)));
    const playback = usePlaybackStore.getState();
    if (playback.currentTrackId && idSet.has(playback.currentTrackId)) {
      usePlaybackStore.setState({ currentTrackId: null, isPlaying: false, status: "idle", queueTrackIds: [], queueIndex: -1 });
      playback.getEngine().pause();
    }
    scheduleCloudPush();
  },

  toggleLike: async (trackId) => {
    const track = get().tracks.find((item) => item.id === trackId);
    if (!track) return;
    await get().setLiked(trackId, !track.isLiked);
  },

  setLiked: async (trackId, liked) => {
    set({ tracks: get().tracks.map((track) => (track.id === trackId ? { ...track, isLiked: liked } : track)) });
    try {
      await repository.updateTrack(trackId, { isLiked: liked });
    } catch (error) {
    scheduleCloudPush();
      set({ tracks: get().tracks.map((track) => (track.id === trackId ? { ...track, isLiked: !liked } : track)) });
      toast("error", error instanceof DBError ? error.message : "Could not save the liked state.");
    }
  },

  createPlaylist: async (name) => {
    const now = Date.now();
    const playlist: Playlist = { id: createId(), name: name.trim(), description: "", trackIds: [], createdAt: now, updatedAt: now };
    await repository.putPlaylist(playlist);
    set({ playlists: [...get().playlists, playlist] });
    return playlist;
    scheduleCloudPush();
  },

  renamePlaylist: async (playlistId, name) => {
    const playlist = get().playlists.find((item) => item.id === playlistId);
    if (!playlist) return;
    const updated = { ...playlist, name: name.trim(), updatedAt: Date.now() };
    await repository.putPlaylist(updated);
    set({ playlists: get().playlists.map((item) => (item.id === playlistId ? updated : item)) });
    scheduleCloudPush();
  },

  deletePlaylist: async (playlistId) => {
    // Deleting a playlist never deletes tracks (rules §6).
    await repository.deletePlaylist(playlistId);
    set({ playlists: get().playlists.filter((item) => item.id !== playlistId) });
    scheduleCloudPush();
  },

  addToPlaylist: async (playlistId, trackIds) => {
    const playlist = get().playlists.find((item) => item.id === playlistId);
    if (!playlist) return;
    const additions = trackIds.filter((id) => !playlist.trackIds.includes(id));
    if (additions.length === 0) return;
    const updated = { ...playlist, trackIds: [...playlist.trackIds, ...additions], updatedAt: Date.now() };
    await repository.putPlaylist(updated);
    set({ playlists: get().playlists.map((item) => (item.id === playlistId ? updated : item)) });
    scheduleCloudPush();
  },

  removeFromPlaylist: async (playlistId, trackId) => {
    const playlist = get().playlists.find((item) => item.id === playlistId);
    if (!playlist) return;
    const updated = {
      ...playlist,
      trackIds: playlist.trackIds.filter((id) => id !== trackId),
      updatedAt: Date.now(),
    };
    await repository.putPlaylist(updated);
    set({ playlists: get().playlists.map((item) => (item.id === playlistId ? updated : item)) });
    scheduleCloudPush();
  },

  reorderPlaylist: async (playlistId, from, to) => {
    const playlist = get().playlists.find((item) => item.id === playlistId);
    if (!playlist) return;
    const trackIds = [...playlist.trackIds];
    if (from < 0 || from >= trackIds.length || to < 0 || to >= trackIds.length) return;
    const [moved] = trackIds.splice(from, 1);
    trackIds.splice(to, 0, moved);
    const updated = { ...playlist, trackIds, updatedAt: Date.now() };
    await repository.putPlaylist(updated);
    set({ playlists: get().playlists.map((item) => (item.id === playlistId ? updated : item)) });
    scheduleCloudPush();
  },

  grantFileAccess: async (trackId) => {
    const track = get().tracks.find((item) => item.id === trackId);
    if (!track) return false;
    const result = await regainHandleAccess(track);
    if (result === "granted") {
      await repository.updateTrack(trackId, { availability: "available" });
      set({ tracks: get().tracks.map((item) => (item.id === trackId ? { ...item, availability: "available" } : item)) });
      return true;
    }
    return false;
  },

  relinkTrack: async (trackId, file) => {
    const track = get().tracks.find((item) => item.id === trackId);
    if (!track) return;
    const { updated, warning } = await relinkTrackWithFile(track, file);
    set({ tracks: get().tracks.map((item) => (item.id === trackId ? updated : item)) });
    if (warning) toast("info", warning);
    else toast("success", `Linked "${updated.title}" to the selected file.`);
  },

  markTrackPlayed: async (trackId) => {
    const track = get().tracks.find((item) => item.id === trackId);
    if (!track) return;
    const now = Date.now();
    set({
      tracks: get().tracks.map((item) =>
        item.id === trackId ? { ...item, lastPlayedAt: now, playCount: item.playCount + 1 } : item,
      ),
    });
    try {
      await repository.updateTrack(trackId, { lastPlayedAt: now, playCount: track.playCount + 1 });
    } catch {
      // Non-fatal: play history is a convenience, not critical data.
    }
  },

  clearLibrary: async () => {
    await repository.clearLibrary();
    await clearPlaybackSession();
    set({ tracks: [], playlists: [], lastImportOutcome: null });
    const playback = usePlaybackStore.getState();
    playback.getEngine().pause();
    usePlaybackStore.setState({
      currentTrackId: null,
      isPlaying: false,
      status: "idle",
      queueTrackIds: [],
      queueIndex: -1,
      contextTrackIds: [],
      context: null,
      currentTimeMs: 0,
      durationMs: null,
    });
  },

  applyCloudUpdate: async (trackId, patch) => {
    await repository.updateTrack(trackId, patch);
    set({ tracks: get().tracks.map((track) => (track.id === trackId ? { ...track, ...patch, id: trackId } : track)) });
  },

  removeLocalAudioCopy: async (trackId) => {
    const track = get().tracks.find((item) => item.id === trackId);
    if (!track) return;
    // The cloud copy and its metadata must both be confirmed before a local
    // copy may be discarded — never the other way around.
    if (!track.objectKey || track.cloudStatus !== "ready") {
      toast("error", "The cloud copy is not confirmed yet. Upload the track before removing the local copy.");
      return;
    }
    await repository.deleteAudioBlob(trackId);
    const playback = usePlaybackStore.getState();
    const isCurrent = playback.currentTrackId === trackId;
    if (isCurrent) playback.getEngine().pause();
    const patch: Partial<Track> = {
      accessMode: "cloud",
      availability: isCurrent && track.objectKey ? "available" : track.availability,
    };
    await repository.updateTrack(trackId, patch);
    set({ tracks: get().tracks.map((item) => (item.id === trackId ? { ...item, ...patch } : item)) });
    toast("success", `Local copy removed. “${track.title}” now plays from the cloud.`);
  },

  keepLocalCopyFromCloud: async (trackId) => {
    const track = get().tracks.find((item) => item.id === trackId);
    if (!track || !track.objectKey) return;
    const { getPlayUrl } = await import("../services/cloud/r2StorageService");
    try {
      const url = await getPlayUrl(track.objectKey, { forceFresh: true });
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Download failed (${response.status}).`);
      const blob = await response.blob();
      await repository.putAudioBlob(trackId, blob);
      const patch: Partial<Track> = { accessMode: "stored-copy", availability: "available" };
      await repository.updateTrack(trackId, patch);
      set({ tracks: get().tracks.map((item) => (item.id === trackId ? { ...item, ...patch } : item)) });
      toast("success", `Stored a local copy of “${track.title}”. It will play offline.`);
    } catch (error) {
      toast("error", error instanceof Error ? error.message : "The local copy could not be downloaded.");
    }
  },
}));
