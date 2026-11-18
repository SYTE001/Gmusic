import { invoke } from "@tauri-apps/api/core";
import type {
  AppPreferences,
  LyricsCacheMeta,
  PendingMetadataSync,
  Playlist,
  Track,
  TrackLyrics,
} from "../../types";
import type { PendingCloudDeletion } from "../indexeddb/LibraryRepository";
import { isTauriRuntime } from "./desktop";

export type PersistenceAuthority =
  | "indexeddb"
  | "migrating"
  | "sqlite"
  | "recovery-required";

export interface PersistenceStatus {
  authority: PersistenceAuthority;
  schemaVersion: number;
  integrityOk: boolean;
  integrityErrors: string[];
  trackCount: number;
  playlistCount: number;
  lyricsCount: number;
  lyricsMetaCount: number;
  prefsCount: number;
  artworkCount: number;
  audioCount: number;
  migrationId: string | null;
  lastError: string | null;
  recoveryGuidance: string | null;
}

export interface MigrationBeginRequest {
  migrationId: string;
  expectedTracks: number;
  expectedPlaylists: number;
  expectedLyrics: number;
  expectedLyricsMeta: number;
  expectedPrefs: number;
  expectedArtwork: number;
  expectedAudio: number;
  expectedChecksum: string;
  forceReimport?: boolean;
}

export interface BinaryBlobPayload {
  trackId: string;
  mimeType: string;
  bytes: number[];
  sha256: string;
}

export interface MigrationBatchRequest {
  migrationId: string;
  tracks?: Track[];
  playlists?: Playlist[];
  lyrics?: TrackLyrics[];
  lyricsMeta?: LyricsCacheMeta[];
  prefs?: Array<{ name: string; payload: unknown }>;
  artwork?: BinaryBlobPayload[];
  audio?: BinaryBlobPayload[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isValidPersistenceStatus(value: unknown): value is PersistenceStatus {
  if (!isObject(value)) return false;
  const validAuth = ["indexeddb", "migrating", "sqlite", "recovery-required"];
  return (
    validAuth.includes(String(value.authority)) &&
    typeof value.schemaVersion === "number" &&
    typeof value.integrityOk === "boolean" &&
    Array.isArray(value.integrityErrors) &&
    typeof value.trackCount === "number" &&
    typeof value.playlistCount === "number" &&
    typeof value.lyricsCount === "number" &&
    typeof value.lyricsMetaCount === "number" &&
    typeof value.prefsCount === "number" &&
    typeof value.artworkCount === "number" &&
    typeof value.audioCount === "number"
  );
}

export async function computeBytesSha256(bytes: number[] | Uint8Array): Promise<string> {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", arr as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function blobToByteArray(value: unknown): Promise<number[]> {
  if (value === null || value === undefined) return [];
  if (value instanceof ArrayBuffer) {
    return Array.from(new Uint8Array(value));
  }
  if (ArrayBuffer.isView(value)) {
    return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (Array.isArray(value)) {
    return value.map((v) => Number(v) & 0xff);
  }
  const blob = value as Blob & { _buffer?: Uint8Array | ArrayBuffer };
  if (typeof blob.arrayBuffer === "function") {
    try {
      const buf = await blob.arrayBuffer();
      if (buf && (buf.byteLength > 0 || blob.size === 0)) {
        return Array.from(new Uint8Array(buf));
      }
    } catch {
      // Fall through to alternative readers
    }
  }
  if (blob._buffer) {
    if (blob._buffer instanceof ArrayBuffer) {
      return Array.from(new Uint8Array(blob._buffer));
    }
    if (ArrayBuffer.isView(blob._buffer)) {
      return Array.from(
        new Uint8Array(blob._buffer.buffer, blob._buffer.byteOffset, blob._buffer.byteLength),
      );
    }
  }
  if (isObject(value)) {
    // Extract internal jsdom Blob buffer symbol if structured clone returned a plain object
    for (const sym of Object.getOwnPropertySymbols(value)) {
      const impl = (value as Record<symbol, unknown>)[sym];
      if (isObject(impl) && impl._buffer) {
        const b = impl._buffer;
        if (b instanceof ArrayBuffer) return Array.from(new Uint8Array(b));
        if (ArrayBuffer.isView(b)) {
          return Array.from(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
        }
      }
    }
    // Also check if structured clone copied `_buffer` as a numeric-keyed or Buffer-like object
    if (isObject(value._buffer)) {
      const rawBuf = value._buffer as Record<string, unknown>;
      if (rawBuf.type === "Buffer" && Array.isArray(rawBuf.data)) {
        return (rawBuf.data as unknown[]).map((v) => Number(v) & 0xff);
      }
    }
  }
  if (typeof FileReader !== "undefined") {
    try {
      const buf = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
        reader.readAsArrayBuffer(blob as Blob);
      });
      if (buf && (buf.byteLength > 0 || blob.size === 0)) {
        return Array.from(new Uint8Array(buf));
      }
    } catch {
      // Fall through
    }
  }
  if (typeof Response !== "undefined" && typeof Blob !== "undefined" && value instanceof Blob) {
    try {
      const buf = await new Response(value).arrayBuffer();
      if (buf && (buf.byteLength > 0 || value.size === 0)) {
        return Array.from(new Uint8Array(buf));
      }
    } catch {
      // Fall through
    }
  }
  if (isObject(value) && typeof value.size === "number" && value.size === 0) {
    return [];
  }
  throw new Error("Blob binary content is unreadable and cannot be migrated without data loss.");
}

export function byteArrayToBlob(raw: unknown, defaultMime = "application/octet-stream"): Blob | undefined {
  if (!isObject(raw)) return undefined;
  const mimeType = typeof raw.mimeType === "string" && raw.mimeType ? raw.mimeType : defaultMime;
  if (raw.bytes instanceof ArrayBuffer) {
    return new Blob([raw.bytes], { type: mimeType });
  }
  if (ArrayBuffer.isView(raw.bytes)) {
    const view = new Uint8Array(raw.bytes.buffer, raw.bytes.byteOffset, raw.bytes.byteLength);
    return new Blob([view.slice()], { type: mimeType });
  }
  if (Array.isArray(raw.bytes)) {
    return new Blob([new Uint8Array(raw.bytes)], { type: mimeType });
  }
  return undefined;
}

/**
 * Deterministic checksum matching Rust's `compute_library_checksum` in `src-tauri/src/persistence/repository.rs`.
 */
export async function computeSnapshotChecksum(data: {
  tracks: Track[];
  playlists: Playlist[];
  lyrics: TrackLyrics[];
}): Promise<string> {
  const sortedTracks = [...data.tracks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sortedPlaylists = [...data.playlists].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sortedLyrics = [...data.lyrics].sort((a, b) =>
    a.trackId < b.trackId ? -1 : a.trackId > b.trackId ? 1 : 0,
  );

  let canonical = "";
  for (const t of sortedTracks) {
    const dur = typeof t.durationMs === "number" && Number.isFinite(t.durationMs) ? Math.trunc(t.durationMs) : -1;
    const liked = t.isLiked ? 1 : 0;
    const pc = typeof t.playCount === "number" && Number.isFinite(t.playCount) ? Math.trunc(t.playCount) : 0;
    const fsize = typeof t.fileSize === "number" && Number.isFinite(t.fileSize) ? Math.trunc(t.fileSize) : 0;
    canonical += `T:${t.id}|${t.title}|${t.artist ?? ""}|${t.album ?? ""}|${dur}|${t.fileName}|${fsize}|${liked}|${pc}\n`;
  }
  for (const p of sortedPlaylists) {
    canonical += `P:${p.id}|${p.name}|${p.description ?? ""}|${(p.trackIds ?? []).join(",")}\n`;
  }
  for (const l of sortedLyrics) {
    const off = typeof l.offsetMs === "number" && Number.isFinite(l.offsetMs) ? Math.trunc(l.offsetMs) : 0;
    canonical += `L:${l.trackId}|${l.format}|${off}|${l.sourceName ?? ""}\n`;
  }

  const encoded = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function getDesktopPersistenceStatus(): Promise<PersistenceStatus | null> {
  if (!isTauriRuntime()) return null;
  const res = await invoke<unknown>("get_desktop_persistence_status");
  if (!isValidPersistenceStatus(res)) {
    throw new Error("Invalid desktop persistence status response.");
  }
  return res;
}

export async function beginDesktopIdbMigration(
  request: MigrationBeginRequest,
): Promise<PersistenceStatus | null> {
  if (!isTauriRuntime()) return null;
  const res = await invoke<unknown>("begin_desktop_idb_migration", { request });
  if (!isValidPersistenceStatus(res)) {
    throw new Error("Invalid desktop migration begin response.");
  }
  return res;
}

async function validateMigrationBlobDigest(
  kind: "Artwork" | "Audio",
  entry: BinaryBlobPayload,
): Promise<void> {
  if (!Array.isArray(entry.bytes) || entry.bytes.length === 0) {
    throw new Error(`${kind} bytes in migration batch cannot be empty.`);
  }
  const rawDigest = typeof entry.sha256 === "string" ? entry.sha256.trim() : "";
  if (!rawDigest) {
    throw new Error(`Missing SHA-256 digest for ${kind} track ${entry.trackId}.`);
  }
  if (!/^[0-9a-fA-F]{64}$/.test(rawDigest)) {
    throw new Error(
      `Malformed SHA-256 digest for ${kind} track ${entry.trackId}: expected 64 hex characters.`,
    );
  }
  const actual = await computeBytesSha256(entry.bytes);
  if (actual.toLowerCase() !== rawDigest.toLowerCase()) {
    throw new Error(
      `${kind} SHA-256 mismatch for track ${entry.trackId} (expected ${rawDigest}, got ${actual}).`,
    );
  }
}

export async function writeDesktopIdbMigrationBatch(batch: MigrationBatchRequest): Promise<void> {
  if (!isTauriRuntime()) return;
  for (const art of batch.artwork ?? []) {
    await validateMigrationBlobDigest("Artwork", art);
  }
  for (const aud of batch.audio ?? []) {
    await validateMigrationBlobDigest("Audio", aud);
  }
  await invoke("write_desktop_idb_migration_batch", { batch });
}

export async function finalizeDesktopIdbMigration(
  migrationId: string,
): Promise<PersistenceStatus | null> {
  if (!isTauriRuntime()) return null;
  const res = await invoke<unknown>("finalize_desktop_idb_migration", { migrationId });
  if (!isValidPersistenceStatus(res)) {
    throw new Error("Invalid desktop migration finalize response.");
  }
  return res;
}

export async function failDesktopIdbMigration(reason: string): Promise<PersistenceStatus | null> {
  if (!isTauriRuntime()) return null;
  const res = await invoke<unknown>("fail_desktop_idb_migration", { reason });
  if (!isValidPersistenceStatus(res)) {
    throw new Error("Invalid desktop migration fail response.");
  }
  return res;
}

// ---- SQLite CRUD IPC wrappers ----

export async function sqliteListTracks(): Promise<Track[]> {
  if (!isTauriRuntime()) return [];
  const res = await invoke<unknown>("sqlite_list_tracks");
  if (!Array.isArray(res)) throw new Error("Invalid sqlite_list_tracks response.");
  return res as Track[];
}

export async function sqliteGetTrack(id: string): Promise<Track | undefined> {
  if (!isTauriRuntime()) return undefined;
  const res = await invoke<unknown>("sqlite_get_track", { id });
  if (res === null || res === undefined) return undefined;
  if (!isObject(res) || typeof res.id !== "string") {
    throw new Error("Invalid sqlite_get_track response.");
  }
  return res as unknown as Track;
}

export async function sqlitePutTracks(tracks: Track[]): Promise<void> {
  if (!isTauriRuntime() || tracks.length === 0) return;
  await invoke("sqlite_put_tracks", { tracks });
}

export async function sqlitePutTrackWithFiles(
  track: Track,
  files: { artwork?: Blob; audio?: Blob },
): Promise<void> {
  if (!isTauriRuntime()) return;
  const artwork = files.artwork
    ? {
        trackId: track.id,
        mimeType: files.artwork.type || "image/jpeg",
        bytes: await blobToByteArray(files.artwork),
      }
    : null;
  const audio = files.audio
    ? {
        trackId: track.id,
        mimeType: files.audio.type || track.mimeType || "audio/mpeg",
        bytes: await blobToByteArray(files.audio),
      }
    : null;
  await invoke("sqlite_put_track_with_files", { track, artwork, audio });
}

export async function sqliteDeleteTracks(ids: string[]): Promise<void> {
  if (!isTauriRuntime() || ids.length === 0) return;
  await invoke("sqlite_delete_tracks", { ids });
}

export async function sqliteGetArtwork(trackId: string): Promise<Blob | undefined> {
  if (!isTauriRuntime()) return undefined;
  const res = await invoke<unknown>("sqlite_get_artwork", { trackId });
  if (res === null || res === undefined) return undefined;
  return byteArrayToBlob(res, "image/jpeg");
}

export async function sqlitePutArtwork(trackId: string, blob: Blob): Promise<void> {
  if (!isTauriRuntime()) return;
  const bytes = await blobToByteArray(blob);
  await invoke("sqlite_put_artwork", { trackId, bytes });
}

export async function sqliteDeleteArtwork(trackId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("sqlite_delete_artwork", { trackId });
}

export async function sqliteListArtworkTrackIds(): Promise<Set<string>> {
  if (!isTauriRuntime()) return new Set();
  const res = await invoke<unknown>("sqlite_list_artwork_track_ids");
  if (!Array.isArray(res)) throw new Error("Invalid sqlite_list_artwork_track_ids response.");
  return new Set(res.map(String));
}

export async function sqliteGetAudioBlob(trackId: string): Promise<Blob | undefined> {
  if (!isTauriRuntime()) return undefined;
  const res = await invoke<unknown>("sqlite_get_audio_blob", { trackId });
  if (res === null || res === undefined) return undefined;
  return byteArrayToBlob(res, "audio/mpeg");
}

export async function sqlitePutAudioBlob(trackId: string, blob: Blob): Promise<void> {
  if (!isTauriRuntime()) return;
  const bytes = await blobToByteArray(blob);
  await invoke("sqlite_put_audio_blob", {
    trackId,
    mimeType: blob.type || "audio/mpeg",
    bytes,
  });
}

export async function sqliteDeleteAudioBlob(trackId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("sqlite_delete_audio_blob", { trackId });
}

export async function sqliteCountStoredAudio(): Promise<number> {
  if (!isTauriRuntime()) return 0;
  const res = await invoke<unknown>("sqlite_count_stored_audio");
  if (typeof res !== "number") throw new Error("Invalid sqlite_count_stored_audio response.");
  return res;
}

export async function sqliteListAudioTrackIds(): Promise<Set<string>> {
  if (!isTauriRuntime()) return new Set();
  const res = await invoke<unknown>("sqlite_list_audio_track_ids");
  if (!Array.isArray(res)) throw new Error("Invalid sqlite_list_audio_track_ids response.");
  return new Set(res.map(String));
}

export async function sqliteListPlaylists(): Promise<Playlist[]> {
  if (!isTauriRuntime()) return [];
  const res = await invoke<unknown>("sqlite_list_playlists");
  if (!Array.isArray(res)) throw new Error("Invalid sqlite_list_playlists response.");
  return res as Playlist[];
}

export async function sqliteGetPlaylist(id: string): Promise<Playlist | undefined> {
  if (!isTauriRuntime()) return undefined;
  const res = await invoke<unknown>("sqlite_get_playlist", { id });
  if (res === null || res === undefined) return undefined;
  if (!isObject(res) || typeof res.id !== "string") {
    throw new Error("Invalid sqlite_get_playlist response.");
  }
  return res as unknown as Playlist;
}

export async function sqlitePutPlaylist(playlist: Playlist): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("sqlite_put_playlist", { playlist });
}

export async function sqliteDeletePlaylist(id: string): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("sqlite_delete_playlist", { id });
}

export async function sqliteGetLyrics(trackId: string): Promise<TrackLyrics | undefined> {
  if (!isTauriRuntime()) return undefined;
  const res = await invoke<unknown>("sqlite_get_lyrics", { trackId });
  if (res === null || res === undefined) return undefined;
  if (!isObject(res) || typeof res.trackId !== "string") {
    throw new Error("Invalid sqlite_get_lyrics response.");
  }
  return res as unknown as TrackLyrics;
}

export async function sqlitePutLyrics(lyrics: TrackLyrics): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("sqlite_put_lyrics", { lyrics });
}

export async function sqliteDeleteLyrics(trackId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("sqlite_delete_lyrics", { trackId });
}

export async function sqliteGetLyricsCacheMeta(
  trackId: string,
): Promise<LyricsCacheMeta | undefined> {
  if (!isTauriRuntime()) return undefined;
  const res = await invoke<unknown>("sqlite_get_lyrics_cache_meta", { trackId });
  if (res === null || res === undefined) return undefined;
  if (!isObject(res) || typeof res.trackId !== "string") {
    throw new Error("Invalid sqlite_get_lyrics_cache_meta response.");
  }
  return res as unknown as LyricsCacheMeta;
}

export async function sqlitePutLyricsCacheMeta(meta: LyricsCacheMeta): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("sqlite_put_lyrics_cache_meta", { meta });
}

export async function sqliteGetPrefJson<T = unknown>(name: string): Promise<T | undefined> {
  if (!isTauriRuntime()) return undefined;
  const res = await invoke<unknown>("sqlite_get_pref_json", { name });
  if (res === null || res === undefined) return undefined;
  return res as T;
}

export async function sqlitePutPrefJson(name: string, payload: unknown): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("sqlite_put_pref_json", { name, payload });
}

export async function sqliteDeletePref(name: string): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("sqlite_delete_pref", { name });
}

export async function sqliteGetPreferences(): Promise<AppPreferences | undefined> {
  return sqliteGetPrefJson<AppPreferences>("app");
}

export async function sqlitePutPreferences(prefs: AppPreferences): Promise<void> {
  await sqlitePutPrefJson("app", prefs);
}

export async function sqliteListPendingCloudDeletions(): Promise<PendingCloudDeletion[]> {
  const res = await sqliteGetPrefJson<PendingCloudDeletion[]>("cloud-deletions");
  return Array.isArray(res) ? res : [];
}

export async function sqlitePutPendingCloudDeletion(item: PendingCloudDeletion): Promise<void> {
  const existing = await sqliteListPendingCloudDeletions();
  const others = existing.filter((entry) => entry.trackId !== item.trackId);
  await sqlitePutPrefJson("cloud-deletions", [...others, item]);
}

export async function sqliteRemovePendingCloudDeletion(trackId: string): Promise<void> {
  const existing = await sqliteListPendingCloudDeletions();
  await sqlitePutPrefJson(
    "cloud-deletions",
    existing.filter((entry) => entry.trackId !== trackId),
  );
}

export async function sqliteListPendingMetadataSync(): Promise<PendingMetadataSync[]> {
  const res = await sqliteGetPrefJson<PendingMetadataSync[]>("pending-metadata-sync");
  return Array.isArray(res) ? res : [];
}

export async function sqlitePutPendingMetadataSync(item: PendingMetadataSync): Promise<void> {
  const existing = await sqliteListPendingMetadataSync();
  const others = existing.filter((entry) => entry.trackId !== item.trackId);
  await sqlitePutPrefJson("pending-metadata-sync", [...others, item]);
}

export async function sqliteRemovePendingMetadataSync(trackId: string): Promise<void> {
  const existing = await sqliteListPendingMetadataSync();
  await sqlitePutPrefJson(
    "pending-metadata-sync",
    existing.filter((entry) => entry.trackId !== trackId),
  );
}

export async function sqliteClearLibrary(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("sqlite_clear_library");
}

export async function sqliteReplaceLibrary(request: {
  tracks: Track[];
  playlists: Playlist[];
  lyrics: TrackLyrics[];
  preferences?: AppPreferences;
}): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("sqlite_replace_library", { request });
}

export async function sqliteClearAllData(): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("sqlite_clear_all_data");
}
