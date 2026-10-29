import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __testHooks, LrclibError, lrclibGet, lrclibSearch, type LrclibRecord } from "./lrclibClient";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function sampleRecord(overrides: Partial<LrclibRecord> = {}): LrclibRecord {
  return {
    id: 1,
    name: "Song",
    trackName: "Song",
    artistName: "Artist",
    albumName: "Album",
    duration: 100,
    instrumental: false,
    hasWordSync: false,
    plainLyrics: "la la",
    syncedLyrics: "[00:01.00]la la",
    lyricsfile: null,
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

describe("lrclibClient basics", () => {
  it("sends the Lrclib-Client identification header and encodes parameters", async () => {
    installTransport(async () => jsonResponse(sampleRecord()));
    await lrclibGet({ trackName: "Black Bird", artistName: "Ärtist & Co", duration: 123.4 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("track_name=Black+Bird");
    expect(calls[0].url).toContain("artist_name=");
    expect(calls[0].url).toContain("duration=123");
    expect(calls[0].headers["Lrclib-Client"]).toMatch(/^local-music\//);
  });

  it("omits empty parameters instead of sending blanks", async () => {
    installTransport(async () => jsonResponse(sampleRecord()));
    await lrclibGet({ trackName: "Song", artistName: undefined, albumName: "" });
    expect(calls[0].url).not.toContain("artist_name");
    expect(calls[0].url).not.toContain("album_name");
  });

  it("returns null on 404", async () => {
    installTransport(async () => new Response("not found", { status: 404 }));
    const result = await lrclibGet({ trackName: "x" });
    expect(result).toBeNull();
  });

  it("rejects malformed JSON with a typed error", async () => {
    installTransport(async () => new Response("<html>gateway</html>", { status: 200 }));
    await expect(lrclibGet({ trackName: "x" })).rejects.toMatchObject({ name: "LrclibError", kind: "malformed" });
  });

  it("rejects records with an unexpected shape", async () => {
    installTransport(async () => jsonResponse({ nope: true }));
    await expect(lrclibGet({ trackName: "x" })).rejects.toBeInstanceOf(LrclibError);
  });
});

describe("lrclibClient reliability", () => {
  it("retries 5xx failures and succeeds on a later attempt", async () => {
    let attempt = 0;
    installTransport(async () => {
      attempt += 1;
      if (attempt < 3) return new Response("boom", { status: 502 });
      return jsonResponse(sampleRecord());
    });
    const result = await lrclibGet({ trackName: "x" });
    expect(result?.id).toBe(1);
    expect(attempt).toBe(3);
  });

  it("surfaces a rate-limited error after honoring a small Retry-After", async () => {
    let attempt = 0;
    installTransport(async () => {
      attempt += 1;
      return new Response("slow down", { status: 429, headers: { "Retry-After": "0.001" } });
    });
    await expect(lrclibGet({ trackName: "x" })).rejects.toMatchObject({ kind: "rate-limited", status: 429 });
    expect(attempt).toBeGreaterThanOrEqual(2);
  });

  it("fails fast on 429 when Retry-After demands a long wait", async () => {
    let attempt = 0;
    installTransport(async () => {
      attempt += 1;
      return new Response("slow down", { status: 429, headers: { "Retry-After": "3600" } });
    });
    await expect(lrclibGet({ trackName: "x" })).rejects.toMatchObject({ kind: "rate-limited" });
    expect(attempt).toBe(1);
  });

  it("times out hung requests with a typed timeout error", async () => {
    __testHooks.setTimers({ queueGapMs: 1, retryDelaysMs: [1, 1], requestTimeoutMs: 30 });
    // Real fetch settles on abort; the fake must too or the queue would stall.
    installTransport(
      (_url, init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Timeout", init.signal?.reason?.name ?? "AbortError")));
        }),
    );
    await expect(lrclibGet({ trackName: "x" })).rejects.toMatchObject({ kind: "timeout" });
  });

  it("maps network failure to a network error after retries", async () => {
    let attempt = 0;
    installTransport(async () => {
      attempt += 1;
      throw new TypeError("Failed to fetch");
    });
    await expect(lrclibGet({ trackName: "x" })).rejects.toMatchObject({ kind: "network" });
    expect(attempt).toBe(3);
  });

  it("throws a typed offline error before touching the network", async () => {
    const onlineGetter = vi.spyOn(navigator, "onLine", "get");
    onlineGetter.mockReturnValue(false);
    installTransport(async () => {
      throw new Error("should not be called");
    });
    await expect(lrclibGet({ trackName: "x" })).rejects.toMatchObject({ kind: "offline" });
    expect(calls).toHaveLength(0);
  });

  it("propagates cancellation via AbortSignal", async () => {
    const controller = new AbortController();
    installTransport(
      (_url, init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    const pending = lrclibGet({ trackName: "x" }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
  });
});

describe("lrclibClient queueing", () => {
  it("processes requests sequentially, never in parallel", async () => {
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    installTransport(async (url) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`start ${new URL(url).searchParams.get("track_name")}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(`end ${new URL(url).searchParams.get("track_name")}`);
      active -= 1;
      return jsonResponse(sampleRecord());
    });
    await Promise.all([
      lrclibGet({ trackName: "a" }),
      lrclibGet({ trackName: "b" }),
      lrclibGet({ trackName: "c" }),
    ]);
    expect(maxActive).toBe(1);
    expect(order).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("collapses duplicate concurrent lookups into one request", async () => {
    installTransport(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return jsonResponse(sampleRecord());
    });
    const [one, two] = await Promise.all([lrclibGet({ trackName: "same" }), lrclibGet({ trackName: "same" })]);
    expect(one?.id).toBe(1);
    expect(two?.id).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

describe("lrclibSearch", () => {
  it("returns validated records and filters malformed entries", async () => {
    installTransport(async () => jsonResponse([sampleRecord(), { bad: 1 }, sampleRecord({ id: 2 })]));
    const results = await lrclibSearch({ trackName: "Song", artistName: "Artist" });
    expect(results.map((record) => record.id)).toEqual([1, 2]);
  });

  it("sends search parameters as fields plus a combined q", async () => {
    installTransport(async () => jsonResponse([]));
    await lrclibSearch({ trackName: "Yesterday", artistName: "The Beatles" });
    expect(calls[0].url).toContain("/search");
    expect(calls[0].url).toContain("track_name=Yesterday");
    expect(calls[0].url).toContain("q=Yesterday+The+Beatles");
  });
});
