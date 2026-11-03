import type { Env } from "./env";
import { ApiError, Errors } from "./errors";

/**
 * Lightweight, read-only MusicBrainz WS/2 metadata proxy.
 *
 * MusicBrainz requires an identifiable User-Agent header on every request,
 * which browser JavaScript cannot reliably set across all environments.
 *
 * Security & operational invariants:
 *  - Read-only (`GET` only).
 *  - Strictly restricted to official MusicBrainz WS/2 endpoints (`release-group` and `release`).
 *  - Never exposes Worker secrets or interferes with `/api/audio/*` routes.
 *  - Enforces a maximum average upstream request rate of 1 request per second (1000ms).
 *  - Caches successful JSON responses in memory (and Cloudflare edge cache when present).
 *  - Bounds upstream response payload size (512 KB max) and enforces an 8s timeout.
 */

export const GMUSIC_USER_AGENT = "Gmusic/1.1.0 ( https://github.com/SYTE001/Gmusic )";
export const OFFICIAL_MUSICBRAINZ_BASE = "https://musicbrainz.org/ws/2";

const MBID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_ENTITIES = new Set(["release-group", "release"]);
const ALLOWED_INC_TOKENS = new Set([
  "aliases",
  "artist-credits",
  "releases",
  "release-groups",
  "recordings",
  "media",
  "url-rels",
]);

const MAX_QUERY_LENGTH = 500;
const MAX_LIMIT = 25;
const DEFAULT_LIMIT = 10;
const MAX_OFFSET = 1000;
const MAX_RESPONSE_BYTES = 512 * 1024; // 512 KB
const UPSTREAM_TIMEOUT_MS = 8000;
const RATE_LIMIT_INTERVAL_MS = 1000; // 1 req/s average max
const MAX_RATE_WAIT_MS = 4000; // Reject with 429 if backlog exceeds 4 seconds
const CACHE_TTL_SECONDS = 3600; // 1 hour
const MAX_MEMORY_CACHE_ENTRIES = 250;

interface CachedEntry {
  body: string;
  expiresAtMs: number;
}

const memoryCache = new Map<string, CachedEntry>();
let nextAllowedRequestAtMs = 0;

export function isValidMbid(value: string): boolean {
  return MBID_REGEX.test(value.trim());
}

/** Reset rate limiter and cache state between tests. */
export function __resetMusicBrainzProxyForTests(): void {
  memoryCache.clear();
  nextAllowedRequestAtMs = 0;
}

function getCachedResponse(cacheKey: string, nowMs: number): string | null {
  const entry = memoryCache.get(cacheKey);
  if (!entry) return null;
  if (nowMs >= entry.expiresAtMs) {
    memoryCache.delete(cacheKey);
    return null;
  }
  // Refresh LRU order
  memoryCache.delete(cacheKey);
  memoryCache.set(cacheKey, entry);
  return entry.body;
}

function setCachedResponse(cacheKey: string, body: string, nowMs: number): void {
  if (memoryCache.has(cacheKey)) {
    memoryCache.delete(cacheKey);
  } else if (memoryCache.size >= MAX_MEMORY_CACHE_ENTRIES) {
    const oldestKey = memoryCache.keys().next().value;
    if (oldestKey !== undefined) {
      memoryCache.delete(oldestKey);
    }
  }
  memoryCache.set(cacheKey, {
    body,
    expiresAtMs: nowMs + CACHE_TTL_SECONDS * 1000,
  });
}

function resolveUpstreamBaseUrl(env: Env): string {
  const override = env.MUSICBRAINZ_BASE_URL?.trim();
  if (override) {
    try {
      const parsed = new URL(override);
      // Only allow official musicbrainz.org or local loopback for test harness
      if (
        parsed.hostname === "musicbrainz.org" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "localhost"
      ) {
        return override.replace(/\/+$/, "");
      }
    } catch {
      // Ignore invalid override and use official endpoint
    }
  }
  return OFFICIAL_MUSICBRAINZ_BASE;
}

function sanitizeIncParam(rawInc: string | null): string | null {
  if (!rawInc) return null;
  const tokens = rawInc
    .split(/[+\s,]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return null;
  for (const token of tokens) {
    if (!ALLOWED_INC_TOKENS.has(token)) {
      throw Errors.badRequest(`Unsupported 'inc' parameter value: ${token}`);
    }
  }
  return Array.from(new Set(tokens)).join("+");
}

function parseBoundedInt(raw: string | null, name: string, min: number, max: number, fallback: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw Errors.badRequest(`Query parameter '${name}' must be a non-negative integer.`);
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw Errors.badRequest(`Query parameter '${name}' must be between ${min} and ${max}.`);
  }
  return parsed;
}

/**
 * Parses and validates incoming proxy routes:
 *  - `/api/musicbrainz/release-group`
 *  - `/api/musicbrainz/release-group/:mbid`
 *  - `/api/musicbrainz/release`
 *  - `/api/musicbrainz/release/:mbid`
 *  (Also supports `/api/metadata/musicbrainz/...`)
 */
export function buildUpstreamMusicBrainzUrl(requestUrl: URL, env: Env): URL {
  const prefixMatch = requestUrl.pathname.match(
    /^\/api\/(?:metadata\/)?musicbrainz\/([a-z-]+)(?:\/([^/]+))?\/?$/i,
  );
  if (!prefixMatch) {
    throw Errors.badRequest("Invalid MusicBrainz proxy path.");
  }

  const entity = prefixMatch[1].toLowerCase();
  if (!ALLOWED_ENTITIES.has(entity)) {
    throw Errors.badRequest(`Unsupported MusicBrainz entity '${entity}'. Only 'release-group' and 'release' are allowed.`);
  }

  const pathMbid = prefixMatch[2] ? decodeURIComponent(prefixMatch[2]).trim() : null;
  const queryMbid = requestUrl.searchParams.get("mbid")?.trim() ?? null;
  const mbid = pathMbid || queryMbid;

  const baseUrl = resolveUpstreamBaseUrl(env);
  const inc = sanitizeIncParam(requestUrl.searchParams.get("inc"));

  if (mbid) {
    if (!isValidMbid(mbid)) {
      throw Errors.badRequest("Invalid MusicBrainz MBID format (expected a valid UUID).");
    }
    const upstream = new URL(`${baseUrl}/${entity}/${mbid.toLowerCase()}`);
    if (inc) {
      upstream.searchParams.set("inc", inc);
    }
    upstream.searchParams.set("fmt", "json");
    return upstream;
  }

  // Search or browse request
  const query = requestUrl.searchParams.get("query")?.trim() ?? null;
  const releaseGroupMbid = requestUrl.searchParams.get("release-group")?.trim() ?? null;

  if (!query && !(entity === "release" && releaseGroupMbid)) {
    throw Errors.badRequest("Missing required search parameter 'query' or 'mbid'.");
  }

  if (query !== null) {
    if (query.length === 0) {
      throw Errors.badRequest("Search parameter 'query' must not be empty.");
    }
    if (query.length > MAX_QUERY_LENGTH) {
      throw Errors.badRequest(`Search parameter 'query' exceeds maximum length of ${MAX_QUERY_LENGTH} characters.`);
    }
  }

  if (releaseGroupMbid !== null && !isValidMbid(releaseGroupMbid)) {
    throw Errors.badRequest("Invalid 'release-group' MBID parameter.");
  }

  const limit = parseBoundedInt(requestUrl.searchParams.get("limit"), "limit", 1, MAX_LIMIT, DEFAULT_LIMIT);
  const offset = parseBoundedInt(requestUrl.searchParams.get("offset"), "offset", 0, MAX_OFFSET, 0);

  const upstream = new URL(`${baseUrl}/${entity}`);
  if (query) {
    upstream.searchParams.set("query", query);
  } else if (releaseGroupMbid) {
    upstream.searchParams.set("release-group", releaseGroupMbid.toLowerCase());
  }
  if (inc) {
    upstream.searchParams.set("inc", inc);
  }
  upstream.searchParams.set("limit", String(limit));
  if (offset > 0) {
    upstream.searchParams.set("offset", String(offset));
  }
  upstream.searchParams.set("fmt", "json");
  return upstream;
}

async function acquireRateLimitSlot(): Promise<void> {
  const now = Date.now();
  const scheduledAt = Math.max(now, nextAllowedRequestAtMs);
  const waitMs = scheduledAt - now;
  if (waitMs > MAX_RATE_WAIT_MS) {
    throw Errors.rateLimited();
  }
  nextAllowedRequestAtMs = scheduledAt + RATE_LIMIT_INTERVAL_MS;
  if (waitMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const declaredLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new ApiError(502, "upstream-response-too-large", "Upstream MusicBrainz response exceeded maximum allowed size.");
    }
  }

  if (!response.body) {
    return await response.text();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          throw new ApiError(502, "upstream-response-too-large", "Upstream MusicBrainz response exceeded maximum allowed size.");
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export function isMusicBrainzProxyPath(pathname: string): boolean {
  return pathname.startsWith("/api/musicbrainz/") || pathname.startsWith("/api/metadata/musicbrainz/");
}

export async function handleMusicBrainzProxy(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  if (request.method !== "GET") {
    throw new ApiError(405, "method-not-allowed", "Only GET is supported for MusicBrainz metadata routes.");
  }

  const requestUrl = new URL(request.url);
  const upstreamUrl = buildUpstreamMusicBrainzUrl(requestUrl, env);
  const cacheKey = upstreamUrl.toString();
  const nowMs = Date.now();

  // 1. Check in-memory LRU cache first
  const cachedBody = getCachedResponse(cacheKey, nowMs);
  if (cachedBody !== null) {
    return new Response(cachedBody, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${CACHE_TTL_SECONDS}`,
        "x-cache": "HIT",
        ...corsHeaders,
      },
    });
  }

  // 2. Enforce 1 request / second rate limit before calling MusicBrainz
  await acquireRateLimitSlot();

  // Re-check cache after waiting for rate-limit slot in case an earlier request populated it
  const cachedAfterWait = getCachedResponse(cacheKey, Date.now());
  if (cachedAfterWait !== null) {
    return new Response(cachedAfterWait, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${CACHE_TTL_SECONDS}`,
        "x-cache": "HIT",
        ...corsHeaders,
      },
    });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstreamUrl.toString(), {
      method: "GET",
      headers: {
        "User-Agent": GMUSIC_USER_AGENT,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      throw new ApiError(504, "upstream-timeout", "MusicBrainz request timed out.");
    }
    throw new ApiError(502, "upstream-error", "MusicBrainz service could not be reached.");
  } finally {
    clearTimeout(timeoutId);
  }

  if (upstreamResponse.status === 404) {
    throw Errors.notFound("The requested MusicBrainz entity was not found.");
  }

  if (upstreamResponse.status === 429 || upstreamResponse.status === 503) {
    return new Response(
      JSON.stringify({
        error: {
          code: upstreamResponse.status === 429 ? "rate-limited" : "service-unavailable",
          message: "MusicBrainz is temporarily rate-limiting or unavailable. Please retry shortly.",
        },
      }),
      {
        status: upstreamResponse.status,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "retry-after": upstreamResponse.headers.get("retry-after") ?? "2",
          ...corsHeaders,
        },
      },
    );
  }

  if (!upstreamResponse.ok) {
    throw new ApiError(502, "upstream-error", `MusicBrainz returned unexpected HTTP ${upstreamResponse.status}.`);
  }

  const bodyText = await readBoundedBody(upstreamResponse, MAX_RESPONSE_BYTES);

  // Verify valid JSON before caching/returning
  try {
    JSON.parse(bodyText);
  } catch {
    throw new ApiError(502, "upstream-invalid-json", "MusicBrainz returned malformed JSON.");
  }

  setCachedResponse(cacheKey, bodyText, Date.now());

  return new Response(bodyText, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_TTL_SECONDS}`,
      "x-cache": "MISS",
      ...corsHeaders,
    },
  });
}
