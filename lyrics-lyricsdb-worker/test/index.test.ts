import { describe, expect, it, vi, afterEach } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";

describe("lyrics-lyricsdb-worker", () => {
  const env: Env = {
    ALLOWED_ORIGIN: "https://gmusic-tawny.vercel.app",
    LYRICSDB_BASE_URL: "https://mock-lyricsdb.test/api",
    REQUEST_TIMEOUT_MS: "5000",
  };

  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("handles OPTIONS preflight with strict CORS", async () => {
    const req = new Request("https://worker.test/api/tracks/search", {
      method: "OPTIONS",
      headers: { Origin: "https://gmusic-tawny.vercel.app" },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://gmusic-tawny.vercel.app");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });

  it("responds to /api/health", async () => {
    const req = new Request("https://worker.test/api/health", { method: "GET" });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean; service: string };
    expect(data.ok).toBe(true);
    expect(data.service).toBe("lyrics-lyricsdb-worker");
  });

  it("rejects /api/tracks/search without query param q", async () => {
    const req = new Request("https://worker.test/api/tracks/search", { method: "GET" });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
  });

  it("proxies /api/tracks/search successfully", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: "uuid-1234",
            title: "Bohemian Rhapsody",
            artists: ["Queen"],
            album: "A Night At The Opera",
            lyricsType: "word",
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const req = new Request("https://worker.test/api/tracks/search?q=Bohemian", {
      method: "GET",
      headers: { Origin: "http://localhost:5173" },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(res.headers.get("cache-control")).toContain("public");
    const data = await res.json() as { title: string }[];
    expect(data[0].title).toBe("Bohemian Rhapsody");
  });

  it("proxies /api/tracks/:id/lyrics successfully for word-sync compact JSON", async () => {
    const compactPayload = [
      [[1, 0, 458, "Is "], [1, 458, 348, "this "], [1, 806, 418, "the "], [1, 1224, 833, "real "], [1, 2057, 849, "life? "]],
    ];
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(compactPayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const req = new Request("https://worker.test/api/tracks/uuid-1234/lyrics?format=json", {
      method: "GET",
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const data = await res.json() as unknown[];
    expect(Array.isArray(data)).toBe(true);
  });

  it("propagates 404 from /api/tracks/:id/lyrics", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("Not found", { status: 404 }));

    const req = new Request("https://worker.test/api/tracks/nonexistent/lyrics", { method: "GET" });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(404);
  });

  it("propagates 429 with Retry-After", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Too many requests", {
        status: 429,
        headers: { "retry-after": "15" },
      })
    );

    const req = new Request("https://worker.test/api/tracks/search?q=test", { method: "GET" });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("15");
  });
});
