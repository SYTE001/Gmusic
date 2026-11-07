import type { Env } from "./env";

const DEFAULT_ORIGIN = "https://gmusic-tawny.vercel.app";
const DEFAULT_LRCLIB_BASE = "https://lrclib.net/api";
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
    "access-control-allow-headers": "content-type, accept, lrclib-client",
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
      return jsonResponse({ ok: true, service: "lyrics-lrclib-worker" }, 200, request, env);
    }

    const upstreamBase = (env.LRCLIB_BASE_URL || DEFAULT_LRCLIB_BASE).replace(/\/$/, "");

    // GET /api/get
    if (url.pathname === "/api/get" || url.pathname === "/get") {
      if (request.method !== "GET") {
        return jsonResponse({ error: "Method not allowed" }, 405, request, env);
      }

      const trackName = url.searchParams.get("track_name")?.trim();
      const artistName = url.searchParams.get("artist_name")?.trim();
      if (!trackName && !artistName) {
        return jsonResponse({ error: "Missing required parameters: track_name or artist_name" }, 400, request, env);
      }

      const targetUrl = new URL(`${upstreamBase}/get`);
      for (const [key, val] of url.searchParams.entries()) {
        targetUrl.searchParams.set(key, val);
      }

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
          // ignore cache lookup errors
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
            "Lrclib-Client": USER_AGENT,
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
            { error: `Upstream LRCLIB returned error ${upstreamRes.status}` },
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

        if (typeof data !== "object" || data === null) {
          return jsonResponse({ error: "Invalid upstream payload" }, 502, request, env);
        }

        const exactTtl = Number.parseInt(env.CACHE_TTL_EXACT_SECONDS || "86400", 10);
        const headers: Record<string, string> = {
          "cache-control": `public, max-age=${exactTtl}`,
          "x-worker-cache": "MISS",
        };

        const response = jsonResponse(data, 200, request, env, headers);

        if (cache && ctx?.waitUntil) {
          try {
            ctx.waitUntil(cache.put(cacheKey, response.clone()));
          } catch {
            // cache put error non-fatal
          }
        }

        return response;
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof DOMException && err.name === "TimeoutError") {
          return jsonResponse({ error: "LRCLIB request timed out" }, 504, request, env);
        }
        return jsonResponse({ error: "Could not reach LRCLIB", cause: String(err) }, 502, request, env);
      }
    }

    // GET /api/search
    if (url.pathname === "/api/search" || url.pathname === "/search") {
      if (request.method !== "GET") {
        return jsonResponse({ error: "Method not allowed" }, 405, request, env);
      }

      const q = url.searchParams.get("q")?.trim();
      const trackName = url.searchParams.get("track_name")?.trim();
      const artistName = url.searchParams.get("artist_name")?.trim();
      if (!q && !trackName && !artistName) {
        return jsonResponse({ error: "At least one search parameter required" }, 400, request, env);
      }

      const targetUrl = new URL(`${upstreamBase}/search`);
      for (const [key, val] of url.searchParams.entries()) {
        targetUrl.searchParams.set(key, val);
      }

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
          // ignore cache error
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
            "Lrclib-Client": USER_AGENT,
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
            { error: `Upstream LRCLIB returned error ${upstreamRes.status}` },
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

        const searchTtl = Number.parseInt(env.CACHE_TTL_SEARCH_SECONDS || "900", 10);
        const headers: Record<string, string> = {
          "cache-control": `public, max-age=${searchTtl}`,
          "x-worker-cache": "MISS",
        };

        const response = jsonResponse(data, 200, request, env, headers);

        if (cache && ctx?.waitUntil) {
          try {
            ctx.waitUntil(cache.put(cacheKey, response.clone()));
          } catch {
            // cache put error non-fatal
          }
        }

        return response;
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof DOMException && err.name === "TimeoutError") {
          return jsonResponse({ error: "LRCLIB request timed out" }, 504, request, env);
        }
        return jsonResponse({ error: "Could not reach LRCLIB", cause: String(err) }, 502, request, env);
      }
    }

    return jsonResponse({ error: "Not Found" }, 404, request, env);
  },
};
