import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testHooks,
  describeLrcmuxError,
  LrcmuxError,
  lrcmuxGet,
  lrcmuxSearch,
  type LrcmuxJsonResponse,
} from "./lrcmuxClient";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function sampleJsonResponse(overrides: Partial<LrcmuxJsonResponse> = {}): LrcmuxJsonResponse {
  return {
    track: {
      title: "Song",
      artist: "Artist",
      album: "Album",
      duration: 180,
    },
    meta: {
      level: "word",
      instrumental: false,
      source: { id: "netease", name: "NetEase Cloud Music" },
    },
    lines: [
      {
        text: "Hello world",
        start: 1000,
        end: 3000,
        words: [
          { text: "Hello ", start: 1000, end: 1800 },
          { text: "world", start: 1800, end: 3000 },
        ],
      },
    ],
    ...overrides,
  };
}

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
});

afterEach(() => {
  __testHooks.setTransport(null);
  vi.restoreAllMocks();
});

describe("lrcmuxClient basics", () => {
  it("encodes query parameters correctly for /get with title, artist, album, duration, level=word, format=json", async () => {
    installTransport(async () => jsonResponse(sampleJsonResponse()));
    await lrcmuxGet({ trackName: "Song Title", artistName: "Main Artist", albumName: "Best Album", duration: 180.4 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/get?");
    expect(calls[0].url).toContain("title=Song+Title");
    expect(calls[0].url).toContain("artist=Main+Artist");
    expect(calls[0].url).toContain("album=Best+Album");
    expect(calls[0].url).toContain("duration=180");
    expect(calls[0].url).toContain("level=word");
    expect(calls[0].url).toContain("format=json");
    // Requests must stay CORS-simple: a custom header like X-Client would
    // trigger an OPTIONS preflight the API rejects, failing every lookup.
    expect(Object.keys(calls[0].headers)).toEqual(["Accept"]);
  });

  it("returns null without making network requests if trackName or artistName is missing", async () => {
    installTransport(async () => jsonResponse(sampleJsonResponse()));
    const res1 = await lrcmuxGet({ trackName: "Song", artistName: "" });
    const res2 = await lrcmuxGet({ trackName: "", artistName: "Artist" });
    const res3 = await lrcmuxGet({});
    expect(res1).toBeNull();
    expect(res2).toBeNull();
    expect(res3).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null on 404", async () => {
    installTransport(async () => new Response("not found", { status: 404 }));
    const result = await lrcmuxGet({ trackName: "Nonexistent", artistName: "Nobody" });
    expect(result).toBeNull();
  });

  it("returns null on 400 (bad request / not found on lrcmux)", async () => {
    installTransport(async () => new Response("missing param", { status: 400 }));
    const result = await lrcmuxGet({ trackName: "A", artistName: "B" });
    expect(result).toBeNull();
  });

  it("rejects malformed JSON with a typed LrcmuxError", async () => {
    installTransport(async () => new Response("<html>Gateway error</html>", { status: 200 }));
    await expect(lrcmuxGet({ trackName: "A", artistName: "B" })).rejects.toMatchObject({
      name: "LrcmuxError",
      kind: "malformed",
    });
  });

  it("rejects response with invalid schema missing track or meta", async () => {
    installTransport(async () => jsonResponse({ wrong: true }));
    await expect(lrcmuxGet({ trackName: "A", artistName: "B" })).rejects.toBeInstanceOf(LrcmuxError);
  });

  it("describes error kinds into user-friendly messages", () => {
    expect(describeLrcmuxError(new LrcmuxError("offline", ""))).toContain("offline");
    expect(describeLrcmuxError(new LrcmuxError("rate-limited", ""))).toContain("busy");
    expect(describeLrcmuxError(new LrcmuxError("timeout", ""))).toContain("too long");
    expect(describeLrcmuxError(new Error("unknown"))).toContain("Could not reach");
  });
});

describe("lrcmuxClient fallback search", () => {
  it("queries /compat/lrclib/api/search with track_name and artist_name", async () => {
    installTransport(async () =>
      jsonResponse([
        {
          id: 42,
          trackName: "Song",
          artistName: "Artist",
          albumName: "Album",
          duration: 180,
          instrumental: false,
          plainLyrics: "hello",
          syncedLyrics: "[00:01.00] hello",
          lyricsfile: null,
        },
      ]),
    );
    const results = await lrcmuxSearch({ trackName: "Song", artistName: "Artist" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/compat/lrclib/api/search?");
    expect(calls[0].url).toContain("track_name=Song");
    expect(calls[0].url).toContain("artist_name=Artist");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(42);
    expect(results[0].trackName).toBe("Song");
  });

  it("returns empty array when neither trackName nor artistName are provided", async () => {
    installTransport(async () => jsonResponse([]));
    const results = await lrcmuxSearch({});
    expect(results).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("lrcmuxClient reliability & politeness", () => {
  it("retries 5xx failures and succeeds on subsequent attempt", async () => {
    let attempt = 0;
    installTransport(async () => {
      attempt += 1;
      if (attempt < 3) return new Response("502 Bad Gateway", { status: 502 });
      return jsonResponse(sampleJsonResponse());
    });
    const result = await lrcmuxGet({ trackName: "Song", artistName: "Artist" });
    expect(result?.trackName).toBe("Song");
    expect(attempt).toBe(3);
  });

  it("honors Retry-After on 429 and retries", async () => {
    let attempt = 0;
    installTransport(async () => {
      attempt += 1;
      return new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "0.001" } });
    });
    await expect(lrcmuxGet({ trackName: "Song", artistName: "Artist" })).rejects.toMatchObject({
      kind: "rate-limited",
      status: 429,
    });
    expect(attempt).toBeGreaterThanOrEqual(2);
  });

  it("fails fast when Retry-After is too long", async () => {
    let attempt = 0;
    installTransport(async () => {
      attempt += 1;
      return new Response("Too Many Requests", { status: 429, headers: { "Retry-After": "3600" } });
    });
    await expect(lrcmuxGet({ trackName: "Song", artistName: "Artist" })).rejects.toMatchObject({
      kind: "rate-limited",
    });
    expect(attempt).toBe(1);
  });

  it("times out hung requests with a typed timeout error", async () => {
    __testHooks.setTimers({ queueGapMs: 1, retryDelaysMs: [1, 1], requestTimeoutMs: 30 });
    installTransport(
      (_url, init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Timeout", init.signal?.reason?.name ?? "AbortError")),
          );
        }),
    );
    await expect(lrcmuxGet({ trackName: "Song", artistName: "Artist" })).rejects.toMatchObject({
      name: "LrcmuxError",
      kind: "timeout",
    });
  });

  it("rejects with offline error when navigator.onLine is false", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    installTransport(async () => jsonResponse(sampleJsonResponse()));
    await expect(lrcmuxGet({ trackName: "Song", artistName: "Artist" })).rejects.toMatchObject({
      name: "LrcmuxError",
      kind: "offline",
    });
    expect(calls).toHaveLength(0);
  });
});
