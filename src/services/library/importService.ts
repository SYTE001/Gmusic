import type { ImportOutcome, Track } from "../../types";
import { createId, deriveArtistTitleFromFileName, looksLikeAudioFile, normalizeForSearch } from "../../utils/misc";
import { parseAudioTags, probeAudioFile } from "../metadata";
import type { ParsedTags } from "../metadata/types";
import { normalizeTrackMetadata } from "../metadata/normalization";
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

export function extractTailHash(fingerprint: string | null | undefined): string | null {
  if (!fingerprint || fingerprint.startsWith("weak:")) return null;
  const colonIndex = fingerprint.indexOf(":");
  if (colonIndex >= 32) {
    return fingerprint.slice(16, 32);
  }
  return null;
}

export function extractHeadHash(fingerprint: string | null | undefined): string | null {
  if (!fingerprint || fingerprint.startsWith("weak:")) return null;
  const colonIndex = fingerprint.indexOf(":");
  if (colonIndex >= 32) {
    return fingerprint.slice(0, 16);
  }
  return null;
}

const VERSION_KEYWORD_REGEX =
  /\b(live|acoustic|remix|mix|radio\s+edit|instrumental|acapella|orchestral|unplugged|demo|cover|extended|deluxe|version|take|remaster|edit)\b/gi;

export function extractVersionKeywords(text: string): Set<string> {
  const words = new Set<string>();
  if (!text) return words;
  const matches = text.matchAll(VERSION_KEYWORD_REGEX);
  for (const match of matches) {
    words.add(match[0].toLowerCase().replace(/\s+/g, " "));
  }
  return words;
}

export function haveConflictingVersions(
  titleA: string,
  fileNameA: string,
  titleB: string,
  fileNameB: string,
): boolean {
  const versionsA = new Set([...extractVersionKeywords(titleA), ...extractVersionKeywords(fileNameA)]);
  const versionsB = new Set([...extractVersionKeywords(titleB), ...extractVersionKeywords(fileNameB)]);

  if (versionsA.size !== versionsB.size) return true;
  for (const v of versionsA) {
    if (!versionsB.has(v)) return true;
  }
  return false;
}

export function isGenericTitleOrArtist(title: string, artist: string): boolean {
  const normTitle = normalizeForSearch(title);
  const normArtist = normalizeForSearch(artist);
  if (!normTitle || !normArtist) return true;
  if (/^(track\s*\d+|audio\s*\d+|untitled|song\s*\d+)$/i.test(normTitle)) return true;
  if (/^(unknown(\s*artist)?|various(\s*artists)?)$/i.test(normArtist)) return true;
  return false;
}

export type CandidateMatch = {
  match: Track;
  matchLevel: 1 | 2 | 3;
};

export function findMatchingExistingTrack(params: {
  file: File;
  fingerprint: string | null;
  tailHash: string | null;
  durationMs: number | null;
  normalizedTitle: string;
  normalizedArtist: string;
  rawTitle: string;
  rawArtist: string;
  tracks: Track[];
}): CandidateMatch | null {
  const { file, fingerprint, tailHash, durationMs, normalizedTitle, normalizedArtist, rawTitle, tracks } = params;

  // Level 1: Exact fingerprint match
  if (fingerprint) {
    const exact = tracks.find((t) => t.fingerprint && t.fingerprint === fingerprint);
    if (exact) {
      return { match: exact, matchLevel: 1 };
    }
  }

  // Level 2: Strong audio identity match
  // 2a. Tail hash match + duration within 1500ms
  if (tailHash && durationMs !== null) {
    const tailMatch = tracks.find((t) => {
      const existingTail = extractTailHash(t.fingerprint);
      if (!existingTail || existingTail !== tailHash) return false;
      if (t.durationMs === null) return false;
      return Math.abs(t.durationMs - durationMs) <= 1500;
    });
    if (tailMatch) {
      return { match: tailMatch, matchLevel: 2 };
    }
  }

  // 2b. Same file size, file name, and duration within 1500ms
  const sizeNameMatch = tracks.find((t) => {
    if (t.fileSize !== file.size || t.fileName !== file.name) return false;
    if (durationMs !== null && t.durationMs !== null) {
      return Math.abs(t.durationMs - durationMs) <= 1500;
    }
    return true;
  });
  if (sizeNameMatch) {
    return { match: sizeNameMatch, matchLevel: 2 };
  }

  // Level 3: Metadata-assisted candidate matching
  // Only valid if title and artist are non-generic
  if (
    normalizedTitle &&
    normalizedArtist &&
    !isGenericTitleOrArtist(normalizedTitle, normalizedArtist) &&
    durationMs !== null
  ) {
    const metadataCandidate = tracks.find((t) => {
      if (!t.title || !t.artist) return false;
      const tNormTitle = normalizeForSearch(t.title);
      const tNormArtist = normalizeForSearch(t.artist);
      if (tNormTitle !== normalizedTitle || tNormArtist !== normalizedArtist) return false;

      // Duration must match within 1.5s (1500ms)
      if (t.durationMs === null || Math.abs(t.durationMs - durationMs) > 1500) {
        return false;
      }

      // Version keywords must not conflict
      if (haveConflictingVersions(t.title, t.fileName, rawTitle, file.name)) {
        return false;
      }

      // Strong candidate match where ID3 tags changed both head and tail, but size is close (~64KB)
      if (Math.abs(t.fileSize - file.size) <= 65536) {
        return true;
      }

      return false;
    });

    if (metadataCandidate) {
      return { match: metadataCandidate, matchLevel: 3 };
    }
  }

  return null;
}

export type MetadataComparison = {
  hasImprovement: boolean;
  improvedTitle?: string;
  improvedArtist?: string;
  improvedAlbum?: string;
  improvedTrackNumber?: number | null;
  improvedAlbumTrackCount?: number | null;
  improvedArtwork?: Blob;
  improvedDurationMs?: number | null;
  hasNewTags: boolean;
};

export function evaluateMetadataImprovement(
  existing: Track,
  tags: ParsedTags,
  _fallback: { title: string; artist: string; trackNumber?: number | null },
  probeDurationMs: number | null,
): MetadataComparison {
  const hasNewTags = Boolean(
    (tags.title && tags.title.trim().length > 0) ||
    (tags.artist && tags.artist.trim().length > 0) ||
    (tags.album && tags.album.trim().length > 0) ||
    (tags.trackNumber !== undefined && tags.trackNumber !== null)
  );

  let improvedTitle: string | undefined;
  let improvedArtist: string | undefined;
  let improvedAlbum: string | undefined;
  let improvedTrackNumber: number | null | undefined;
  let improvedAlbumTrackCount: number | null | undefined;
  let improvedArtwork: Blob | undefined;
  let improvedDurationMs: number | null | undefined;

  // Title:
  // If imported tags provide a non-empty title that differs from existing, or existing had filename title
  if (tags.title && tags.title.trim().length > 0) {
    const trimmedTitle = tags.title.trim();
    if (existing.metadataFromFilename || existing.title !== trimmedTitle) {
      improvedTitle = trimmedTitle;
    }
  }

  // Artist:
  if (tags.artist && tags.artist.trim().length > 0) {
    const trimmedArtist = tags.artist.trim();
    if (
      existing.metadataFromFilename ||
      existing.artist === "Unknown Artist" ||
      !existing.artist ||
      existing.artist !== trimmedArtist
    ) {
      improvedArtist = trimmedArtist;
    }
  }

  // Album:
  // Never overwrite an existing non-empty album with empty
  if (tags.album && tags.album.trim().length > 0) {
    const trimmedAlbum = tags.album.trim();
    if (!existing.album || existing.album !== trimmedAlbum) {
      improvedAlbum = trimmedAlbum;
    }
  }

  // Track Number:
  // Never overwrite existing valid track number with null/undefined
  if (tags.trackNumber !== undefined && tags.trackNumber !== null) {
    if (existing.trackNumber === null || existing.trackNumber !== tags.trackNumber) {
      improvedTrackNumber = tags.trackNumber;
    }
  }

  // Album Track Count:
  if (tags.albumTrackCount !== undefined && tags.albumTrackCount !== null) {
    if (existing.albumTrackCount === null || existing.albumTrackCount !== tags.albumTrackCount) {
      improvedAlbumTrackCount = tags.albumTrackCount;
    }
  }

  // Artwork:
  if (tags.artwork && tags.artwork instanceof Blob && tags.artwork.size > 0) {
    improvedArtwork = tags.artwork;
  }

  // Duration:
  if (existing.durationMs === null && probeDurationMs !== null && probeDurationMs > 0) {
    improvedDurationMs = probeDurationMs;
  }

  const hasImprovement = Boolean(
    improvedTitle !== undefined ||
    improvedArtist !== undefined ||
    improvedAlbum !== undefined ||
    improvedTrackNumber !== undefined ||
    improvedAlbumTrackCount !== undefined ||
    improvedArtwork !== undefined ||
    improvedDurationMs !== undefined ||
    (existing.metadataFromFilename && hasNewTags)
  );

  return {
    hasImprovement,
    improvedTitle,
    improvedArtist,
    improvedAlbum,
    improvedTrackNumber,
    improvedAlbumTrackCount,
    improvedArtwork,
    improvedDurationMs,
    hasNewTags,
  };
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
 * fingerprint, reconcile duplicates intelligently in-place, and persist everything the app needs.
 */
export async function importAudioItems(items: ImportItem[], options: ImportOptions): Promise<ImportOutcome> {
  const outcome: ImportOutcome = {
    added: 0,
    updated: 0,
    duplicatesSkipped: 0,
    needsReview: [],
    unsupported: [],
    failed: [],
    sessionOnlyAdded: 0,
    newTracks: [],
    updatedTracks: [],
  };

  const libraryTracks: Track[] = [...options.existingTracks];

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
      const tailHash = extractTailHash(fingerprint);
      const tags = await parseAudioTags(file);
      const fallback = deriveArtistTitleFromFileName(file.name);
      const normalized = normalizeTrackMetadata(
        {
          title: tags.title ?? fallback.title,
          artist: tags.artist ?? fallback.artist,
          album: tags.album ?? "",
          durationMs: probe.durationMs,
          fileName: file.name,
        },
        { libraryTracks },
      );

      const normalizedTitle = normalizeForSearch(normalized.title || tags.title || fallback.title);
      const normalizedArtist = normalizeForSearch(normalized.artist || tags.artist || fallback.artist);
      const rawTitle = normalized.title || tags.title || fallback.title;
      const rawArtist = normalized.artist || tags.artist || fallback.artist;

      const matchedCandidate = findMatchingExistingTrack({
        file,
        fingerprint,
        tailHash,
        durationMs: probe.durationMs,
        normalizedTitle,
        normalizedArtist,
        rawTitle,
        rawArtist,
        tracks: libraryTracks,
      });

      const isHandle = await itemIsHandle(item);

      if (matchedCandidate) {
        const matchedTrack = matchedCandidate.match;
        const comparison = evaluateMetadataImprovement(matchedTrack, tags, fallback, probe.durationMs);
        const wasBroken = matchedTrack.availability === "broken" || Boolean(matchedTrack.broken?.isBroken);

        if (comparison.hasImprovement || wasBroken) {
          // Safe audio replacement: do not overwrite track if audio replacement fails
          let audioUpdateSucceeded = true;
          try {
            if (isHandle) {
              await repository.putHandle(matchedTrack.id, item as FileSystemFileHandle);
            } else if (options.storeCopies) {
              await repository.putAudioBlob(matchedTrack.id, file);
            } else {
              rememberSessionFile(matchedTrack.id, file);
            }
          } catch (error) {
            audioUpdateSucceeded = false;
            outcome.failed.push({
              fileName: file.name,
              reason: error instanceof Error ? error.message : "Failed to replace audio file",
            });
          }

          if (!audioUpdateSucceeded) {
            done += 1;
            continue;
          }

          if (comparison.improvedArtwork) {
            await repository.putArtwork(matchedTrack.id, comparison.improvedArtwork);
          }

          const updatedTrack: Track = {
            ...matchedTrack,
            id: matchedTrack.id,
            addedAt: matchedTrack.addedAt,
            isLiked: matchedTrack.isLiked,
            playCount: matchedTrack.playCount,
            lastPlayedAt: matchedTrack.lastPlayedAt,
            objectKey: matchedTrack.objectKey,
            artworkObjectKey: matchedTrack.artworkObjectKey,
            storageProvider: matchedTrack.storageProvider,
            cloudStatus: matchedTrack.cloudStatus,
            lastSyncedAt: matchedTrack.lastSyncedAt,
            availability: wasBroken ? "available" : matchedTrack.availability,
            broken: wasBroken ? null : matchedTrack.broken,
            title: comparison.improvedTitle ?? matchedTrack.title,
            artist: comparison.improvedArtist ?? matchedTrack.artist,
            album: comparison.improvedAlbum ?? matchedTrack.album,
            trackNumber: comparison.improvedTrackNumber !== undefined ? comparison.improvedTrackNumber : matchedTrack.trackNumber,
            albumTrackCount: comparison.improvedAlbumTrackCount !== undefined ? comparison.improvedAlbumTrackCount : matchedTrack.albumTrackCount,
            durationMs: matchedTrack.durationMs ?? probe.durationMs,
            metadataFromFilename: comparison.hasNewTags ? false : matchedTrack.metadataFromFilename,
            fileName: file.name,
            fileSize: file.size,
            mimeType: file.type || matchedTrack.mimeType,
            fingerprint: fingerprint || matchedTrack.fingerprint,
            accessMode: isHandle ? "handle" : options.storeCopies ? "stored-copy" : "session-only",
          };

          await repository.putTracks([updatedTrack]);
          outcome.updated = (outcome.updated ?? 0) + 1;
          outcome.updatedTracks!.push(updatedTrack);

          const idx = libraryTracks.findIndex((t) => t.id === matchedTrack.id);
          if (idx !== -1) libraryTracks[idx] = updatedTrack;
          else libraryTracks.push(updatedTrack);
        } else {
          outcome.duplicatesSkipped += 1;
        }
      } else {
        // No match: add as a brand new track
        // Check for potential ambiguity / alternate recording to flag in needsReview
        const currentDurationMs = probe.durationMs;
        if (normalizedTitle && normalizedArtist && currentDurationMs !== null) {
          const ambiguous = libraryTracks.find((t) => {
            if (!t.title || !t.artist || !t.durationMs) return false;
            return (
              normalizeForSearch(t.title) === normalizedTitle &&
              normalizeForSearch(t.artist) === normalizedArtist &&
              Math.abs(t.durationMs - currentDurationMs) <= 1500
            );
          });
          if (ambiguous) {
            outcome.needsReview?.push({
              fileName: file.name,
              reason: `Possible alternate recording of "${ambiguous.title}" by ${ambiguous.artist} was imported as a separate track.`,
            });
          }
        }

        const accessMode: Track["accessMode"] = isHandle ? "handle" : options.storeCopies ? "stored-copy" : "session-only";

        const track: Track = {
          id: createId(),
          title: normalized.title || tags.title || fallback.title,
          artist: normalized.artist || tags.artist || fallback.artist,
          album: normalized.album ?? tags.album ?? "",
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
        outcome.newTracks!.push(track);
        if (accessMode === "session-only") outcome.sessionOnlyAdded += 1;
        outcome.added += 1;
        libraryTracks.push(track);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown error";
      outcome.failed.push({ fileName: file.name, reason });
    }
    done += 1;
  }
  options.onProgress?.({ done: items.length, total: items.length, currentName: "" });
  return outcome;
}
