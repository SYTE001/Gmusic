/**
 * Persisted entity types (PRD §9). IndexedDB is the persistence layer;
 * these types describe what is stored there and what flows through services.
 */

export type TrackAvailability =
  | "available"
  | "permission-required"
  | "missing"
  | "unsupported"
  /** Cloud-backed track whose audio cannot be fetched while the device is offline. */
  | "offline";

/**
 * How the audio bytes for a track can be reached:
 * - "handle"      File System Access handle with granted permission ("File access retained")
 * - "stored-copy" audio bytes copied into IndexedDB ("Stored in app")
 * - "session-only" transient File object, valid until reload ("Re-import required after reload")
 * - "cloud"       no usable local copy; the audio is fetched from R2 (requires a network connection)
 */
export type TrackAccessMode = "handle" | "stored-copy" | "session-only" | "cloud";

/**
 * Lifecycle of a track's cloud copy (spec §5).
 * - "local"     no cloud copy exists; the track lives on this device only
 * - "uploading" an upload is in flight (or was issued and is awaiting verification)
 * - "ready"     the cloud object and cloud metadata have both been confirmed
 * - "failed"    an upload, verification, or sync attempt failed; local data is intact
 */
export type CloudStatus = "local" | "uploading" | "ready" | "failed";

/** Object store holding a track's audio. `null` means "no cloud copy". */
export type StorageProvider = "r2" | null;

export type Track = {
  id: string;
  title: string;
  artist: string;
  album: string;
  trackNumber: number | null;
  /** Total tracks on the album if the tag provides it, otherwise null. */
  albumTrackCount: number | null;
  durationMs: number | null;
  fileName: string;
  fileSize: number;
  mimeType: string;
  addedAt: number;
  lastPlayedAt: number | null;
  playCount: number;
  isLiked: boolean;
  availability: TrackAvailability;
  accessMode: TrackAccessMode;
  /** Stable duplicate-detection fingerprint (size + partial hash). */
  fingerprint: string | null;
  /** True when title/artist came from the filename rather than tags. */
  metadataFromFilename: boolean;

  // ---- Cloud fields (all optional: every pre-existing record is a valid cloud-less record) ----

  /** R2 object key for the audio, e.g. `users/{uid}/tracks/{id}/audio.mp3`. */
  objectKey?: string | null;
  /** R2 object key for the artwork, when the cover art was uploaded too. */
  artworkObjectKey?: string | null;
  /** Which object store holds the cloud copy. */
  storageProvider?: StorageProvider;
  /** Lifecycle of the cloud copy. Missing means "local" (backward compatible). */
  cloudStatus?: CloudStatus;
  /** Epoch ms of the last confirmed cloud metadata write. */
  lastSyncedAt?: number | null;
};

export type Playlist = {
  id: string;
  name: string;
  description: string;
  trackIds: string[];
  createdAt: number;
  updatedAt: number;
};

export type LyricWord = {
  text: string;
  startMs: number;
  endMs: number | null;
};

export type LyricLine = {
  timeMs: number | null;
  text: string;
  /** Present only when the source carries per-word timestamps (enhanced LRC or LRCLIB word sync). */
  words?: LyricWord[];
};

/** What a lyrics record is capable of synchronizing. "none" marks a payload
 * with no usable lyric content; such records are never attached or stored. */
export type LyricCapability = "word" | "line" | "plain" | "instrumental" | "none";

export type LyricOrigin = {
  kind: "lrcmux" | "lrclib" | "manual";
  /** Record id, when the lyrics came from the API. */
  recordId: number | string | null;
  fetchedAt: number;
  matchedTitle?: string;
  matchedArtist?: string;
  matchedAlbum?: string;
  capability: LyricCapability;
};

export type TrackLyrics = {
  trackId: string;
  format: "lrc" | "txt";
  lines: LyricLine[];
  /** User offset in ms applied at render time; original data is never rewritten. */
  offsetMs: number;
  updatedAt: number;
  /** Number of source lines that could not be parsed and were skipped. */
  skippedLines: number;
  sourceName: string;
  /** Populated for lyrics discovered via LRCLIB; manual imports keep kind "manual". */
  origin?: LyricOrigin;
  /** Cache schema version of this record; missing means legacy v1 (manual import). */
  schemaVersion?: number;
};

/** Negative/positive cache entry that prevents repeat LRCLIB lookups. */
export type LyricsCacheMeta = {
  trackId: string;
  /** "accepted": lyrics stored. "not-found": API had nothing (retry after TTL). "needs-selection": ambiguous, wait for user. */
  status: "accepted" | "not-found" | "needs-selection";
  checkedAt: number;
  recordId: number | null;
  schemaVersion: number;
};

export type RepeatMode = "off" | "all" | "one";

export type ThemeSetting = "dark" | "light" | "system";
export type ReducedMotionSetting = "system" | "on" | "off";

export type AppPreferences = {
  theme: ThemeSetting;
  volume: number;
  shuffle: boolean;
  repeatMode: RepeatMode;
  reducedMotion: ReducedMotionSetting;
  artworkTint: boolean;
  lyricsStyle: "line" | "word";
  lyricFontSize: "sm" | "md" | "lg";
  lyricAlignment: "left" | "center";
  lyricLineSpacing: number;
  /** Copy audio bytes into IndexedDB for browsers without persistent file handles. */
  storeAudioCopies: boolean;
  /** Look up lyrics on lrclib.net when a track starts and nothing is cached. */
  autoFetchLyrics: boolean;
  lastTrackId?: string;
  lastPositionMs?: number;
  schemaVersion: number;
};

/** Playback context describing where the current queue came from. */
export type PlaybackContext = {
  type: "library" | "playlist" | "liked" | "recent" | "album" | "artist" | "search" | "queue";
  id?: string;
  label: string;
};

export type ImportOutcome = {
  added: number;
  duplicatesSkipped: number;
  unsupported: string[];
  failed: { fileName: string; reason: string }[];
  /** Tracks added without a persisted handle or stored copy — they stop
   * playing after the app reloads. */
  sessionOnlyAdded: number;
  /** The newly created Track records. */
  newTracks?: Track[];
};

export const APP_NAME = "Local Music";
export const APP_VERSION = "1.1.0";
export const DB_NAME = "local-music";
export const DB_SCHEMA_VERSION = 2;
export const BACKUP_SCHEMA_VERSION = 1;
