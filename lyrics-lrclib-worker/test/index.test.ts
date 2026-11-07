import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";

describe("lyrics-lrclib-worker", () => {
  const env: Env = {
    ALLOWED_ORIGIN: "https://gmusic-tawny.vercel.app",
    LRCLIB_BASE_URL: "https://mock-lrclib.test/api",
    REQUEST_TIMEOUT_MS: "5000",
  };

  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("handles OPTIONS preflight with strict CORS", async () => {
    const req = new Request("https://worker.test/api/get", {
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
    expect(data.service).toBe("lyrics-lrclib-worker");
  });

  it("rejects /api/get when missing track_name and artist_name", async () => {
    const req = new Request("https://worker.test/api/get", { method: "GET" });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
  });

  it("proxies /api/get successfully and attaches CORS", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 12345,
          trackName: "Bohemian Rhapsody",
          artistName: "Queen",
          syncedLyrics: "[00:10.00] Mama...",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const req = new Request(
      "https://worker.test/api/get?track_name=Bohemian+Rhapsody&artist_name=Queen&duration=354",
      {
        method: "GET",
        headers: { Origin: "http://localhost:5173" },
      }
    );
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(res.headers.get("cache-control")).toContain("public");
    const data = await res.json() as { trackName: string };
    expect(data.trackName).toBe("Bohemian Rhapsody");
  });

  it("propagates 404 from upstream LRCLIB /api/get", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("Not found", { status: 404 }));

    const req = new Request("https://worker.test/api/get?track_name=Nonexistent&artist_name=Nobody", {
      method: "GET",
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(404);
  });

  it("propagates 429 with Retry-After", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Too many requests", {
        status: 429,
        headers: { "retry-after": "12" },
      })
    );

    const req = new Request("https://worker.test/api/get?track_name=Test&artist_name=Test", {
      method: "GET",
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("12");
  });

  it("proxies /api/search successfully", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          { id: 1, trackName: "Song 1", artistName: "Artist" },
          { id: 2, trackName: "Song 2", artistName: "Artist" },
        ]),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const req = new Request("https://worker.test/api/search?q=Artist", { method: "GET" });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const data = await res.json() as unknown[];
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBe(2);
  });
});
