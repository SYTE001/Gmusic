import type { Env } from "./env";

const DEFAULT_ORIGIN = "https://gmusic-tawny.vercel.app";
const DEFAULT_LYRICSDB_BASE = "https://lyricsdb.kollod.dev/api";
const DEFAULT_TIMEOUT_MS = 10_000;
const USER_AGENT = "Gmusic/1.0.0 (https://github.com/SYTE001/Gmusic)";

function resolveOrigin(request: Request, env: Env): string {
  const configured = env.ALLOWED_ORIGIN || DEFAULT_ORIGIN;
  if (configured === "*") return "*";

  const requestOrigin = request.headers.get("origin");
  if (!requestOrigin) return configured.split(",")[0].trim();

  const allowedList = configured.split(",").map((s) => s.trim().toLowerCase());
  const originLower = requestOrigin.toLowerCase();

  if (
    allowedList.includes(originLower) ||
    originLower.startsWith("http://localhost:") ||
    originLower.startsWith("http://127.0.0.1:") ||
    originLower.startsWith("https://gmusic-tawny.vercel.app")
  ) {
    return requestOrigin;
  }

  return allowedList[0] || DEFAULT_ORIGIN;
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  return {
    "access-control-allow-origin": resolveOrigin(request, env),
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type, accept",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function jsonResponse(body: unknown, status: number, request: Request, env: Env, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(request, env),
      ...headers,
    },
  });
}

function parseTimeout(env: Env): number {
  const val = Number.parseInt(env.REQUEST_TIMEOUT_MS || "", 10);
  return Number.isFinite(val) && val > 0 ? val : DEFAULT_TIMEOUT_MS;
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/api/health" || url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "lyrics-lyricsdb-worker" }, 200, request, env);
    }

    const upstreamBase = (env.LYRICSDB_BASE_URL || DEFAULT_LYRICSDB_BASE).replace(/\/$/, "");

    // GET /api/tracks/search
    if (url.pathname === "/api/tracks/search" || url.pathname === "/tracks/search") {
      if (request.method !== "GET") {
        return jsonResponse({ error: "Method not allowed" }, 405, request, env);
      }

      const q = url.searchParams.get("q")?.trim();
      if (!q) {
        return jsonResponse({ error: "Missing required query parameter: q" }, 400, request, env);
      }

      const targetUrl = new URL(`${upstreamBase}/tracks/search`);
      targetUrl.searchParams.set("q", q);
      const limit = url.searchParams.get("limit");
      if (limit) targetUrl.searchParams.set("limit", limit);

      const cacheKey = new Request(targetUrl.toString(), { method: "GET" });
      const cache = typeof caches !== "undefined" && caches?.default ? caches.default : null;

      if (cache) {
        try {
          const cached = await cache.match(cacheKey);
          if (cached) {
            const cachedHeaders = new Headers(cached.headers);
            for (const [k, v] of Object.entries(corsHeaders(request, env))) {
              cachedHeaders.set(k, v);
            }
            cachedHeaders.set("x-worker-cache", "HIT");
            return new Response(cached.body, { status: cached.status, headers: cachedHeaders });
          }
        } catch {
          // ignore cache read failure
        }
      }

      const timeoutMs = parseTimeout(env);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), timeoutMs);

      try {
        const upstreamRes = await fetch(targetUrl.toString(), {
          method: "GET",
          headers: {
            Accept: "application/json",
            "User-Agent": USER_AGENT,
          },
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (upstreamRes.status === 429) {
          const retryAfter = upstreamRes.headers.get("retry-after") || "5";
          return jsonResponse({ error: "Rate limited by upstream" }, 429, request, env, {
            "retry-after": retryAfter,
          });
        }

        if (!upstreamRes.ok) {
          return jsonResponse(
            { error: `Upstream LyricsDB returned error ${upstreamRes.status}` },
            502,
            request,
            env,
          );
        }

        let data: unknown;
        try {
          data = await upstreamRes.json();
        } catch {
          return jsonResponse({ error: "Malformed upstream JSON" }, 502, request, env);
        }

        if (!Array.isArray(data)) {
          return jsonResponse({ error: "Invalid upstream payload, expected array" }, 502, request, env);
        }

        const searchTtl = Number.parseInt(env.CACHE_TTL_SEARCH_SECONDS || "3600", 10);
        const headers: Record<string, string> = {
          "cache-control": `public, max-age=${searchTtl}`,
          "x-worker-cache": "MISS",
        };

        const response = jsonResponse(data, 200, request, env, headers);

        if (cache && ctx?.waitUntil) {
          try {
            ctx.waitUntil(cache.put(cacheKey, response.clone()));
          } catch {
            // cache put non-fatal
          }
        }

        return response;
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof DOMException && err.name === "TimeoutError") {
          return jsonResponse({ error: "LyricsDB request timed out" }, 504, request, env);
        }
        return jsonResponse({ error: "Could not reach LyricsDB", cause: String(err) }, 502, request, env);
      }
    }

    // GET /api/tracks/:id/lyrics
    const lyricsMatch = url.pathname.match(/^(?:\/api)?\/tracks\/([^/]+)\/lyrics\/?$/);
    if (lyricsMatch) {
      if (request.method !== "GET") {
        return jsonResponse({ error: "Method not allowed" }, 405, request, env);
      }

      const trackId = decodeURIComponent(lyricsMatch[1]).trim();
      if (!trackId) {
        return jsonResponse({ error: "Missing track ID" }, 400, request, env);
      }

      const format = url.searchParams.get("format") || "json";
      const targetUrl = new URL(`${upstreamBase}/tracks/${encodeURIComponent(trackId)}/lyrics`);
      targetUrl.searchParams.set("format", format);

      const cacheKey = new Request(targetUrl.toString(), { method: "GET" });
      const cache = typeof caches !== "undefined" && caches?.default ? caches.default : null;

      if (cache) {
        try {
          const cached = await cache.match(cacheKey);
          if (cached) {
            const cachedHeaders = new Headers(cached.headers);
            for (const [k, v] of Object.entries(corsHeaders(request, env))) {
              cachedHeaders.set(k, v);
            }
            cachedHeaders.set("x-worker-cache", "HIT");
            return new Response(cached.body, { status: cached.status, headers: cachedHeaders });
          }
        } catch {
          // ignore cache read failure
        }
      }

      const timeoutMs = parseTimeout(env);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), timeoutMs);

      try {
        const upstreamRes = await fetch(targetUrl.toString(), {
          method: "GET",
          headers: {
            Accept: format === "json" ? "application/json" : "*/*",
            "User-Agent": USER_AGENT,
          },
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (upstreamRes.status === 404) {
          return jsonResponse({ error: "Lyrics not found" }, 404, request, env);
        }

        if (upstreamRes.status === 429) {
          const retryAfter = upstreamRes.headers.get("retry-after") || "5";
          return jsonResponse({ error: "Rate limited by upstream" }, 429, request, env, {
            "retry-after": retryAfter,
          });
        }

        if (!upstreamRes.ok) {
          return jsonResponse(
            { error: `Upstream LyricsDB returned error ${upstreamRes.status}` },
            502,
            request,
            env,
          );
        }

        const contentType = upstreamRes.headers.get("content-type") || "";
        const lyricsTtl = Number.parseInt(env.CACHE_TTL_LYRICS_SECONDS || "86400", 10);

        if (format === "json" || contentType.includes("json")) {
          let data: unknown;
          try {
            data = await upstreamRes.json();
          } catch {
            return jsonResponse({ error: "Malformed upstream JSON" }, 502, request, env);
          }

          const headers: Record<string, string> = {
            "cache-control": `public, max-age=${lyricsTtl}`,
            "x-worker-cache": "MISS",
          };

          const response = jsonResponse(data, 200, request, env, headers);

          if (cache && ctx?.waitUntil) {
            try {
              ctx.waitUntil(cache.put(cacheKey, response.clone()));
            } catch {
              // ignore
            }
          }

          return response;
        }

        // Plain text / LRC / other formats
        const rawText = await upstreamRes.text();
        const headers: Record<string, string> = {
          "content-type": contentType || "text/plain; charset=utf-8",
          "cache-control": `public, max-age=${lyricsTtl}`,
          "x-worker-cache": "MISS",
          ...corsHeaders(request, env),
        };

        const response = new Response(rawText, { status: 200, headers });

        if (cache && ctx?.waitUntil) {
          try {
            ctx.waitUntil(cache.put(cacheKey, response.clone()));
          } catch {
            // ignore
          }
        }

        return response;
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof DOMException && err.name === "TimeoutError") {
          return jsonResponse({ error: "LyricsDB request timed out" }, 504, request, env);
        }
        return jsonResponse({ error: "Could not reach LyricsDB", cause: String(err) }, 502, request, env);
      }
    }

    // GET /api/lyrics (lookup by platform / url)
    if (url.pathname === "/api/lyrics" || url.pathname === "/lyrics") {
      if (request.method !== "GET") {
        return jsonResponse({ error: "Method not allowed" }, 405, request, env);
      }

      const targetUrl = new URL(`${upstreamBase}/lyrics`);
      for (const [key, val] of url.searchParams.entries()) {
        targetUrl.searchParams.set(key, val);
      }

      const timeoutMs = parseTimeout(env);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), timeoutMs);

      try {
        const upstreamRes = await fetch(targetUrl.toString(), {
          method: "GET",
          headers: {
            Accept: "*/*",
            "User-Agent": USER_AGENT,
          },
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (upstreamRes.status === 404) {
          return jsonResponse({ error: "Lyrics not found" }, 404, request, env);
        }

        if (upstreamRes.status === 429) {
          const retryAfter = upstreamRes.headers.get("retry-after") || "5";
          return jsonResponse({ error: "Rate limited by upstream" }, 429, request, env, {
            "retry-after": retryAfter,
          });
        }

        if (!upstreamRes.ok) {
          return jsonResponse(
            { error: `Upstream LyricsDB returned error ${upstreamRes.status}` },
            502,
            request,
            env,
          );
        }

        const contentType = upstreamRes.headers.get("content-type") || "";
        const text = await upstreamRes.text();
        return new Response(text, {
          status: 200,
          headers: {
            "content-type": contentType || "application/json; charset=utf-8",
            ...corsHeaders(request, env),
          },
        });
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof DOMException && err.name === "TimeoutError") {
          return jsonResponse({ error: "LyricsDB request timed out" }, 504, request, env);
        }
        return jsonResponse({ error: "Could not reach LyricsDB", cause: String(err) }, 502, request, env);
      }
    }

    // GET /api/system/providers
    if (url.pathname === "/api/system/providers" || url.pathname === "/system/providers") {
      try {
        const upstreamRes = await fetch(`${upstreamBase}/system/providers`, {
          headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        });
        const data = await upstreamRes.json();
        return jsonResponse(data, upstreamRes.status, request, env);
      } catch (err) {
        return jsonResponse({ error: "Could not reach LyricsDB provider status", cause: String(err) }, 502, request, env);
      }
    }

    return jsonResponse({ error: "Not Found" }, 404, request, env);
  },
};
