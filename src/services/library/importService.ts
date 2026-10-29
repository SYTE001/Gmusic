import type { ImportOutcome, Track } from "../../types";
import { createId, deriveArtistTitleFromFileName, looksLikeAudioFile } from "../../utils/misc";
import { parseAudioTags, probeAudioFile } from "../metadata";
import { repository } from "../indexeddb/LibraryRepository";
import { rememberSessionFile } from "../file-access/FileAccessService";

export type ImportItem = File | FileSystemFileHandle;

export type ImportProgress = {
  done: number;
  total: number;
  currentName: string;
};

export type ImportOptions = {
  existingTracks: Track[];
  /** Copy audio bytes into IndexedDB (used when handles are unavailable). */
  storeCopies: boolean;
  onProgress?: (progress: ImportProgress) => void;
};

async function itemToFile(item: ImportItem): Promise<File> {
  if ("getFile" in item) return item.getFile();
  return item;
}

async function itemIsHandle(item: ImportItem): Promise<boolean> {
  return "getFile" in item;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Stable fingerprint from size + SHA-256 of the first and last 32 KB.
 * Deliberately not a full-file hash (rules §12) — small bounded reads only.
 */
export async function computeFingerprint(file: File, durationMs: number | null): Promise<string> {
  const sizeKey = `${file.size}:${durationMs ?? 0}`;
  if (typeof crypto === "undefined" || !("subtle" in crypto)) {
    return `weak:${sizeKey}`;
  }
  try {
    const head = await file.slice(0, 32 * 1024).arrayBuffer();
    const tail = await file.slice(Math.max(0, file.size - 32 * 1024)).arrayBuffer();
    const headHash = toHex(await crypto.subtle.digest("SHA-256", head)).slice(0, 16);
    const tailHash = toHex(await crypto.subtle.digest("SHA-256", tail)).slice(0, 16);
    return `${headHash}${tailHash}:${sizeKey}`;
  } catch {
    return `weak:${sizeKey}`;
  }
}

const AUDIO_PICKER_TYPES = [
  {
    description: "Audio files",
    accept: {
      "audio/*": [".mp3", ".m4a", ".m4b", ".aac", ".wav", ".ogg", ".oga", ".opus", ".flac", ".weba", ".webm", ".mp4"],
    },
  },
];

export function audioAcceptAttribute(): string {
  return "audio/*,.mp3,.m4a,.m4b,.aac,.wav,.ogg,.oga,.opus,.flac,.weba,.webm,.mp4";
}

/** File System Access picker for multiple audio files. Throws when unsupported/denied. */
export async function pickAudioFilesWithPicker(): Promise<FileSystemFileHandle[]> {
  const picker = window.showOpenFilePicker;
  if (!picker) throw new Error("unsupported");
  return picker.call(window, {
    multiple: true,
    types: AUDIO_PICKER_TYPES,
  });
}

/** Folder import via showDirectoryPicker. Throws when unsupported/denied. */
export async function pickAudioFolderWithPicker(): Promise<FileSystemFileHandle[]> {
  const picker = window.showDirectoryPicker;
  if (!picker) throw new Error("unsupported");
  const dir = await picker.call(window, { mode: "read" });
  const handles: FileSystemFileHandle[] = [];
  for await (const [, handle] of dir.entries()) {
    if (handle.kind === "file" && looksLikeAudioFile(handle.name, "")) {
      handles.push(handle as FileSystemFileHandle);
    }
  }
  return handles;
}

/**
 * Imports files one at a time: probe decodability, read tags, compute the
 * fingerprint, skip duplicates, and persist everything the app needs.
 */
export async function importAudioItems(items: ImportItem[], options: ImportOptions): Promise<ImportOutcome> {
  const outcome: ImportOutcome = { added: 0, duplicatesSkipped: 0, unsupported: [], failed: [], sessionOnlyAdded: 0 };
  const knownFingerprints = new Set(options.existingTracks.map((track) => track.fingerprint).filter(Boolean) as string[]);
  const knownSizeNames = new Set(options.existingTracks.map((track) => `${track.fileSize}:${track.fileName}`));
  const newTracks: Track[] = [];

  let done = 0;
  for (const item of items) {
    let file: File;
    const displayName = "name" in item ? item.name : "file";
    options.onProgress?.({ done, total: items.length, currentName: displayName });
    try {
      file = await itemToFile(item);
    } catch {
      outcome.failed.push({ fileName: displayName, reason: "The file could not be opened." });
      done += 1;
      continue;
    }

    if (!looksLikeAudioFile(file.name, file.type)) {
      outcome.unsupported.push(file.name);
      done += 1;
      continue;
    }

    try {
      const probe = await probeAudioFile(file);
      if (!probe.supported) {
        outcome.unsupported.push(file.name);
        done += 1;
        continue;
      }

      const fingerprint = await computeFingerprint(file, probe.durationMs);
      const quickKey = `${file.size}:${file.name}`;
      if ((fingerprint && knownFingerprints.has(fingerprint)) || knownSizeNames.has(quickKey)) {
        outcome.duplicatesSkipped += 1;
        done += 1;
        continue;
      }

      const tags = await parseAudioTags(file);
      const fallback = deriveArtistTitleFromFileName(file.name);
      const isHandle = await itemIsHandle(item);
      const accessMode: Track["accessMode"] = isHandle ? "handle" : options.storeCopies ? "stored-copy" : "session-only";

      const track: Track = {
        id: createId(),
        title: tags.title ?? fallback.title,
        artist: tags.artist ?? fallback.artist,
        album: tags.album ?? "",
        trackNumber: tags.trackNumber ?? fallback.trackNumber ?? null,
        albumTrackCount: tags.albumTrackCount ?? null,
        durationMs: probe.durationMs,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type || "",
        addedAt: Date.now(),
        lastPlayedAt: null,
        playCount: 0,
        isLiked: false,
        availability: "available",
        accessMode,
        fingerprint,
        metadataFromFilename: tags.title === undefined,
      };

      if (tags.artwork) {
        await repository.putArtwork(track.id, tags.artwork);
      }
      if (isHandle) {
        await repository.putHandle(track.id, item as FileSystemFileHandle);
      } else if (options.storeCopies) {
        await repository.putAudioBlob(track.id, file);
      } else {
        rememberSessionFile(track.id, file);
      }

      await repository.putTracks([track]);
      newTracks.push(track);
      if (accessMode === "session-only") outcome.sessionOnlyAdded += 1;
      if (fingerprint) knownFingerprints.add(fingerprint);
      knownSizeNames.add(quickKey);
      outcome.added += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown error";
      outcome.failed.push({ fileName: file.name, reason });
    }
    done += 1;
  }
  options.onProgress?.({ done: items.length, total: items.length, currentName: "" });
  return outcome;
}
