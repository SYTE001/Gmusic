import { useRef, useState } from "react";
import { usePlaybackStore } from "../../stores/playbackStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { toast } from "../../stores/toastStore";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { AddToPlaylistDialog } from "../playlists/AddToPlaylistDialog";
import type { MenuItemSpec } from "../../components/Menu";
import { CloudIcon, CloudCheckIcon, HeartIcon, LinkIcon, PlayIcon, PlusIcon, QueueIcon, TrashIcon } from "../../components/Icons";
import type { Track } from "../../types";
import { useCloudStore } from "../../stores/cloudStore";
import { CloudStorageError } from "../../services/cloud/r2StorageService";

/**
 * Shared track action menu: play next, queue, like, playlist, relink, and
 * remove-from-library (with explicit confirmation — never deletes the file).
 */
export function useTrackActions() {
  const [pendingRemoval, setPendingRemoval] = useState<Track | null>(null);
  const [addToPlaylistFor, setAddToPlaylistFor] = useState<string[] | null>(null);
  const [relinkFor, setRelinkFor] = useState<Track | null>(null);
  const relinkInputRef = useRef<HTMLInputElement>(null);

  const removeTracks = useLibraryStore((state) => state.removeTracks);
  const removeLocalAudioCopy = useLibraryStore((state) => state.removeLocalAudioCopy);
  const keepLocalCopyFromCloud = useLibraryStore((state) => state.keepLocalCopyFromCloud);

  const uploadTrackToCloud = async (track: Track) => {
    const cloud = useCloudStore.getState();
    if (cloud.status !== "authenticated") {
      toast("error", "Sign in to Cloud in Settings first.");
      return;
    }
    await cloud.uploadSelected([track.id]);
  };
  const relinkTrack = useLibraryStore((state) => state.relinkTrack);
  const grantFileAccess = useLibraryStore((state) => state.grantFileAccess);
  const playback = usePlaybackStore.getState;

  const buildMenuItems = (track: Track, options?: { playlistId?: string }): MenuItemSpec[] => {
    const items: MenuItemSpec[] = [];
    if (track.availability !== "available") {
      if (track.accessMode === "handle") {
        items.push({
          kind: "action",
          label: "Grant file access",
          icon: <LinkIcon size={16} />,
          onSelect: () => {
            void grantFileAccess(track.id).then((granted) => {
              if (granted) toast("success", "File access restored.");
              else toast("error", "Access was not granted. Use “Locate file” to re-link it.");
            });
          },
        });
      }
      items.push({
        kind: "action",
        label: "Locate file…",
        icon: <LinkIcon size={16} />,
        onSelect: () => {
          setRelinkFor(track);
          setTimeout(() => relinkInputRef.current?.click(), 0);
        },
      });
      items.push({ kind: "separator" });
    }
    items.push(
      {
        kind: "action",
        label: "Play next",
        icon: <PlayIcon size={16} />,
        onSelect: () => {
          playback().playNext(track.id);
          toast("success", "Playing next.");
        },
      },
      {
        kind: "action",
        label: "Add to queue",
        icon: <QueueIcon size={16} />,
        onSelect: () => {
          playback().enqueue(track.id);
          toast("success", "Added to queue.");
        },
      },
      { kind: "separator" },
      {
        kind: "action",
        label: track.isLiked ? "Remove from Liked Songs" : "Add to Liked Songs",
        icon: <HeartIcon size={16} filled={track.isLiked} />,
        onSelect: () => {
          void useLibraryStore.getState().toggleLike(track.id);
        },
      },
      {
        kind: "action",
        label: "Add to playlist…",
        icon: <PlusIcon size={16} />,
        onSelect: () => setAddToPlaylistFor([track.id]),
      },
    );
    if (options?.playlistId) {
      const playlistId = options.playlistId;
      items.push(
        { kind: "separator" },
        {
          kind: "action",
          label: "Remove from this playlist",
          icon: <TrashIcon size={16} />,
          onSelect: () => {
            void useLibraryStore.getState().removeFromPlaylist(playlistId, track.id);
          },
        },
      );
    }
    const cloud = useCloudStore.getState();
    if (cloud.status === "authenticated" || track.objectKey) {
      if (track.cloudStatus === "ready" && track.objectKey) {
        items.push({ kind: "separator" }, {
          kind: "action",
          label: track.accessMode === "cloud" ? "Keep a local copy" : "Remove local copy",
          icon: <CloudCheckIcon size={16} />,
          onSelect: () => {
            void (track.accessMode === "cloud"
              ? keepLocalCopyFromCloud(track.id)
              : removeLocalAudioCopy(track.id));
          },
        });
      } else {
        items.push({ kind: "separator" }, {
          kind: "action",
          label: track.cloudStatus === "uploading" ? "Uploading…" : "Upload to cloud",
          icon: <CloudIcon size={16} />,
          onSelect: () => {
            void uploadTrackToCloud(track).catch((error: unknown) => {
              if (error instanceof CloudStorageError) toast("error", error.message);
            });
          },
        });
      }
    }
    items.push(
      { kind: "separator" },
      {
        kind: "action",
        label: "Remove from library",
        icon: <TrashIcon size={16} />,
        danger: true,
        onSelect: () => setPendingRemoval(track),
      },
    );
    return items;
  };

  const dialogs = (
    <>
      {pendingRemoval !== null && (
        <ConfirmDialog
          open
          title="Remove from library?"
          description={
            <>
              “{pendingRemoval.title}” will be removed from your library, playlists, and liked songs on this device.{" "}
              <strong>The original audio file on your computer is never deleted.</strong>
            </>
          }
          confirmLabel="Remove"
          onConfirm={() => {
            void removeTracks([pendingRemoval.id]);
            setPendingRemoval(null);
          }}
          onCancel={() => setPendingRemoval(null)}
        />
      )}
      {addToPlaylistFor !== null && (
        <AddToPlaylistDialog
          open
          trackIds={addToPlaylistFor}
          onClose={() => setAddToPlaylistFor(null)}
        />
      )}
      {relinkFor !== null && (
        <input
          ref={relinkInputRef}
          type="file"
          accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.flac,.opus"
          className="hidden"
          aria-hidden
          tabIndex={-1}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file && relinkFor) {
              void relinkTrack(relinkFor.id, file);
              setRelinkFor(null);
            }
          }}
        />
      )}
    </>
  );

  return { buildMenuItems, dialogs };
}
