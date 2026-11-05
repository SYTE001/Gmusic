import type { AppPreferences, Playlist, Track, TrackLyrics } from "../../types";
import { APP_VERSION, BACKUP_SCHEMA_VERSION, DB_SCHEMA_VERSION } from "../../types";
import { repository } from "../indexeddb/LibraryRepository";
import { DEFAULT_PREFERENCES } from "../../stores/settingsStore";

/**
 * Versioned JSON backup of metadata only (PRD §7.11): no audio bytes, no
 * file handles, no machine-specific paths. Restored tracks keep their
 * metadata but must be re-linked to audio files on the device.
 */

export type BackupFile = {
  app: "local-music";
  schemaVersion: number;
  appVersion?: string;
  exportedAt: string;
  tracks: Track[];
  playlists: Playlist[];
  lyrics: TrackLyrics[];
  preferences?: Omit<AppPreferences, "lastTrackId" | "lastPositionMs">;
};

export type BackupSummary = {
  trackCount: number;
  playlistCount: number;
  lyricCount: number;
  likedCount: number;
  exportedAt: string | null;
};

export type ValidationResult =
  | { ok: true; backup: BackupFile; summary: BackupSummary }
  | { ok: false; errors: string[] };

export async function buildBackup(): Promise<BackupFile> {
  const [tracks, playlists, prefs] = await Promise.all([
    repository.listTracks(),
    repository.listPlaylists(),
    repository.getPreferences(),
  ]);
  const lyricEntries: TrackLyrics[] = [];
  for (const track of tracks) {
    const lyrics = await repository.getLyrics(track.id);
    if (lyrics) lyricEntries.push(lyrics);
  }

  const sanitisedTracks: Track[] = tracks.map((track) => ({
    ...track,
    // A restored backup never carries live file access. A cloud object key
    // survives (it is a server-side reference, not a session token) — the
    // cloud copy is re-verified on the next authenticated sync.
    availability: track.objectKey ? "offline" : "missing",
    accessMode: track.objectKey ? "cloud" : "session-only",
  }));

  return {
    app: "local-music",
    schemaVersion: BACKUP_SCHEMA_VERSION,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    tracks: sanitisedTracks,
    playlists,
    lyrics: lyricEntries,
    preferences: prefs
      ? {
          theme: prefs.theme,
          volume: prefs.volume,
          shuffle: prefs.shuffle,
          repeatMode: prefs.repeatMode,
          reducedMotion: prefs.reducedMotion,
          artworkTint: prefs.artworkTint,
          lyricsStyle: prefs.lyricsStyle,
          lyricFontSize: prefs.lyricFontSize,
          lyricAlignment: prefs.lyricAlignment,
          lyricLineSpacing: prefs.lyricLineSpacing,
          storeAudioCopies: prefs.storeAudioCopies,
          autoFetchLyrics: prefs.autoFetchLyrics,
          schemaVersion: prefs.schemaVersion,
        }
      : undefined,
  };
}

export function downloadBackup(backup: BackupFile): void {
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const date = new Date().toISOString().slice(0, 10);
  anchor.href = url;
  anchor.download = `local-music-backup-${date}.json`;
  anchor.click();
  // Revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Full validation before anything is mutated (rules §6). */
export function validateBackupText(text: string): ValidationResult {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["The file is not valid JSON."] };
  }
  if (!isRecord(parsed)) return { ok: false, errors: ["The backup must be a JSON object."] };
  if (parsed.app !== "local-music") errors.push("This file was not exported from Local Music (wrong app identifier).");
  const schemaVersion = Number(parsed.schemaVersion);
  if (!Number.isFinite(schemaVersion) || schemaVersion < 1 || schemaVersion > BACKUP_SCHEMA_VERSION) {
    errors.push(`Unsupported backup schema version: ${String(parsed.schemaVersion)}.`);
  }
  if (!Array.isArray(parsed.tracks)) errors.push("Missing tracks array.");
  if (!Array.isArray(parsed.playlists)) errors.push("Missing playlists array.");
  if (!Array.isArray(parsed.lyrics)) errors.push("Missing lyrics array.");
  if (errors.length > 0) return { ok: false, errors };

  const record = parsed as Record<string, unknown>;

  const seenTrackIds = new Set<string>();
  for (const [index, entry] of (record.tracks as unknown[]).entries()) {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.title !== "string" || typeof entry.fileName !== "string") {
      errors.push(`Track entry ${index + 1} is malformed (missing id/title/fileName).`);
      if (errors.length > 5) break;
    } else if (seenTrackIds.has(entry.id)) {
      errors.push(`Track entry ${index + 1} repeats the id "${entry.id}".`);
      if (errors.length > 5) break;
    } else {
      seenTrackIds.add(entry.id);
    }
  }
  for (const [index, entry] of (record.playlists as unknown[]).entries()) {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.name !== "string" || !Array.isArray(entry.trackIds) || entry.trackIds.some((id) => typeof id !== "string")) {
      errors.push(`Playlist entry ${index + 1} is malformed.`);
      if (errors.length > 5) break;
    }
  }
  for (const [index, entry] of (record.lyrics as unknown[]).entries()) {
    if (!isRecord(entry) || typeof entry.trackId !== "string" || !Array.isArray(entry.lines) || entry.lines.some((line) => !isRecord(line) || typeof line.text !== "string")) {
      errors.push(`Lyrics entry ${index + 1} is malformed.`);
      if (errors.length > 5) break;
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const backup = parsed as unknown as BackupFile;
  const summary: BackupSummary = {
    trackCount: backup.tracks.length,
    playlistCount: backup.playlists.length,
    lyricCount: backup.lyrics.length,
    likedCount: backup.tracks.filter((track) => track.isLiked).length,
    exportedAt: backup.exportedAt ?? null,
  };
  return { ok: true, backup, summary };
}

const num = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const numOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const str = (value: unknown, fallback: string): string => (typeof value === "string" ? value : fallback);

/** Fills defaults for fields an older or hand-edited backup may lack, so a restored track can never crash the UI. */
function normalizeTrack(track: Track, hasHandle: boolean, hasStoredCopy: boolean): Track {
  const cloud = Boolean(track.objectKey);
  // Local file access survives only where the device still owns the record;
  // otherwise the track needs re-import/relink (or its cloud copy).
  const accessMode: Track["accessMode"] = hasStoredCopy ? "stored-copy" : hasHandle ? "handle" : cloud ? "cloud" : "session-only";
  return {
    ...track,
    artist: str(track.artist, "Unknown Artist"),
    album: str(track.album, ""),
    trackNumber: numOrNull(track.trackNumber),
    albumTrackCount: numOrNull(track.albumTrackCount),
    durationMs: numOrNull(track.durationMs),
    fileSize: num(track.fileSize, 0),
    mimeType: str(track.mimeType, ""),
    addedAt: num(track.addedAt, Date.now()),
    lastPlayedAt: numOrNull(track.lastPlayedAt),
    playCount: num(track.playCount, 0),
    isLiked: track.isLiked === true,
    fingerprint: typeof track.fingerprint === "string" ? track.fingerprint : null,
    metadataFromFilename: track.metadataFromFilename === true,
    availability: hasHandle || hasStoredCopy ? "available" : cloud ? "offline" : "missing",
    accessMode,
  };
}

/** Keeps only known preference keys whose value has the same type as the default. */
function sanitizePreferences(raw: Partial<AppPreferences>): AppPreferences {
  const prefs: Record<string, unknown> = { ...DEFAULT_PREFERENCES };
  for (const key of Object.keys(DEFAULT_PREFERENCES) as Array<keyof AppPreferences>) {
    if (typeof raw[key] === typeof DEFAULT_PREFERENCES[key]) prefs[key] = raw[key];
  }
  return {
    ...(prefs as AppPreferences),
    lyricsStyle: raw.lyricsStyle === "word" ? "word" : "line",
    schemaVersion: DB_SCHEMA_VERSION,
  };
}

/**
 * Replaces library metadata with the backup contents in a single database
 * transaction: if anything fails, the previous library is kept untouched.
 * File handles and stored copies of tracks that exist in the backup are
 * preserved (so restoring on the same device keeps working links); tracks
 * without a local file still need re-import/relink — backups carry no audio.
 */
export async function restoreBackup(backup: BackupFile): Promise<void> {
  await repository.replaceLibrary({
    tracks: (handleIds, audioIds) =>
      backup.tracks.map((track) => normalizeTrack(track, handleIds.has(track.id), audioIds.has(track.id))),
    playlists: (trackIds) =>
      backup.playlists.map((playlist) => ({
        ...playlist,
        trackIds: playlist.trackIds.filter((id) => trackIds.has(id)),
      })),
    lyrics: (trackIds) => backup.lyrics.filter((lyrics) => trackIds.has(lyrics.trackId)),
    preferences: backup.preferences ? sanitizePreferences(backup.preferences as Partial<AppPreferences>) : undefined,
  });
}