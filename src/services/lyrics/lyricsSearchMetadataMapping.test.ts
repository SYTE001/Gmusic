import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Track, TrackLyrics } from "../../types";
import { repository } from "../indexeddb/LibraryRepository";
import { __testHooks, type LrcmuxJsonResponse, type LrcmuxCompatResponse } from "./lrcmuxClient";
import { resolveLyricsForTrack } from "./lyricsService";
import { clearNormalizedMetadataCache } from "../metadata/normalization";

type NetworkCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
};

const networkCalls: NetworkCall[] = [];

function sampleJsonResponse(overrides: Partial<LrcmuxJsonResponse["track"]> = {}): LrcmuxJsonResponse {
  return {
    track: {
      title: "Hate Me",
      artist: "Ellie Goulding dan Juice WRLD",
      album: "Brightest Blue",
      duration: 173,
      ...overrides,
    },
    meta: {
      level: "word",
      instrumental: false,
      source: { id: "apple", name: "Apple Music" },
    },
    lines: [
      {
        text: "Hate me, hate me, still tryna replace me",
        start: 1000,
        end: 4000,
        words: [
          { text: "Hate ", start: 1000, end: 1500 },
          { text: "me, ", start: 1500, end: 2000 },
          { text: "hate ", start: 2000, end: 2500 },
          { text: "me", start: 2500, end: 4000 },
        ],
      },
    ],
  };
}

function sampleCompatResponse(): LrcmuxCompatResponse[] {
  return [
    {
      id: 999,
      trackName: "Hate Me",
      artistName: "Ellie Goulding dan Juice WRLD",
      albumName: "Brightest Blue",
      duration: 173,
      instrumental: false,
      plainLyrics: "Hate me, hate me, still tryna replace me",
      syncedLyrics: "[00:01.00] Hate me, hate me, still tryna replace me",
      lyricsfile: null,
    },
  ];
}

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: "track-hate-me",
    title: "Hate Me",
    artist: "Ellie Goulding dan Juice WRLD",
    album: "Brightest Blue",
    trackNumber: 1,
    albumTrackCount: 10,
    durationMs: 173000, // 173 seconds
    fileName: "track.mp3",
    fileSize: 5000000,
    mimeType: "audio/mpeg",
    addedAt: Date.now(),
    lastPlayedAt: null,
    playCount: 0,
    isLiked: false,
    availability: "available",
    accessMode: "stored-copy",
    fingerprint: null,
    metadataFromFilename: false,
    ...overrides,
  };
}

beforeEach(async () => {
  await repository.clearAllData();
  clearNormalizedMetadataCache();
  networkCalls.length = 0;
  __testHooks.setTimers({ queueGapMs: 1, retryDelaysMs: [1, 1], requestTimeoutMs: 1000, rateLimitWaitCapMs: 5 });
});

afterEach(() => {
  __testHooks.setTransport(null);
});

describe("Lyrics Search Metadata Mapping Regression Tests", () => {
  it("Scenario 1: sends title=Hate Me, artist=Ellie Goulding dan Juice WRLD, duration=173, level=word to /get", async () => {
    __testHooks.setTransport(async (url, init) => {
      networkCalls.push({
        url,
        method: init?.method ?? "GET",
        headers: (init?.headers as Record<string, string>) ?? {},
      });
      return new Response(JSON.stringify(sampleJsonResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const track = makeTrack({
      title: "Hate Me",
      artist: "Ellie Goulding dan Juice WRLD",
      durationMs: 173000,
    });

    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");

    expect(networkCalls.length).toBeGreaterThanOrEqual(1);
    const getCall = networkCalls[0];
    const parsedUrl = new URL(getCall.url);

    expect(parsedUrl.pathname).toBe("/get");
    expect(parsedUrl.searchParams.get("title")).toBe("Hate Me");
    expect(parsedUrl.searchParams.get("artist")).toBe("Ellie Goulding dan Juice WRLD");
    expect(parsedUrl.searchParams.get("duration")).toBe("173");
    expect(parsedUrl.searchParams.get("level")).toBe("word");
    expect(parsedUrl.searchParams.get("format")).toBe("json");
  });

  it("Scenario 1b: compatibility search endpoint sends track_name=Hate Me, artist_name=Ellie Goulding dan Juice WRLD", async () => {
    __testHooks.setTransport(async (url, init) => {
      networkCalls.push({
        url,
        method: init?.method ?? "GET",
        headers: (init?.headers as Record<string, string>) ?? {},
      });
      if (url.includes("/get")) {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify(sampleCompatResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const track = makeTrack({
      title: "Hate Me",
      artist: "Ellie Goulding dan Juice WRLD",
      durationMs: 173000,
    });

    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");

    const searchCall = networkCalls.find((c) => c.url.includes("/compat/lrclib/api/search"));
    expect(searchCall).toBeDefined();
    const searchUrl = new URL(searchCall!.url);

    expect(searchUrl.searchParams.get("track_name")).toBe("Hate Me");
    expect(searchUrl.searchParams.get("artist_name")).toBe("Ellie Goulding dan Juice WRLD");
  });

  it("Scenario 2: multiple artists with comma (Ellie Goulding, Juice WRLD)", async () => {
    __testHooks.setTransport(async (url, init) => {
      networkCalls.push({
        url,
        method: init?.method ?? "GET",
        headers: (init?.headers as Record<string, string>) ?? {},
      });
      return new Response(JSON.stringify(sampleJsonResponse({ artist: "Ellie Goulding, Juice WRLD" })), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const track = makeTrack({
      title: "Hate Me",
      artist: "Ellie Goulding, Juice WRLD",
      durationMs: 173000,
    });

    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");

    const getCall = networkCalls[0];
    const parsedUrl = new URL(getCall.url);

    expect(parsedUrl.pathname).toBe("/get");
    expect(parsedUrl.searchParams.get("title")).toBe("Hate Me");
    expect(parsedUrl.searchParams.get("artist")).toBe("Ellie Goulding, Juice WRLD");
    expect(parsedUrl.searchParams.get("duration")).toBe("173");
  });

  it("Scenario 3: handles reversed metadata (title='Ellie Goulding dan Juice WRLD', artist='Hate Me')", async () => {
    __testHooks.setTransport(async (url, init) => {
      networkCalls.push({
        url,
        method: init?.method ?? "GET",
        headers: (init?.headers as Record<string, string>) ?? {},
      });
      return new Response(JSON.stringify(sampleJsonResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const track = makeTrack({
      title: "Ellie Goulding dan Juice WRLD",
      artist: "Hate Me",
      durationMs: 173000,
    });

    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");

    const getCall = networkCalls[0];
    const parsedUrl = new URL(getCall.url);

    expect(parsedUrl.pathname).toBe("/get");
    expect(parsedUrl.searchParams.get("title")).toBe("Hate Me");
    expect(parsedUrl.searchParams.get("artist")).toBe("Ellie Goulding dan Juice WRLD");
    expect(parsedUrl.searchParams.get("duration")).toBe("173");
  });

  it("Scenario 4: tracks with missing artist metadata and meaningful filename", async () => {
    __testHooks.setTransport(async (url, init) => {
      networkCalls.push({
        url,
        method: init?.method ?? "GET",
        headers: (init?.headers as Record<string, string>) ?? {},
      });
      return new Response(JSON.stringify(sampleJsonResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const track = makeTrack({
      title: "",
      artist: "",
      fileName: "Hate Me - Ellie Goulding dan Juice WRLD.mp3",
      durationMs: 173000,
    });

    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");

    const getCall = networkCalls[0];
    const parsedUrl = new URL(getCall.url);

    expect(parsedUrl.pathname).toBe("/get");
    expect(parsedUrl.searchParams.get("title")).toBe("Hate Me");
    expect(parsedUrl.searchParams.get("artist")).toBe("Ellie Goulding dan Juice WRLD");
    expect(parsedUrl.searchParams.get("duration")).toBe("173");
  });

  it("Scenario 5: tracks with custom metadata overrides (user set title in Settings)", async () => {
    __testHooks.setTransport(async (url, init) => {
      networkCalls.push({
        url,
        method: init?.method ?? "GET",
        headers: (init?.headers as Record<string, string>) ?? {},
      });
      return new Response(JSON.stringify(sampleJsonResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    // Track had no artist tag, but user edited title in Settings to "Hate Me"
    const track = makeTrack({
      title: "Hate Me",
      artist: "",
      fileName: "Hate Me - Ellie Goulding dan Juice WRLD.mp3",
      durationMs: 173000,
    });

    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");

    const getCall = networkCalls[0];
    const parsedUrl = new URL(getCall.url);

    expect(parsedUrl.pathname).toBe("/get");
    expect(parsedUrl.searchParams.get("title")).toBe("Hate Me");
    expect(parsedUrl.searchParams.get("artist")).toBe("Ellie Goulding dan Juice WRLD");
    expect(parsedUrl.searchParams.get("duration")).toBe("173");
  });

  it("Scenario 6: titles containing artist names (e.g. 'Hate Me - Ellie Goulding dan Juice WRLD')", async () => {
    __testHooks.setTransport(async (url, init) => {
      networkCalls.push({
        url,
        method: init?.method ?? "GET",
        headers: (init?.headers as Record<string, string>) ?? {},
      });
      return new Response(JSON.stringify(sampleJsonResponse()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const track = makeTrack({
      title: "Hate Me - Ellie Goulding dan Juice WRLD",
      artist: "",
      fileName: "track-123.mp3",
      durationMs: 173000,
    });

    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("attached");

    const getCall = networkCalls[0];
    const parsedUrl = new URL(getCall.url);

    expect(parsedUrl.pathname).toBe("/get");
    expect(parsedUrl.searchParams.get("title")).toBe("Hate Me");
    expect(parsedUrl.searchParams.get("artist")).toBe("Ellie Goulding dan Juice WRLD");
    expect(parsedUrl.searchParams.get("duration")).toBe("173");
  });

  it("Scenario 7: preserves existing word-synchronized lyrics without network calls", async () => {
    const track = makeTrack();

    const existingWordSyncLyrics: TrackLyrics = {
      trackId: track.id,
      format: "lrc",
      offsetMs: 0,
      lines: [
        {
          timeMs: 1000,
          text: "Hate me, hate me",
          words: [
            { text: "Hate ", startMs: 1000, endMs: 1500 },
            { text: "me", startMs: 1500, endMs: 2000 },
          ],
        },
      ],
      updatedAt: 1,
      skippedLines: 0,
      sourceName: "lrcmux",
      origin: { kind: "lrcmux", recordId: 101, fetchedAt: 1, capability: "word" },
    };
    await repository.putLyrics(existingWordSyncLyrics);

    let networkHit = false;
    __testHooks.setTransport(async () => {
      networkHit = true;
      return new Response("{}", { status: 200 });
    });

    const result = await resolveLyricsForTrack(track);
    expect(result.outcome).toBe("cached");
    expect(networkHit).toBe(false);
  });

  it("Scenario 8: does not overwrite existing line-synchronized lyrics with plain text", async () => {
    const track = makeTrack();

    const existingLineLyrics: TrackLyrics = {
      trackId: track.id,
      format: "lrc",
      offsetMs: 0,
      lines: [{ timeMs: 1000, text: "Line synchronized line" }],
      updatedAt: 1,
      skippedLines: 0,
      sourceName: "lrcmux",
      origin: { kind: "lrcmux", recordId: 102, fetchedAt: 1, capability: "line" },
    };
    await repository.putLyrics(existingLineLyrics);

    // Network returns only plain text
    __testHooks.setTransport(async () => {
      return new Response(
        JSON.stringify({
          track: {
            title: "Hate Me",
            artist: "Ellie Goulding dan Juice WRLD",
            album: "Album",
            duration: 173,
          },
          meta: {
            level: "none",
            instrumental: false,
          },
          lines: [{ text: "Plain text lyric line" }],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });

    // Forced search
    const result = await resolveLyricsForTrack(track, { force: true });
    expect(result.outcome).toBe("cached");
    // Quality floor prevents downgrading line sync to plain: keeps existing cached lyrics
    const stored = await repository.getLyrics(track.id);
    expect(stored?.lines[0].timeMs).toBe(1000);
    expect(stored?.lines[0].text).toBe("Line synchronized line");
  });
});
