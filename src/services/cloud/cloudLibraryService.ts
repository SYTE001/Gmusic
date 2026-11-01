import type { Playlist, Track, TrackLyrics } from "../../types";
import { getSupabaseClient, getAuthenticatedUserId } from "./cloudAuthService";

/**
 * CloudLibraryService — Postgres-side library synchronization (spec §4/§5).
 *
 * Sync is idempotent by construction: every write is an upsert keyed on the
 * stable local ids, so retries, reconnects, and re-installs converge instead
 * of duplicating rows. Rows are user-scoped and RLS-enforced server-side.
 *
 * Only R2 object keys are ever written to Postgres — never presigned URLs.
 */

export type CloudTrackRow = {
  id: string;
  user_id: string;
  object_key: string | null;
  artwork_object_key: string | null;
  title: string;
  artist: string;
  album: string;
  track_number: number | null;
  album_track_count: number | null;
  duration_ms: number | null;
  file_name: string;
  file_size: number;
  mime_type: string;
  fingerprint: string | null;
  metadata_from_filename: boolean;
  is_liked: boolean;
  play_count: number;
  last_played_at: string | null;
  added_at: string | null;
  last_synced_at: string | null;
};

export type CloudPlaylistRow = {
  id: string;
  user_id: string;
  name: string;
  description: string;
  created_at: string | null;
  updated_at: string | null;
  track_ids: string[];
};

export type CloudLyricsRow = {
  track_id: string;
  user_id: string;
  format: "lrc" | "txt";
  lines: unknown;
  offset_ms: number;
  skipped_lines: number;
  source_name: string;
  origin: unknown;
  updated_at: string | null;
};

export type CloudPlaybackRow = {
  track_id: string;
  user_id: string;
  play_count: number;
  last_played_at: string | null;
  position_ms: number;
  updated_at: string | null;
};

export type CloudPlaylistTrackRow = {
  playlist_id: string;
  track_id: string;
  user_id: string;
  position: number;
  added_at: string;
};

export type CloudLibrarySnapshot = {
  tracks: CloudTrackRow[];
  playlists: CloudPlaylistRow[];
  lyrics: CloudLyricsRow[];
};

export class CloudLibraryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudLibraryError";
  }
}

function requireClient() {
  const supabase = getSupabaseClient();
  if (!supabase) throw new CloudLibraryError("Cloud library is not configured on this build.");
  return supabase;
}

/**
 * The Supabase client returns `error` as a PLAIN OBJECT (not an Error) on the
 * normal `{ data, error }` path, so `String(error)` renders "[object Object]"
 * and the real database cause is lost. PostgREST errors carry `message`,
 * `code`, `details`, and `hint`; this pulls whatever exists.
 *
 * `describeDatabaseError` is the concise, UI-safe form (what happened plus the
 * stable code); `describeDatabaseErrorDetailed` adds `details`/`hint`, which
 * the PostgREST docs themselves call the most useful field but which can carry
 * raw SQL, so it is reserved for developer logs.
 */
export function describeDatabaseError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const fields = error as Record<string, unknown>;
    const message = typeof fields.message === "string" ? fields.message.trim() : "";
    if (message) {
      const code = typeof fields.code === "string" ? fields.code.trim() : "";
      return code ? `${message} (code ${code})` : message;
    }
    // No message at all: code, then details/hint, are the only signal left.
    const code = typeof fields.code === "string" ? fields.code.trim() : "";
    if (code) return code;
    for (const field of ["details", "hint"] as const) {
      const value = typeof fields[field] === "string" ? (fields[field] as string).trim() : "";
      if (value) return value;
    }
  }
  if (error === null) return "null";
  if (error === undefined) return "undefined";
  return String(error);
}

export function describeDatabaseErrorDetailed(error: unknown): string {
  if (typeof error !== "object" || error === null || error instanceof Error) {
    return describeDatabaseError(error);
  }
  const fields = error as Record<string, unknown>;
  const hint = typeof fields.hint === "string" ? fields.hint.trim() : "";
  const details = typeof fields.details === "string" ? fields.details.trim() : "";
  const base = describeDatabaseError(error);
  if (!hint && !details) return base;
  return `${base} — ${hint || details}`;
}

/**
 * Text written to Postgres must be encodable as UTF-8 and may not contain NUL.
 * Lone surrogates and raw NUL bytes arrive from corrupted tag frames and
 * mis-decoded filenames; Postgres rejects the whole row for them. Valid text
 * passes through byte-for-byte — this never rewrites a real filename, it only
 * drops sequences that cannot be stored at all.
 */
export function sanitizeTextForDatabase(value: string): string {
  let result = "";
  let index = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === 0) {
      index += 1; // Postgres text cannot hold a NUL
      continue;
    }
    const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
    if (isHighSurrogate || (code >= 0xdc00 && code <= 0xdfff)) {
      const next = value.charCodeAt(index + 1);
      if (isHighSurrogate && next >= 0xdc00 && next <= 0xdfff) {
        result += value.slice(index, index + 2); // a complete pair: a real character
        index += 2;
        continue;
      }
      index += 1; // lone surrogate half: not encodable as UTF-8
      continue;
    }
    result += value.charAt(index);
    index += 1;
  }
  return result;
}

/** Postgres `integer` columns reject anything outside int4; a corrupt tag frame can exceed it. */
const INT4_MIN = -2147483648;
const INT4_MAX = 2147483647;

export function sanitizeInt4(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const truncated = Math.trunc(value);
  if (!Number.isSafeInteger(truncated) || truncated < INT4_MIN || truncated > INT4_MAX) return null;
  return truncated;
}

async function denyOnAuthError(error: unknown, context: string): Promise<never> {
  // Developer log keeps the full object (message, code, details, hint) exactly
  // as the PostgREST documentation asks; the thrown message stays concise.
  console.error(`[cloudLibraryService] ${context}:`, error, describeDatabaseErrorDetailed(error));
  throw new CloudLibraryError(`${context}: ${describeDatabaseError(error)}`);
}

function toIso(value: number | null | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function fromIso(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function trackToRow(track: Track, userId = ""): CloudTrackRow {
  return {
    id: track.id,
    user_id: userId,
    object_key: track.objectKey ?? null,
    artwork_object_key: track.artworkObjectKey ?? null,
    title: sanitizeTextForDatabase(track.title),
    artist: sanitizeTextForDatabase(track.artist),
    album: sanitizeTextForDatabase(track.album),
    track_number: sanitizeInt4(track.trackNumber),
    album_track_count: sanitizeInt4(track.albumTrackCount),
    duration_ms: track.durationMs,
    file_name: sanitizeTextForDatabase(track.fileName),
    file_size: track.fileSize,
    mime_type: sanitizeTextForDatabase(track.mimeType),
    fingerprint: track.fingerprint,
    metadata_from_filename: track.metadataFromFilename,
    is_liked: track.isLiked,
    play_count: track.playCount,
    last_played_at: toIso(track.lastPlayedAt),
    added_at: toIso(track.addedAt),
    last_synced_at: toIso(track.lastSyncedAt),
  };
}

export function rowToTrack(row: CloudTrackRow): Track {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    trackNumber: row.track_number,
    albumTrackCount: row.album_track_count,
    durationMs: row.duration_ms,
    fileName: row.file_name,
    fileSize: row.file_size,
    mimeType: row.mime_type,
    addedAt: fromIso(row.added_at) ?? Date.now(),
    lastPlayedAt: fromIso(row.last_played_at),
    playCount: row.play_count,
    isLiked: row.is_liked,
    // A cloud-only track has no local bytes; the local layer re-evaluates
    // this when a local copy is downloaded.
    availability: "available",
    accessMode: "cloud",
    fingerprint: row.fingerprint,
    metadataFromFilename: row.metadata_from_filename,
    objectKey: row.object_key ?? null,
    artworkObjectKey: row.artwork_object_key ?? null,
    storageProvider: row.object_key ? "r2" : null,
    cloudStatus: row.object_key ? "ready" : "local",
    lastSyncedAt: fromIso(row.last_synced_at),
  };
}

export function playlistToRow(playlist: Playlist, userId = ""): CloudPlaylistRow {
  return {
    id: playlist.id,
    user_id: userId,
    name: playlist.name,
    description: playlist.description,
    created_at: toIso(playlist.createdAt),
    updated_at: toIso(playlist.updatedAt),
    track_ids: playlist.trackIds,
  };
}

function rowToPlaylist(row: CloudPlaylistRow): Playlist {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    trackIds: row.track_ids ?? [],
    createdAt: fromIso(row.created_at) ?? Date.now(),
    updatedAt: fromIso(row.updated_at) ?? Date.now(),
  };
}

export function lyricsToRow(lyrics: TrackLyrics, userId = ""): CloudLyricsRow {
  return {
    track_id: lyrics.trackId,
    user_id: userId,
    format: lyrics.format,
    lines: lyrics.lines,
    offset_ms: lyrics.offsetMs,
    skipped_lines: lyrics.skippedLines,
    source_name: lyrics.sourceName,
    origin: lyrics.origin ?? null,
    updated_at: toIso(lyrics.updatedAt),
  };
}

function rowToLyrics(row: CloudLyricsRow): TrackLyrics | null {
  if (!Array.isArray(row.lines)) return null;
  return {
    trackId: row.track_id,
    format: row.format === "txt" ? "txt" : "lrc",
    lines: row.lines as TrackLyrics["lines"],
    offsetMs: row.offset_ms ?? 0,
    updatedAt: fromIso(row.updated_at) ?? Date.now(),
    skippedLines: row.skipped_lines ?? 0,
    sourceName: row.source_name ?? "",
    origin: (row.origin ?? undefined) as TrackLyrics["origin"],
  };
}

/** Fetches the authenticated user's library (RLS scopes rows to them). */
export async function fetchCloudLibrary(): Promise<CloudLibrarySnapshot> {
  const supabase = requireClient();
  const [tracks, playlists, lyrics] = await Promise.all([
    supabase.from("tracks").select("*"),
    supabase.from("playlists").select("id, user_id, name, description, created_at, updated_at"),
    supabase.from("track_lyrics").select("*"),
  ]);

  if (tracks.error) await denyOnAuthError(tracks.error, "Loading cloud tracks failed");
  if (playlists.error) await denyOnAuthError(playlists.error, "Loading cloud playlists failed");
  if (lyrics.error) await denyOnAuthError(lyrics.error, "Loading cloud lyrics failed");

  // Track ids per playlist come from the membership table so ordering is
  // preserved and stale playlist rows cannot imply tracks that were removed.
  const membershipResult = await supabase.from("playlist_tracks").select("playlist_id, track_id, user_id, position");
  if (membershipResult.error) await denyOnAuthError(membershipResult.error, "Loading playlist membership failed");
  const ordered = new Map<string, Array<{ trackId: string; position: number }>>();
  for (const entry of (membershipResult.data ?? []) as Array<{
    playlist_id: string;
    track_id: string;
    position: number;
  }>) {
    const bucket = ordered.get(entry.playlist_id) ?? [];
    bucket.push({ trackId: entry.track_id, position: entry.position });
    ordered.set(entry.playlist_id, bucket);
  }

  const playlistRows: CloudPlaylistRow[] = (playlists.data ?? []).map((playlist: Record<string, unknown>) => ({
    id: String(playlist.id),
    user_id: String(playlist.user_id ?? ""),
    name: String(playlist.name ?? ""),
    description: (playlist.description as string) ?? "",
    created_at: (playlist.created_at as string) ?? null,
    updated_at: (playlist.updated_at as string) ?? null,
    track_ids: (ordered.get(String(playlist.id)) ?? [])
      .sort((a, b) => a.position - b.position)
      .map((entry) => entry.trackId),
  }));

  return {
    tracks: (tracks.data ?? []) as unknown as CloudTrackRow[],
    playlists: playlistRows,
    lyrics: (lyrics.data ?? []) as unknown as CloudLyricsRow[],
  };
}

/**
 * Upserts tracks. Idempotent: rows exist for a stable local id, so retries
 * and cross-device syncs update in place. Fingerprints are matched first so
 * the same audio file never produces a second cloud track — the local id is
 * relinked onto the existing row instead.
 *
 * Returns the object key each track ended up with, plus whether a duplicate
 * was reconciled.
 */
export async function upsertCloudTracks(
  tracks: Track[],
): Promise<{ objectKey: string | null; reconciledWith: string | null }[]> {
  const supabase = requireClient();
  if (tracks.length === 0) return [];
  const userId = await getAuthenticatedUserId();

  // Duplicate reconciliation: an earlier upload of the same audio already has
  // a cloud row. Reuse it rather than creating a second track.
  const fingerprints = tracks.map((track) => track.fingerprint).filter(Boolean) as string[];
  const existing = new Map<string, { id: string; objectKey: string | null }>();
  if (fingerprints.length > 0) {
    const found = await supabase
      .from("tracks")
      .select("id, object_key, fingerprint")
      .in("fingerprint", fingerprints);
    if (found.error) await denyOnAuthError(found.error, "Checking for existing cloud tracks failed");
    for (const row of found.data ?? []) {
      if (typeof row.fingerprint === "string") {
        existing.set(row.fingerprint, { id: row.id, objectKey: row.object_key ?? null });
      }
    }
  }

  const outcome: { objectKey: string | null; reconciledWith: string | null }[] = [];
  const rows: CloudTrackRow[] = [];
  for (const track of tracks) {
    const match = track.fingerprint ? existing.get(track.fingerprint) : undefined;
    if (match && match.id !== track.id) {
      // The cloud already knows this audio under another local id. Point the
      // local track at the existing cloud object instead of re-uploading.
      outcome.push({ objectKey: match.objectKey, reconciledWith: match.id });
      continue;
    }
    rows.push({ ...trackToRow(track, userId), last_synced_at: new Date().toISOString() });
    outcome.push({ objectKey: track.objectKey ?? null, reconciledWith: null });
  }

  if (rows.length > 0) {
    const inserted = await supabase
      .from("tracks")
      .upsert(rows as unknown as Record<string, unknown>[], { onConflict: "id" })
      .select("id");
    if (inserted.error) await denyOnAuthError(inserted.error, "Saving cloud tracks failed");
  }
  return outcome;
}

/** Idempotent playlist upsert that rewrites membership positions wholesale. */
export async function upsertCloudPlaylists(playlists: Playlist[]): Promise<void> {
  const supabase = requireClient();
  if (playlists.length === 0) return;
  const userId = await getAuthenticatedUserId();
  for (const playlist of playlists) {
    const row = playlistToRow(playlist, userId);
    const upserted = await supabase
      .from("playlists")
      .upsert(
        {
          id: row.id,
          user_id: userId,
          name: row.name,
          description: row.description,
          created_at: row.created_at,
          updated_at: row.updated_at,
        } as unknown as Record<string, unknown>,
        { onConflict: "id" },
      );
    if (upserted.error) await denyOnAuthError(upserted.error, "Saving cloud playlists failed");

    if (row.track_ids.length === 0) {
      const cleared = await supabase.from("playlist_tracks").delete().eq("playlist_id", row.id);
      if (cleared.error) await denyOnAuthError(cleared.error, "Updating playlist membership failed");
      continue;
    }

    // Replace membership atomically: deletes and inserts in the same
    // transaction are not possible over PostgREST, so delete-then-insert
    // with a stable idempotent key (playlist_id, track_id).
    const cleared = await supabase.from("playlist_tracks").delete().eq("playlist_id", row.id);
    if (cleared.error) await denyOnAuthError(cleared.error, "Updating playlist membership failed");

    const membership: CloudPlaylistTrackRow[] = row.track_ids.map((trackId, position) => ({
      playlist_id: row.id,
      track_id: trackId,
      user_id: userId,
      position,
      added_at: new Date().toISOString(),
    }));
    const inserted = await supabase
      .from("playlist_tracks")
      .upsert(membership as unknown as Record<string, unknown>[], { onConflict: "playlist_id,track_id" });
    if (inserted.error) await denyOnAuthError(inserted.error, "Saving playlist membership failed");
  }
}

/** Idempotent lyrics upsert keyed on track id. */
export async function upsertCloudLyrics(lyrics: TrackLyrics[]): Promise<void> {
  const supabase = requireClient();
  if (lyrics.length === 0) return;
  const userId = await getAuthenticatedUserId();
  const rows = lyrics.map((entry) => ({
    ...lyricsToRow(entry, userId),
    updated_at: new Date().toISOString(),
  }));
  const result = await supabase
    .from("track_lyrics")
    .upsert(rows as unknown as Record<string, unknown>[], { onConflict: "track_id" });
  if (result.error) await denyOnAuthError(result.error, "Saving cloud lyrics failed");
}

/** Idempotent playback metadata upsert keyed on track id. */
export async function upsertCloudPlayback(
  playback: Array<{ trackId: string; playCount: number; lastPlayedAt: number | null; positionMs: number }>,
): Promise<void> {
  const supabase = requireClient();
  if (playback.length === 0) return;
  const userId = await getAuthenticatedUserId();
  const rows: CloudPlaybackRow[] = playback.map((entry) => ({
    track_id: entry.trackId,
    user_id: userId,
    play_count: entry.playCount,
    last_played_at: toIso(entry.lastPlayedAt),
    position_ms: entry.positionMs,
    updated_at: new Date().toISOString(),
  }));
  const result = await supabase
    .from("track_playback")
    .upsert(rows as unknown as Record<string, unknown>[], { onConflict: "track_id" });
  if (result.error) await denyOnAuthError(result.error, "Saving cloud playback metadata failed");
}

/**
 * Removes a user's cloud metadata rows for a track and then PROVES nothing is
 * left. Every delete is idempotent, so a retry after a partial failure picks
 * up exactly the rows that survived — but this function only succeeds once
 * the track has no rows anywhere, which is what keeps failures from leaking
 * membership or lyric rows that reference a track it can no longer reach.
 */
export async function deleteCloudTrackMetadata(trackId: string): Promise<void> {
  const supabase = requireClient();
  const tables: Array<[name: string, column: string]> = [
    ["playlist_tracks", "track_id"],
    ["track_lyrics", "track_id"],
    ["track_playback", "track_id"],
    ["tracks", "id"],
  ];

  // Children first; deleting the parent row first would orphan memberships
  // if the request died between queries.
  for (const [table, column] of tables) {
    const result = await supabase.from(table).delete().eq(column, trackId);
    if (result.error) await denyOnAuthError(result.error, `Removing ${table} rows failed`);
  }

  const leftover: string[] = [];
  for (const [table, column] of tables) {
    const rows = await supabase.from(table).select(column).eq(column, trackId);
    if (rows.error) await denyOnAuthError(rows.error, `Verifying ${table} cleanup failed`);
    if ((rows.data ?? []).length > 0) leftover.push(`${table} (${(rows.data as unknown[]).length})`);
  }
  if (leftover.length > 0) {
    throw new CloudLibraryError(
      `Cloud metadata for this track could not be fully removed: ${leftover.join(", ")}. It will be retried.`,
    );
  }
}

/** Maps a fetched snapshot into local entity shapes (used by the sync flow). */
export function snapshotToLocalEntities(snapshot: CloudLibrarySnapshot): {
  tracks: Track[];
  playlists: Playlist[];
  lyrics: TrackLyrics[];
} {
  return {
    tracks: snapshot.tracks.map(rowToTrack),
    playlists: snapshot.playlists.map(rowToPlaylist),
    lyrics: snapshot.lyrics.map(rowToLyrics).filter((lyrics): lyrics is TrackLyrics => lyrics !== null),
  };
}
