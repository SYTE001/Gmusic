import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __testHooks,
  describeLyricsDbError,
  LyricsDbError,
  lyricsDbGet,
  lyricsDbSearch,
  lyricsDbSearchTracks,
  lyricsDbFetchLyrics,
  parseLyricsDbJsonPayload,
} from "./lyricsdbClient";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe("lyricsdbClient", () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];

  function installTransport(handler: (url: string, init?: RequestInit) => Promise<Response>) {
    calls.length = 0;
    __testHooks.setTransport((url, init) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return handler(url, init);
    });
  }

  beforeEach(() => {
    __testHooks.setTimers({ queueGapMs: 1, retryDelaysMs: [1, 1], requestTimeoutMs: 500, rateLimitWaitCapMs: 5 });
    __testHooks.setBaseUrl("https://mock-lyricsdb.test/api");
  });

  afterEach(() => {
    __testHooks.setTransport(null);
    __testHooks.setBaseUrl(null);
  });

  it("parses word-synchronized compact JSON format correctly", () => {
    const compactPayload = [
      [
        [1, 0, 458, "Is "],
        [1, 458, 348, "this "],
        [1, 806, 418, "the "],
        [1, 1224, 833, "real "],
        [1, 2057, 849, "life? "],
        "Optional Translation",
        "Optional Romaji",
      ],
      [
        [1, 3725, 415, "Is "],
        [1, 4140, 386, "this "],
        [1, 4526, 365, "just "],
        [1, 4891, 383, "fan"],
        [1, 5274, 253, "ta"],
        [1, 5527, 846, "sy? "],
      ],
    ];

    const parsed = parseLyricsDbJsonPayload(compactPayload);
    expect(parsed.hasWordSync).toBe(true);
    expect(parsed.syncLevel).toBe("word");
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.lines[0].timeMs).toBe(0);
    expect(parsed.lines[0].text).toBe("Is this the real life? ");
    expect(parsed.lines[0].words).toHaveLength(5);
    expect(parsed.lines[0].words![0]).toEqual({ text: "Is ", startMs: 0, endMs: 458 });
    expect(parsed.lines[0].words![4]).toEqual({ text: "life? ", startMs: 2057, endMs: 2906 });
    expect(parsed.syncedLyrics).toContain("[00:00.00] Is this the real life? ");
    expect(parsed.plainLyrics).toContain("Is this the real life? ");
  });

  it("parses plain text JSON fallback ({ plain: string })", () => {
    const plainPayload = {
      plain: "Never gonna give you up\nNever gonna let you down",
    };

    const parsed = parseLyricsDbJsonPayload(plainPayload);
    expect(parsed.hasWordSync).toBe(false);
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.lines[0].timeMs).toBeNull();
    expect(parsed.lines[0].text).toBe("Never gonna give you up");
    expect(parsed.plainLyrics).toBe("Never gonna give you up\nNever gonna let you down");
    expect(parsed.syncedLyrics).toBeNull();
  });

  it("handles empty or malformed payload gracefully", () => {
    expect(parseLyricsDbJsonPayload(null).lines).toHaveLength(0);
    expect(parseLyricsDbJsonPayload({}).lines).toHaveLength(0);
    expect(parseLyricsDbJsonPayload([]).lines).toHaveLength(0);
  });

  it("searches tracks by query via /tracks/search", async () => {
    installTransport(async () =>
      jsonResponse([
        {
          id: "uuid-123",
          title: "Bohemian Rhapsody",
          artists: ["Queen"],
          album: "A Night At The Opera",
          durationMs: 354000,
          lyricsType: "word",
          hasLyrics: true,
        },
      ])
    );

    const tracks = await lyricsDbSearchTracks("Bohemian Rhapsody");
    expect(tracks).toHaveLength(1);
    expect(tracks[0].title).toBe("Bohemian Rhapsody");
    expect(tracks[0].artists).toEqual(["Queen"]);
    expect(calls[0].url).toContain("/tracks/search?q=Bohemian+Rhapsody");
  });

  it("fetches lyrics for a track ID via /tracks/:id/lyrics", async () => {
    installTransport(async () =>
      jsonResponse([[[1, 0, 500, "Hello"]]])
    );

    const payload = await lyricsDbFetchLyrics("uuid-123");
    expect(Array.isArray(payload)).toBe(true);
    expect(calls[0].url).toContain("/tracks/uuid-123/lyrics?format=json");
  });

  it("executes exact lookup via lyricsDbGet", async () => {
    installTransport(async (url) => {
      if (url.includes("/tracks/search")) {
        return jsonResponse([
          {
            id: "uuid-queen",
            title: "Bohemian Rhapsody",
            artists: ["Queen"],
            album: "A Night At The Opera",
            durationMs: 354000,
            lyricsType: "word",
            hasLyrics: true,
          },
        ]);
      }
      if (url.includes("/tracks/uuid-queen/lyrics")) {
        return jsonResponse([[[1, 0, 500, "Mama..."]]]);
      }
      return jsonResponse(null, 404);
    });

    const record = await lyricsDbGet({
      trackName: "Bohemian Rhapsody",
      artistName: "Queen",
      duration: 354,
    });

    expect(record).not.toBeNull();
    expect(record?.id).toBe("uuid-queen");
    expect(record?.trackName).toBe("Bohemian Rhapsody");
    expect(record?.artistName).toBe("Queen");
    expect(record?.duration).toBe(354);
    expect(record?.provider).toBe("lyricsdb");
  });

  it("executes search via lyricsDbSearch and returns normalized records", async () => {
    installTransport(async (url) => {
      if (url.includes("/tracks/search")) {
        return jsonResponse([
          {
            id: "uuid-1",
            title: "Song 1",
            artists: ["Artist A"],
            durationMs: 180000,
            hasLyrics: true,
          },
        ]);
      }
      if (url.includes("/tracks/uuid-1/lyrics")) {
        return jsonResponse([[[1, 1000, 500, "Line 1"]]]);
      }
      return jsonResponse(null, 404);
    });

    const records = await lyricsDbSearch({ trackName: "Song 1", artistName: "Artist A" });
    expect(records).toHaveLength(1);
    expect(records[0].trackName).toBe("Song 1");
    expect(records[0].provider).toBe("lyricsdb");
  });

  it("respects Retry-After on 429", async () => {
    let attempts = 0;
    installTransport(async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("Too many requests", {
          status: 429,
          headers: { "Retry-After": "0.001" },
        });
      }
      return jsonResponse([]);
    });

    const tracks = await lyricsDbSearchTracks("test");
    expect(attempts).toBe(2);
    expect(tracks).toEqual([]);
  });

  it("describes errors with user-friendly messages", () => {
    expect(describeLyricsDbError(new LyricsDbError("offline", "offline"))).toContain("offline");
    expect(describeLyricsDbError(new LyricsDbError("rate-limited", "busy"))).toContain("busy");
    expect(describeLyricsDbError(new LyricsDbError("timeout", "timeout"))).toContain("too long");
    expect(describeLyricsDbError(new Error("unknown"))).toContain("Could not reach");
  });
});
