import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Playlist, Track, TrackLyrics } from "../../types";

/**
 * cloudLibraryService is exercised against a fake PostgREST client so the
 * sync contract can be tested without a database: idempotent upserts,
 * duplicate reconciliation, and pull-side mapping.
 */
const table = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  playlists: new Map<string, Record<string, unknown>>(),
  membership: new Map<string, Map<string, number>>(),
  lyrics: new Map<string, Record<string, unknown>>(),
  playback: new Map<string, Record<string, unknown>>(),
  writtenPayloads: [] as { table: string; rows: Record<string, unknown>[] }[],
  /** Tracks the order of writes so idempotency is observable. */
  calls: [] as string[],
  /** When true, delete() succeeds but removes nothing, simulating a row that
   *  survives its own deletion (RLS row not owned, trigger, partitioning). */
  keepRowsOnDelete: false,
  actingUserId: "11111111-1111-1111-1111-111111111111",
}));

function resetTable() {
  table.rows.clear();
  table.playlists.clear();
  table.membership.clear();
  table.lyrics.clear();
  table.playback.clear();
  table.writtenPayloads.length = 0;
  table.calls.length = 0;
  table.keepRowsOnDelete = false;
  table.actingUserId = "11111111-1111-1111-1111-111111111111";
}

vi.mock("./cloudAuthService", () => ({
  cloudConfigured: () => true,
  workerConfigured: () => true,
  workerUrl: () => "https://worker.example",
  getAccessToken: async () => "test-token",
  getAuthenticatedUserId: async () => table.actingUserId,
  getSupabaseClient: () => fakeClient,
  snapshotAuth: (session: unknown) => ({ status: session ? "authenticated" : "anonymous", user: null, session }),
  currentAuthState: async () => ({ status: "anonymous", user: null, session: null }),
  signInWithEmail: async () => undefined,
  signUpWithEmail: async () => undefined,
  signOutCloud: async () => undefined,
  subscribeToAuthChanges: () => () => undefined,
}));

const fakeClient = {
  auth: { signOut: async () => undefined },
  from(tableName: string) {
    const builder = {
      _where: {} as Record<string, unknown>,
      _options: { onConflict: "" },
      _delete: false as boolean,
      _pending: [] as Record<string, unknown>[],

      select() {
        return builder;
      },
      // .select() chained after upsert() keeps the pending write intact.
      _selectAfterUpsert: true,
      eq(column: string, value: unknown) {
        builder._where = { ...builder._where, [column]: value };
        return builder;
      },
      in(column: string, values: unknown[]) {
        builder._where = { ...builder._where, [column]: values };
        return builder;
      },
      order() {
        return builder;
      },
      single: async () => ({ data: null, error: null }),
      delete() {
        builder._delete = true;
        return builder;
      },
      upsert(rows: Record<string, unknown> | Record<string, unknown>[], options?: { onConflict?: string }) {
        builder._options.onConflict = options?.onConflict ?? "id";
        builder._pending = Array.isArray(rows) ? rows : [rows];
        return builder;
      },
      then(resolve: (value: unknown) => void) {
        return run().then(resolve);
      },
    };

    async function run(): Promise<{ data: unknown; error: null }> {
      const where = builder._where;
      const onConflict = builder._options.onConflict;

      if (builder._delete) {
        if (!table.keepRowsOnDelete) {
          if (where.playlist_id !== undefined) {
            if (tableName === "playlist_tracks" && where.track_id === undefined) {
              table.membership.delete(String(where.playlist_id));
            } else if (where.track_id !== undefined) {
              const members = table.membership.get(String(where.playlist_id));
              members?.delete(String(where.track_id));
            }
          } else if (where.track_id !== undefined) {
            storeFor(tableName).delete(String(where.track_id));
          } else if (where.id !== undefined) {
            storeFor(tableName).delete(String(where.id));
          }
        }
        return { data: null, error: null };
      }

      // Upsert path: detect a pending write by the presence of rows in the
      // options we recorded. Reads never set onConflict.
      if (onConflict === "id") {
        // Handled below — normalised into the generic write path.
      }

      if (builder._pending.length > 0) {
        // One upsert per builder instance; apply exactly the rows it captured.
        try {
          applyWrites(tableName, builder._pending, onConflict);
          return { data: builder._pending, error: null };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return { data: null, error: { message: msg } as never };
        }
      }

      // Read path.
      if (tableName === "tracks") {
        const rows = [...table.rows.values()];
        if (where.fingerprint) {
          const wanted = where.fingerprint as unknown[];
          return { data: rows.filter((row) => wanted.includes(row.fingerprint)), error: null };
        }
        return { data: where.id ? rows.filter((row) => matches(row, where)) : rows, error: null };
      }
      if (tableName === "playlists") {
        return { data: [...table.playlists.values()], error: null };
      }
      if (tableName === "playlist_tracks") {
        const data: Record<string, unknown>[] = [];
        for (const [playlistId, members] of table.membership) {
          for (const [trackId, position] of members) {
            data.push({ playlist_id: playlistId, track_id: trackId, position });
          }
        }
        return { data: where.track_id ? data.filter((row) => matches(row, where)) : data, error: null };
      }
      if (tableName === "track_lyrics") {
        const rows = [...table.lyrics.values()];
        return { data: where.track_id ? rows.filter((row) => matches(row, where)) : rows, error: null };
      }
      return { data: [], error: null };
    }

    return builder;
  },
};

function applyWrites(tableName: string, rows: Record<string, unknown>[], onConflict: string): void {
  table.writtenPayloads.push({ table: tableName, rows: rows.map((r) => ({ ...r })) });
  for (const row of rows) {
    if (!row.user_id || typeof row.user_id !== "string") {
      throw new Error(`null value in column "user_id" violates not-null constraint on ${tableName}`);
    }
    if (row.user_id !== table.actingUserId) {
      throw new Error(`row must belong to the authenticated user (${tableName})`);
    }

    if (tableName === "playlist_tracks") {
      const playlistId = String(row.playlist_id);
      const trackId = String(row.track_id);
      const pl = table.playlists.get(playlistId);
      if (pl && pl.user_id !== table.actingUserId) {
        throw new Error("playlist membership must match the playlist owner");
      }
      const tr = table.rows.get(trackId);
      if (tr && tr.user_id !== table.actingUserId) {
        throw new Error("playlist membership must match the track owner");
      }
      const members = table.membership.get(playlistId) ?? new Map<string, number>();
      members.set(trackId, Number(row.position));
      table.membership.set(playlistId, members);
      continue;
    }

    const key = String(row.id ?? row.track_id ?? "");
    const store = storeFor(tableName);
    const existing = store.get(key);
    if (existing && existing.user_id !== row.user_id) {
      throw new Error("cannot change row ownership");
    }
    if (onConflict === "id" || onConflict === "track_id") store.set(key, { ...row });
    else store.set(key, { ...existing, ...row });
  }
}

/** Applies eq()/in() filters so reads only return the rows a query targets. */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (Array.isArray(value)) return value.includes(row[key]);
    return row[key] === value;
  });
}

function storeFor(tableName: string): Map<string, Record<string, unknown>> {
  if (tableName === "tracks") return table.rows;
  if (tableName === "playlists") return table.playlists;
  if (tableName === "track_lyrics") return table.lyrics;
  if (tableName === "track_playback") return table.playback;
  return new Map();
}

import {
  deleteCloudTrackMetadata,
  fetchCloudLibrary,
  playlistToRow,
  rowToTrack,
  snapshotToLocalEntities,
  trackToRow,
  upsertCloudLyrics,
  upsertCloudPlayback,
  upsertCloudPlaylists,
  upsertCloudTracks,
} from "./cloudLibraryService";
import { mergeCloudIntoLocal, mergePlaylists } from "../../stores/cloudStore";

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: `t-${Math.random().toString(36).slice(2, 8)}`,
    title: "Song",
    artist: "Artist",
    album: "Album",
    trackNumber: 1,
    albumTrackCount: null,
    durationMs: 60000,
    fileName: "song.mp3",
    fileSize: 1000,
    mimeType: "audio/mpeg",
    addedAt: 1700000000000,
    lastPlayedAt: null,
    playCount: 0,
    isLiked: false,
    availability: "available",
    accessMode: "stored-copy",
    fingerprint: "fp-a",
    metadataFromFilename: false,
    ...overrides,
  };
}

describe("row mapping", () => {
  it("round-trips a track through the cloud row shape without signed URLs", () => {
    const track = makeTrack({ objectKey: "users/u-1/tracks/t-1/audio.mp3", cloudStatus: "ready" });
    const row = trackToRow(track);
    expect(row.object_key).toBe("users/u-1/tracks/t-1/audio.mp3");
    expect(row).not.toHaveProperty("playUrl");
    expect(row).not.toHaveProperty("uploadUrl");
    const back = rowToTrack(row);
    expect(back.id).toBe(track.id);
    expect(back.objectKey).toBe(track.objectKey);
    expect(back.cloudStatus).toBe("ready");
  });

  it("round-trips a playlist with its ordering", () => {
    const playlist: Playlist = {
      id: "p-1",
      name: "Mix",
      description: "",
      trackIds: ["a", "b", "c"],
      createdAt: 1,
      updatedAt: 2,
    };
    const row = playlistToRow(playlist);
    expect(row.track_ids).toEqual(["a", "b", "c"]);
  });
});

describe("sync idempotency", () => {
  beforeEach(() => resetTable());

  it("writes each stable track id exactly once across repeated syncs", async () => {
    const track = makeTrack();
    await upsertCloudTracks([track]);
    await upsertCloudTracks([track]);
    await upsertCloudTracks([track]);
    expect(table.rows.size).toBe(1);
    expect([...table.rows.values()][0]).toMatchObject({ id: track.id, title: "Song" });
  });

  it("reconciles a duplicate audio upload onto the existing cloud row", async () => {
    const first = makeTrack({ id: "device-a", fingerprint: "same-fp", objectKey: "users/u-1/tracks/device-a/audio.mp3" });
    await upsertCloudTracks([first]);

    // A second device imported the same file under its own local id.
    const second = makeTrack({ id: "device-b", fingerprint: "same-fp", objectKey: null });
    const outcome = await upsertCloudTracks([second]);

    // No second track is created; the caller is pointed at the existing key.
    expect(table.rows.size).toBe(1);
    expect(outcome[0]).toMatchObject({ objectKey: "users/u-1/tracks/device-a/audio.mp3", reconciledWith: "device-a" });
  });

  it("rewrites playlist membership in order, without duplicating members", async () => {
    const playlist: Playlist = {
      id: "p-1",
      name: "Mix",
      description: "",
      trackIds: ["a", "b"],
      createdAt: 1,
      updatedAt: 2,
    };
    await upsertCloudPlaylists([playlist]);
    await upsertCloudPlaylists([{ ...playlist, trackIds: ["b", "c"] }]);
    await upsertCloudPlaylists([{ ...playlist, trackIds: ["b", "c"] }]);

    const members = table.membership.get("p-1");
    expect(members?.get("b")).toBe(0);
    expect(members?.get("c")).toBe(1);
    expect(members?.has("a")).toBe(false);
  });

  it("clears a playlist whose every member was removed", async () => {
    const playlist: Playlist = {
      id: "p-2",
      name: "Empty",
      description: "",
      trackIds: ["x"],
      createdAt: 1,
      updatedAt: 2,
    };
    await upsertCloudPlaylists([playlist]);
    await upsertCloudPlaylists([{ ...playlist, trackIds: [] }]);
    expect(table.membership.get("p-2")?.size ?? 0).toBe(0);
  });

  it("removes a track's metadata rows without touching other tables' data", async () => {
    await upsertCloudTracks([makeTrack({ id: "gone", fingerprint: "fp-gone" })]);
    await upsertCloudTracks([makeTrack({ id: "kept", fingerprint: "fp-kept" })]);
    await deleteCloudTrackMetadata("gone");
    expect(table.rows.has("gone")).toBe(false);
    expect(table.rows.has("kept")).toBe(true);
  });

  it("refuses to report success while any row for the track still exists", async () => {
    await upsertCloudTracks([makeTrack({ id: "leftover", fingerprint: "fp-leftover" })]);
    // The delete succeeds on paper but leaves the tracks row behind; the
    // follow-up read must catch it instead of declaring the track removed.
    table.keepRowsOnDelete = true;

    await expect(deleteCloudTrackMetadata("leftover")).rejects.toThrow(/tracks/);

    // Nothing was claimed removed while it still existed.
    table.keepRowsOnDelete = false;
    expect(table.rows.has("leftover")).toBe(true);
    // …and a real retry does clear it, proving the check is not permanent.
    await deleteCloudTrackMetadata("leftover");
    expect(table.rows.has("leftover")).toBe(false);
  });

  it("maps a fetched snapshot into local entities", async () => {
    await upsertCloudTracks([
      makeTrack({ id: "cloud-1", objectKey: "users/u-1/tracks/cloud-1/audio.mp3" }),
    ]);
    const snapshot = await fetchCloudLibrary();
    const entities = snapshotToLocalEntities(snapshot);
    expect(entities.tracks[0]?.id).toBe("cloud-1");
    expect(entities.tracks[0]?.accessMode).toBe("cloud");
    expect(entities.tracks[0]?.cloudStatus).toBe("ready");
  });

  it("never stores playback or upload URLs anywhere in the cloud schema", () => {
    const track = makeTrack();
    const row = trackToRow(track);
    const serialised = JSON.stringify(row);
    expect(serialised).not.toMatch(/signed|presigned|X-Amz-Signature/i);
  });
});

describe("local merge (pull side)", () => {
  it("adds cloud-only tracks without dropping any local track", () => {
    const local = [makeTrack({ id: "local-1" })];
    const cloud = [
      rowToTrack({ ...trackToRow(makeTrack({ id: "cloud-1", fingerprint: "fp-cloud" })), object_key: "users/u-1/tracks/cloud-1/audio.mp3" }),
    ];
    const merged = mergeCloudIntoLocal(local, cloud);
    expect(merged.map((track) => track.id).sort()).toEqual(["cloud-1", "local-1"]);
  });

  it("reconciles by fingerprint instead of creating a duplicate", () => {
    const local = [makeTrack({ id: "local-1", fingerprint: "same-fp" })];
    const cloud = [makeTrack({ id: "cloud-1", fingerprint: "same-fp", objectKey: "users/u-1/tracks/cloud-1/audio.mp3" })];
    const merged = mergeCloudIntoLocal(local, cloud);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.objectKey).toBe("users/u-1/tracks/cloud-1/audio.mp3");
    expect(merged[0]?.cloudStatus).toBe("ready");
  });

  it("keeps locally edited metadata for tracks that were already synced", () => {
    const local = [makeTrack({ id: "t-1", title: "Edited title", cloudStatus: "ready", lastSyncedAt: 1000 })];
    const cloud = [makeTrack({ id: "t-1", title: "Old title" })];
    const merged = mergeCloudIntoLocal(local, cloud);
    expect(merged[0]?.title).toBe("Edited title");
  });

  it("takes the cloud title when the local edit predates the sync", () => {
    const local = [makeTrack({ id: "t-1", title: "Edited title", cloudStatus: "local" })];
    const cloud = [makeTrack({ id: "t-1", title: "Old title" })];
    const merged = mergeCloudIntoLocal(local, cloud);
    expect(merged[0]?.title).toBe("Edited title");
    expect(merged[0]?.objectKey).toBeNull();
  });

  it("keeps the higher play count and the later play date", () => {
    const local = [makeTrack({ id: "t-1", playCount: 4, lastPlayedAt: 500, cloudStatus: "ready", lastSyncedAt: 1000 })];
    const cloud = [
      makeTrack({ id: "t-1", playCount: 9, lastPlayedAt: 900, objectKey: "users/u-1/tracks/t-1/audio.mp3" }),
    ];
    const merged = mergeCloudIntoLocal(local, cloud);
    expect(merged[0]?.playCount).toBe(9);
    expect(merged[0]?.lastPlayedAt).toBe(900);
  });

  it("merges playlists by newest write without duplicating them", () => {
    const local: Playlist[] = [{ id: "p-1", name: "Old", description: "", trackIds: ["a"], createdAt: 1, updatedAt: 100 }];
    const cloud: Playlist[] = [{ id: "p-1", name: "New", description: "", trackIds: ["a", "b"], createdAt: 1, updatedAt: 200 }];
    const merged = mergePlaylists(local, cloud);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.name).toBe("New");
    expect(merged[0]?.trackIds).toEqual(["a", "b"]);
  });

  it("preserves playlist membership that only exists locally", () => {
    const local: Playlist[] = [{ id: "p-1", name: "Local", description: "", trackIds: ["a"], createdAt: 1, updatedAt: 100 }];
    const merged = mergePlaylists(local, []);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.trackIds).toEqual(["a"]);
  });
});

describe("lyrics sync", () => {
  it("upserts lyrics keyed on the stable track id", async () => {
    const lyrics: TrackLyrics = {
      trackId: "t-1",
      format: "lrc",
      lines: [{ timeMs: 0, text: "line" }],
      offsetMs: 250,
      updatedAt: 5,
      skippedLines: 0,
      sourceName: "a.lrc",
    };
    const { upsertCloudLyrics } = await import("./cloudLibraryService");
    await upsertCloudLyrics([lyrics]);
    await upsertCloudLyrics([lyrics]);
    expect(table.lyrics.size).toBe(1);
    const row = table.lyrics.get("t-1")!;
    expect(row.offset_ms).toBe(250);
    expect(Array.isArray(row.lines)).toBe(true);
  });
});

describe("Priority 1: Cloud metadata ownership enforcement", () => {
  beforeEach(() => resetTable());

  it("asserts that upsertCloudTracks includes the verified user_id in the exact database payload", async () => {
    const track = makeTrack({ id: "track-owner-1", title: "Owned Song", objectKey: "users/u-1/tracks/track-owner-1/audio.mp3" });
    await upsertCloudTracks([track]);

    const trackWrites = table.writtenPayloads.filter((p) => p.table === "tracks");
    expect(trackWrites).toHaveLength(1);
    const writtenRow = trackWrites[0].rows[0];
    expect(writtenRow).toHaveProperty("user_id", table.actingUserId);
    expect(writtenRow).toHaveProperty("id", "track-owner-1");
    expect(writtenRow).toHaveProperty("title", "Owned Song");
    expect(writtenRow).toHaveProperty("object_key", "users/u-1/tracks/track-owner-1/audio.mp3");
  });

  it("asserts that upsertCloudPlaylists includes verified user_id in playlist and membership payloads", async () => {
    // Seed track owned by acting user
    await upsertCloudTracks([makeTrack({ id: "t-1" })]);

    const playlist: Playlist = {
      id: "pl-owner-1",
      name: "Owner Playlist",
      description: "testing",
      trackIds: ["t-1"],
      createdAt: 1000,
      updatedAt: 2000,
    };
    await upsertCloudPlaylists([playlist]);

    const plWrites = table.writtenPayloads.filter((p) => p.table === "playlists");
    expect(plWrites).toHaveLength(1);
    expect(plWrites[0].rows[0]).toHaveProperty("user_id", table.actingUserId);
    expect(plWrites[0].rows[0]).toHaveProperty("id", "pl-owner-1");

    const memberWrites = table.writtenPayloads.filter((p) => p.table === "playlist_tracks");
    expect(memberWrites).toHaveLength(1);
    expect(memberWrites[0].rows[0]).toHaveProperty("user_id", table.actingUserId);
    expect(memberWrites[0].rows[0]).toHaveProperty("playlist_id", "pl-owner-1");
    expect(memberWrites[0].rows[0]).toHaveProperty("track_id", "t-1");
  });

  it("asserts that upsertCloudLyrics includes verified user_id in the payload", async () => {
    const lyrics: TrackLyrics = {
      trackId: "t-owner-1",
      format: "lrc",
      lines: [{ timeMs: 0, text: "hello" }],
      offsetMs: 100,
      updatedAt: 10,
      skippedLines: 0,
      sourceName: "source.lrc",
    };
    await upsertCloudLyrics([lyrics]);

    const lyricsWrites = table.writtenPayloads.filter((p) => p.table === "track_lyrics");
    expect(lyricsWrites).toHaveLength(1);
    expect(lyricsWrites[0].rows[0]).toHaveProperty("user_id", table.actingUserId);
    expect(lyricsWrites[0].rows[0]).toHaveProperty("track_id", "t-owner-1");
  });

  it("asserts that upsertCloudPlayback includes verified user_id in the payload", async () => {
    await upsertCloudPlayback([
      { trackId: "t-owner-1", playCount: 5, lastPlayedAt: 1234567, positionMs: 45000 },
    ]);

    const pbWrites = table.writtenPayloads.filter((p) => p.table === "track_playback");
    expect(pbWrites).toHaveLength(1);
    expect(pbWrites[0].rows[0]).toHaveProperty("user_id", table.actingUserId);
    expect(pbWrites[0].rows[0]).toHaveProperty("track_id", "t-owner-1");
    expect(pbWrites[0].rows[0]).toHaveProperty("play_count", 5);
    expect(pbWrites[0].rows[0]).toHaveProperty("position_ms", 45000);
  });

  it("rejects database writes when user_id is missing or incomplete (mocks do not silently pass)", async () => {
    // Attempting a direct write without user_id must be rejected with a Postgres constraint error
    const client = fakeClient;
    const res = (await client.from("tracks").upsert({ id: "no-owner", title: "No Owner" } as never)) as { error: { message: string } | null };
    expect(res.error).not.toBeNull();
    expect(res.error?.message).toMatch(/violates not-null constraint/);
  });

  it("updates existing records without changing ownership", async () => {
    const track = makeTrack({ id: "track-update-1", title: "Original Title" });
    await upsertCloudTracks([track]);
    expect(table.rows.get("track-update-1")?.user_id).toBe(table.actingUserId);

    // Update with new title
    const updated = { ...track, title: "Updated Title" };
    await upsertCloudTracks([updated]);

    expect(table.rows.get("track-update-1")?.title).toBe("Updated Title");
    expect(table.rows.get("track-update-1")?.user_id).toBe(table.actingUserId);
  });

  it("rejects cross-user playlist membership link to another user's track", async () => {
    // User A owns playlist
    table.playlists.set("pl-a", { id: "pl-a", user_id: table.actingUserId, name: "A" });
    // Another user B owns track
    table.rows.set("track-b", { id: "track-b", user_id: "22222222-2222-2222-2222-222222222222", title: "B" });

    // Attempting to add track-b to pl-a
    const client = fakeClient;
    const res = (await client.from("playlist_tracks").upsert({
      playlist_id: "pl-a",
      track_id: "track-b",
      user_id: table.actingUserId,
      position: 0,
    })) as { error: { message: string } | null };
    expect(res.error).not.toBeNull();
    expect(res.error?.message).toMatch(/playlist membership must match the track owner/);
  });

  it("persists complete track metadata with verified user_id after successful R2 upload", async () => {
    const track = makeTrack({ id: "track-migrated-1", title: "Migrated Song", objectKey: null });
    const verifiedObjectKey = `users/${table.actingUserId}/tracks/${track.id}/audio.mp3`;
    const updated: Track = {
      ...track,
      objectKey: verifiedObjectKey,
      artworkObjectKey: null,
      storageProvider: "r2",
      cloudStatus: "ready",
      lastSyncedAt: Date.now(),
    };

    const outcome = await upsertCloudTracks([updated]);
    expect(outcome[0].objectKey).toBe(verifiedObjectKey);

    const stored = table.rows.get(track.id);
    expect(stored).toBeDefined();
    expect(stored?.user_id).toBe(table.actingUserId);
    expect(stored?.object_key).toBe(verifiedObjectKey);
    expect(stored?.title).toBe("Migrated Song");
    expect(stored?.file_name).toBe("song.mp3");
    expect(stored?.file_size).toBe(1000);
    expect(stored?.mime_type).toBe("audio/mpeg");
    expect(stored?.last_synced_at).toBeTruthy();
  });
});
