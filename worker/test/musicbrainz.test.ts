import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startWorker, type TestContext } from "./harness";
import {
  __resetMusicBrainzProxyForTests,
  buildUpstreamMusicBrainzUrl,
  GMUSIC_USER_AGENT,
  isValidMbid,
  OFFICIAL_MUSICBRAINZ_BASE,
} from "../src/musicbrainz";
import type { Env } from "../src/env";

interface UpstreamHit {
  pathname: string;
  search: string;
  userAgent: string;
  timestampMs: number;
}

describe("MusicBrainz Worker Proxy", () => {
  let mockUpstream: Server | null = null;
  let upstreamBaseUrl = "";
  let hits: UpstreamHit[] = [];
  let nextStatus = 200;
  let nextBody: string = JSON.stringify({ "release-groups": [], count: 0 });
  let ctx: TestContext | null = null;

  beforeAll(async () => {
    mockUpstream = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      hits.push({
        pathname: url.pathname,
        search: url.search,
        userAgent: String(req.headers["user-agent"] ?? ""),
        timestampMs: Date.now(),
      });
      res.writeHead(nextStatus, {
        "content-type": "application/json; charset=utf-8",
      });
      res.end(nextBody);
    });

    await new Promise<void>((resolve) => mockUpstream!.listen(0, "127.0.0.1", resolve));
    const addr = mockUpstream.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    upstreamBaseUrl = `http://127.0.0.1:${port}/ws/2`;

    ctx = await startWorker({ MUSICBRAINZ_BASE_URL: upstreamBaseUrl });
  });

  afterAll(async () => {
    await ctx?.mf.dispose();
    ctx = null;
    if (mockUpstream) {
      await new Promise<void>((resolve) => mockUpstream!.close(() => resolve()));
    }
  });

  beforeEach(() => {
    hits = [];
    nextStatus = 200;
    nextBody = JSON.stringify({
      "release-groups": [
        {
          id: "11111111-2222-3333-4444-555555555555",
          title: "Random Access Memories",
          "primary-type": "Album",
        },
      ],
      count: 1,
    });
    __resetMusicBrainzProxyForTests();
  });

  it("validates UUID MBIDs and restricts upstream URLs to official MusicBrainz WS/2", () => {
    expect(isValidMbid("11111111-2222-3333-4444-555555555555")).toBe(true);
    expect(isValidMbid("not-a-uuid")).toBe(false);
    expect(isValidMbid("../../etc/passwd")).toBe(false);

    const fakeEnv = {
      MUSICBRAINZ_BASE_URL: "https://evil.example.com/steal",
    } as unknown as Env;

    const url = buildUpstreamMusicBrainzUrl(
      new URL("https://worker.local/api/musicbrainz/release-group?query=artist%3A%22Daft+Punk%22&limit=5"),
      fakeEnv,
    );
    expect(url.origin + "/ws/2").toBe(OFFICIAL_MUSICBRAINZ_BASE);
    expect(url.pathname).toBe("/ws/2/release-group");
    expect(url.searchParams.get("fmt")).toBe("json");
    expect(url.searchParams.get("limit")).toBe("5");
  });

  it("rejects unsupported entities, non-GET methods, invalid MBIDs, and empty queries", async () => {
    const postRes = await ctx!.api("/api/musicbrainz/release-group?query=test", { method: "POST" });
    expect(postRes.status).toBe(405);

    const badEntity = await ctx!.api("/api/musicbrainz/artist?query=test", { method: "GET" });
    expect(badEntity.status).toBe(400);

    const badMbid = await ctx!.api("/api/musicbrainz/release-group/not-a-valid-uuid", { method: "GET" });
    expect(badMbid.status).toBe(400);

    const missingQuery = await ctx!.api("/api/musicbrainz/release-group", { method: "GET" });
    expect(missingQuery.status).toBe(400);

    const badInc = await ctx!.api(
      "/api/musicbrainz/release-group/11111111-2222-3333-4444-555555555555?inc=evil-token",
      { method: "GET" },
    );
    expect(badInc.status).toBe(400);
  });

  it("sets identifiable Gmusic User-Agent header and caches identical requests", async () => {
    const queryPath = "/api/musicbrainz/release-group?query=artist%3A%22Daft%20Punk%22%20AND%20releasegroup%3A%22Discovery%22&limit=5";
    const first = await ctx!.api(queryPath, { method: "GET" });
    expect(first.status).toBe(200);
    expect(first.headers.get("x-cache")).toBe("MISS");
    expect(hits.length).toBe(1);
    expect(hits[0].userAgent).toBe(GMUSIC_USER_AGENT);
    expect(hits[0].pathname).toBe("/ws/2/release-group");

    // Second identical request should hit the Worker cache without hitting upstream
    const second = await ctx!.api(queryPath, { method: "GET" });
    expect(second.status).toBe(200);
    expect(second.headers.get("x-cache")).toBe("HIT");
    expect(hits.length).toBe(1);
  });

  it("enforces an average maximum rate of 1 MusicBrainz request per second on cache misses", async () => {
    const [resA, resB] = await Promise.all([
      ctx!.api("/api/musicbrainz/release-group?query=albumA", { method: "GET" }),
      ctx!.api("/api/musicbrainz/release-group?query=albumB", { method: "GET" }),
    ]);

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(hits.length).toBe(2);
    const spacingMs = Math.abs(hits[1].timestampMs - hits[0].timestampMs);
    expect(spacingMs).toBeGreaterThanOrEqual(900);
  });

  it("propagates 404 and 503 upstream responses gracefully with CORS headers", async () => {
    nextStatus = 404;
    nextBody = JSON.stringify({ error: "Not Found" });
    const notFound = await ctx!.api(
      "/api/musicbrainz/release-group/11111111-2222-3333-4444-555555555555",
      { method: "GET" },
    );
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get("access-control-allow-origin")).toBeTruthy();

    nextStatus = 503;
    nextBody = JSON.stringify({ error: "Service Unavailable" });
    const unavailable = await ctx!.api(
      "/api/metadata/musicbrainz/release?query=retry-me-later",
      { method: "GET" },
    );
    expect(unavailable.status).toBe(503);
  });
});
