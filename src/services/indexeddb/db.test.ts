import { beforeEach, describe, expect, it } from "vitest";
import { indexedDB } from "fake-indexeddb";
import { getDB, resetDBConnection, STORES } from "./db";
import type { Track } from "../../types";
import { repository } from "./LibraryRepository";

/** Simulates a schema-v1 database created by the previous app version. */
async function createLegacyV1Database(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open("local-music", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      const tracks = db.createObjectStore(STORES.tracks, { keyPath: "id" });
      tracks.createIndex("addedAt", "addedAt");
      db.createObjectStore(STORES.artwork, { keyPath: "trackId" });
      db.createObjectStore(STORES.audio, { keyPath: "trackId" });
      db.createObjectStore(STORES.handles, { keyPath: "trackId" });
      db.createObjectStore(STORES.playlists, { keyPath: "id" });
      db.createObjectStore(STORES.lyrics, { keyPath: "trackId" });
      db.createObjectStore(STORES.prefs, { keyPath: "name" });
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

describe("IndexedDB schema migration v1 → v2", () => {
  beforeEach(async () => {
    resetDBConnection();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase("local-music");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => resolve();
    });
  });

  it("upgrades a v1 database in place, adding lyricsMeta without data loss", async () => {
    await createLegacyV1Database();

    // Seed a legacy lyrics record before the app's connection upgrades it.
    const seed = new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("local-music", 1);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(STORES.lyrics, "readwrite");
        tx.objectStore(STORES.lyrics).put({
          trackId: "legacy",
          format: "txt",
          lines: [{ timeMs: null, text: "old lyrics" }],
          offsetMs: 300,
          updatedAt: 5,
          skippedLines: 0,
          sourceName: "old.txt",
          // No schemaVersion: legacy shape.
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });
    await seed;

    const db = await getDB();
    expect(db.version).toBe(2);
    expect(db.objectStoreNames.contains(STORES.lyricsMeta)).toBe(true);

    // Legacy lyrics survive; the new store works.
    const legacy = await repository.getLyrics("legacy");
    expect(legacy?.lines[0].text).toBe("old lyrics");
    expect(legacy?.schemaVersion).toBeUndefined(); // untouched legacy record

    await repository.putLyricsCacheMeta({ trackId: "legacy", status: "accepted", checkedAt: 1, recordId: 9, schemaVersion: 2 });
    expect((await repository.getLyricsCacheMeta("legacy"))?.recordId).toBe(9);
  });

  it("creates a fresh v2 database for new installs", async () => {
    const db = await getDB();
    expect(db.version).toBe(2);
    expect(db.objectStoreNames.contains(STORES.lyricsMeta)).toBe(true);
  });
});

describe("connection and write safety", () => {
  beforeEach(async () => {
    resetDBConnection();
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase("local-music");
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  });

  it("releases its connection when another tab upgrades the schema, then reopens", async () => {
    const first = await getDB();
    let blocked = false;
    // A newer app version in another tab asks for a higher schema version.
    const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("local-music", first.version + 1);
      request.onblocked = () => {
        blocked = true;
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(blocked).toBe(false); // our connection closed on versionchange, so nothing was blocked
    upgraded.close();
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase("local-music");
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
    });
    // The cached connection was dropped, so the next call opens a fresh one.
    const second = await getDB();
    expect(second).not.toBe(first);
  });

  it("writes a track together with its files, or nothing at all", async () => {
    const track = { id: "atomic", title: "T", fileName: "t.mp3" } as unknown as Track;
    await repository.putTrackWithFiles(track, { artwork: new Blob(["art"]), audio: new Blob(["audio"]) });
    expect((await repository.getTrack("atomic"))?.title).toBe("T");
    expect(await repository.getArtwork("atomic")).toBeDefined();
    expect(await repository.getAudioBlob("atomic")).toBeDefined();

    // A track that cannot be stored must not leave its artwork or audio behind.
    const unstorable = { id: "orphan", title: "X", fileName: "x.mp3", boom: () => 1 } as unknown as Track;
    await expect(
      repository.putTrackWithFiles(unstorable, { artwork: new Blob(["art"]), audio: new Blob(["audio"]) }),
    ).rejects.toBeTruthy();
    expect(await repository.getTrack("orphan")).toBeUndefined();
    expect(await repository.getArtwork("orphan")).toBeUndefined();
    expect(await repository.getAudioBlob("orphan")).toBeUndefined();
  });
});
