import { DB_NAME, DB_SCHEMA_VERSION } from "../../types";

/**
 * IndexedDB connection with versioned migrations. Store layout:
 * - tracks:     Track records (no blobs — keeps library queries light)   [v1]
 * - artwork:    trackId -> Blob (embedded cover art)                     [v1]
 * - audio:      trackId -> Blob (optional stored copy)                   [v1]
 * - handles:    trackId -> FileSystemFileHandle                          [v1]
 * - playlists:  Playlist records                                         [v1]
 * - lyrics:     trackId -> TrackLyrics (incl. LRCLIB cache fields)       [v1]
 * - lyricsMeta: trackId -> LyricsCacheMeta (lookup bookkeeping)          [v2]
 * - prefs:      rows "app" / "playback"                                  [v1]
 */

export const STORES = {
  tracks: "tracks",
  artwork: "artwork",
  audio: "audio",
  handles: "handles",
  playlists: "playlists",
  lyrics: "lyrics",
  lyricsMeta: "lyricsMeta",
  prefs: "prefs",
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

export type DBFailureKind = "unavailable" | "quota" | "corrupt" | "unknown";

export class DBError extends Error {
  readonly kind: DBFailureKind;
  constructor(kind: DBFailureKind, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "DBError";
    this.kind = kind;
  }
}

export function toDBError(error: unknown, context: string): DBError {
  const name = error instanceof Error ? error.name : String(error);
  const message = error instanceof Error ? error.message : String(error);
  if (name === "QuotaExceededError") {
    return new DBError("quota", `Storage quota exceeded while ${context}.`, error);
  }
  if (name === "NotFoundError" || name === "DataError" || name === "InvalidStateError") {
    return new DBError("corrupt", `Local database problem while ${context}: ${message}`, error);
  }
  if (name === "InvalidAccessError" || name === "VersionError") {
    return new DBError("corrupt", `Local database could not be opened (${name}) while ${context}.`, error);
  }
  return new DBError("unknown", `Unexpected storage error while ${context}: ${message}`, error);
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(indexedDBFactory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDBFactory.open(DB_NAME, DB_SCHEMA_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const from = (event as IDBVersionChangeEvent).oldVersion ?? 0;
      // Schema v1 is the initial layout; v2 adds the lyrics lookup cache.
      if (from < 1) {
        const tracks = db.createObjectStore(STORES.tracks, { keyPath: "id" });
        tracks.createIndex("addedAt", "addedAt");
        db.createObjectStore(STORES.artwork, { keyPath: "trackId" });
        db.createObjectStore(STORES.audio, { keyPath: "trackId" });
        db.createObjectStore(STORES.handles, { keyPath: "trackId" });
        db.createObjectStore(STORES.playlists, { keyPath: "id" });
        db.createObjectStore(STORES.lyrics, { keyPath: "trackId" });
        db.createObjectStore(STORES.prefs, { keyPath: "name" });
      }
      if (from < 2) {
        db.createObjectStore(STORES.lyricsMeta, { keyPath: "trackId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(toDBError(request.error, "opening the database"));
    request.onblocked = () =>
      reject(new DBError("unavailable", "The database is open in another tab and cannot be upgraded. Close other tabs of this app and reload."));
  });
}

/** Lazily opens (and caches) the singleton connection. */
export async function getDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    if (typeof indexedDB === "undefined") {
      dbPromise = Promise.reject(
        new DBError("unavailable", "This browser does not support IndexedDB. Your library cannot be saved on this device."),
      );
    } else {
      dbPromise = openDatabase(indexedDB).catch((error) => {
        dbPromise = null; // allow retry after a failure
        throw error;
      });
    }
  }
  return dbPromise;
}

/** Test hook: closes and drops the cached connection so a fresh open applies
 * (open connections otherwise block indexedDB.deleteDatabase). */
export function resetDBConnection(): void {
  if (dbPromise) {
    void dbPromise
      .then((db) => db.close())
      .catch(() => undefined);
    dbPromise = null;
  }
}

export async function withTransaction<T>(
  storeNames: StoreName[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const db = await getDB();
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(storeNames, mode);
    } catch (error) {
      reject(toDBError(error, "starting a database transaction"));
      return;
    }
    let result: T;
    let settled = false;
    tx.onabort = () => {
      if (!settled) reject(toDBError(tx.error, "writing to the database"));
    };
    tx.onerror = () => {
      if (!settled) reject(toDBError(tx.error, "writing to the database"));
    };
    void Promise.resolve(work(tx)).then(
      (value) => {
        result = value;
        // Readonly work resolves once its requests succeed; readwrite waits
        // for oncomplete so callers see durable writes.
        if (mode === "readonly") {
          settled = true;
          resolve(result);
        }
      },
      (error) => {
        settled = true;
        try {
          tx.abort();
        } catch {
          /* already aborted */
        }
        reject(error);
      },
    );
    tx.oncomplete = () => {
      if (mode !== "readonly") {
        settled = true;
        resolve(result);
      }
    };
  });
}

export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(toDBError(request.error, "reading from the database"));
  });
}
