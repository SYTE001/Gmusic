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
  URL.revokeObjectURL(url);
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

  for (const [index, entry] of (record.tracks as unknown[]).entries()) {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.title !== "string" || typeof entry.fileName !== "string") {
      errors.push(`Track entry ${index + 1} is malformed (missing id/title/fileName).`);
      if (errors.length > 5) break;
    }
  }
  for (const [index, entry] of (record.playlists as unknown[]).entries()) {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.name !== "string" || !Array.isArray(entry.trackIds)) {
      errors.push(`Playlist entry ${index + 1} is malformed.`);
      if (errors.length > 5) break;
    }
  }
  for (const [index, entry] of (record.lyrics as unknown[]).entries()) {
    if (!isRecord(entry) || typeof entry.trackId !== "string" || !Array.isArray(entry.lines)) {
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

/**
 * Replaces library metadata with the backup contents. Audio files always need
 * re-import/relink afterwards — by design, backups carry no audio.
 */
export async function restoreBackup(backup: BackupFile): Promise<void> {
  const tracks: Track[] = backup.tracks.map((track) => ({
    ...track,
    // Local file access never survives a backup round-trip; a cloud object
    // key does, and is re-evaluated when the local library next validates.
    availability: track.objectKey ? "offline" : "missing",
    accessMode: track.objectKey ? "cloud" : "session-only",
  }));
  const playlists: Playlist[] = backup.playlists.map((playlist) => ({
    ...playlist,
    trackIds: playlist.trackIds.filter((id) => tracks.some((track) => track.id === id)),
  }));
  await repository.clearLibrary();
  await repository.putTracks(tracks);
  for (const playlist of playlists) await repository.putPlaylist(playlist);
  for (const lyrics of backup.lyrics) {
    if (tracks.some((track) => track.id === lyrics.trackId)) {
      await repository.putLyrics(lyrics);
    }
  }
  if (backup.preferences) {
    const rawPrefs = backup.preferences as Partial<AppPreferences>;
    const restoredPrefs: AppPreferences = {
      ...DEFAULT_PREFERENCES,
      ...rawPrefs,
      lyricsStyle: rawPrefs.lyricsStyle === "word" ? "word" : "line",
      schemaVersion: DB_SCHEMA_VERSION,
    };
    await repository.putPreferences(restoredPrefs);
  }
}
