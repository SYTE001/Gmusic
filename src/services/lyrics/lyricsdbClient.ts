import type { LyricLine, LyricWord } from "../../types";

/**
 * LyricsDB API client (https://lyricsdb.kollod.dev / https://lyricsdb.kollod.dev/docs).
 *
 * Reliability rules:
 * - Sequential request queue with polite gap (200 ms).
 * - Per-request timeout (10 s), AbortSignal cancellation.
 * - In-flight deduplication by URL.
 * - Bounded retries for transient failures (up to 3 attempts), Retry-After respected on 429.
 * - Offline detected before network calls.
 * - Never sends audio data; only metadata strings.
 */

export const LYRICSDB_DEFAULT_WORKER_URL = "https://lyrics-lyricsdb-worker.bayualif828.workers.dev";
export const LYRICSDB_DEFAULT_BASE_URL = "https://lyricsdb.kollod.dev/api";

export function getLyricsDbBaseUrl(): string {
  return (
    (typeof import.meta !== "undefined" && import.meta.env?.VITE_LYRICSDB_WORKER_URL) ||
    customBaseUrl ||
    LYRICSDB_DEFAULT_WORKER_URL
  );
}

let customBaseUrl: string | null = null;

export type LyricsDbTrack = {
  id: string; // uuid
  isrc?: string;
  spotifyId?: string;
  appleMusicId?: string;
  deezerId?: string;
  neteaseId?: string;
  qqMusicId?: string;
  title: string;
  artists: string[];
  album?: string;
  durationMs?: number;
  lyricsType?: "word" | "line" | "plain" | null;
  lyricsStoragePath?: string;
  lyricsProvider?: string;
  hasTranslation?: boolean;
  hasRomaji?: boolean;
  hasLyrics?: boolean;
};

export type LyricsDbRecord = {
  id: string;
  trackName: string | null;
  artistName: string | null;
  albumName: string | null;
  /** Duration in seconds. */
  duration: number | null;
  instrumental: boolean;
  hasWordSync: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
  lines?: LyricLine[];
  lyricsfile?: string | null;
  source: string;
  syncLevel: "word" | "line" | "none";
  provider: "lyricsdb";
};

export type LyricsDbQuery = {
  trackName?: string;
  artistName?: string;
  albumName?: string;
  /** Seconds. */
  duration?: number;
  q?: string;
};

export class LyricsDbError extends Error {
  readonly kind: "offline" | "rate-limited" | "timeout" | "http" | "malformed" | "network" | "aborted";
  readonly status?: number;
  constructor(kind: LyricsDbError["kind"], message: string, options?: { status?: number; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "LyricsDbError";
    this.kind = kind;
    this.status = options?.status;
  }
}

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const RATE_LIMIT_MAX_WAIT_MS = 30_000;

let queueGapMs = 200;
let retryDelaysMs = [500, 1500];
let requestTimeoutMs = REQUEST_TIMEOUT_MS;
let rateLimitWaitCapMs = RATE_LIMIT_MAX_WAIT_MS;

const USER_VISIBLE_MESSAGES: Record<LyricsDbError["kind"], string> = {
  offline: "You are offline. Lyrics already saved on this device still work.",
  "rate-limited": "The LyricsDB service is busy. Try again in a moment.",
  timeout: "The LyricsDB service took too long to respond.",
  http: "The LyricsDB service had a problem.",
  malformed: "The LyricsDB service returned an unexpected response.",
  network: "Could not reach the LyricsDB service.",
  aborted: "Request cancelled.",
};

export function describeLyricsDbError(error: unknown): string {
  if (error instanceof LyricsDbError) return USER_VISIBLE_MESSAGES[error.kind];
  return USER_VISIBLE_MESSAGES.network;
}

// -- Sequential queue ---------------------------------------------------------

type QueueJob = () => Promise<void>;

const queue: QueueJob[] = [];
let queueRunning = false;
const inFlightByUrl = new Map<string, Promise<unknown>>();

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new LyricsDbError("aborted", "Cancelled while waiting."));
      },
      { once: true },
    );
  });
}

async function drainQueue(): Promise<void> {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) break;
      await job();
      await new Promise((resolve) => setTimeout(resolve, queueGapMs));
    }
  } finally {
    queueRunning = false;
  }
}

function enqueue<T>(run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push(async () => {
      try {
        resolve(await run());
      } catch (error) {
        reject(error);
      }
    });
    void drainQueue();
  });
}

export function cancelQueuedJobs(): void {
  queue.length = 0;
}

// -- HTTP Core ----------------------------------------------------------------

let transport: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init);

function buildUrl(path: string, params: Record<string, string | number | undefined>): string {
  const base = getLyricsDbBaseUrl().replace(/\/$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${base}${normalizedPath}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "" || (typeof value === "number" && !Number.isFinite(value))) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function fetchWithTimeout(url: string, signal: AbortSignal | undefined): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), requestTimeoutMs);
  const onExternalAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    return await transport(url, {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

async function requestJson<T>(
  path: string,
  params: Record<string, string | number | undefined>,
  signal?: AbortSignal,
): Promise<T | null> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new LyricsDbError("offline", "Device is offline.");
  }
  const url = buildUrl(path, params);

  const existing = inFlightByUrl.get(url);
  if (existing) return existing as Promise<T | null>;

  const attempt = enqueue(async () => {
    for (let attemptIndex = 0; attemptIndex < MAX_ATTEMPTS; attemptIndex += 1) {
      if (signal?.aborted) throw new LyricsDbError("aborted", "Cancelled before dispatch.");
      try {
        const response = await fetchWithTimeout(url, signal);
        if (response.status === 404) return null;
        if (response.status === 400) return null;
        if (response.status === 429) {
          const retryAfterHeader = response.headers.get("Retry-After");
          const retryAfterSeconds = retryAfterHeader ? Number.parseFloat(retryAfterHeader) : NaN;
          const waitMs = Math.min(
            Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : RATE_LIMIT_MAX_WAIT_MS,
            rateLimitWaitCapMs,
          );
          if (attemptIndex === MAX_ATTEMPTS - 1 || waitMs >= rateLimitWaitCapMs) {
            throw new LyricsDbError("rate-limited", "Rate limited by LyricsDB.", { status: 429 });
          }
          await sleep(waitMs, signal);
          continue;
        }
        if (response.status >= 500) {
          if (attemptIndex === MAX_ATTEMPTS - 1) {
            throw new LyricsDbError("http", `LyricsDB server error ${response.status}.`, { status: response.status });
          }
          await sleep(retryDelaysMs[attemptIndex] ?? 1500, signal);
          continue;
        }
        if (!response.ok) {
          throw new LyricsDbError("http", `LyricsDB responded ${response.status}.`, { status: response.status });
        }
        try {
          return (await response.json()) as T;
        } catch (error) {
          throw new LyricsDbError("malformed", "LyricsDB returned invalid JSON.", { cause: error });
        }
      } catch (error) {
        if (error instanceof LyricsDbError) throw error;
        if (signal?.aborted) throw new LyricsDbError("aborted", "Cancelled.", { cause: error });
        if (error instanceof DOMException && error.name === "TimeoutError") {
          if (attemptIndex === MAX_ATTEMPTS - 1) throw new LyricsDbError("timeout", "LyricsDB request timed out.", { cause: error });
          await sleep(retryDelaysMs[attemptIndex] ?? 1500, signal);
          continue;
        }
        if (attemptIndex === MAX_ATTEMPTS - 1) {
          const offline = typeof navigator !== "undefined" && navigator.onLine === false;
          throw new LyricsDbError(offline ? "offline" : "network", "Could not reach LyricsDB.", { cause: error });
        }
        await sleep(retryDelaysMs[attemptIndex] ?? 1500, signal);
      }
    }
    throw new LyricsDbError("network", "LyricsDB request failed.");
  });

  inFlightByUrl.set(url, attempt);
  try {
    return await attempt;
  } finally {
    inFlightByUrl.delete(url);
  }
}

// -- Parser & Normalizer ------------------------------------------------------

function formatLrcTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toFixed(2).padStart(5, "0");
  return `[${String(minutes).padStart(2, "0")}:${seconds}]`;
}

export function parseLyricsDbJsonPayload(data: unknown): {
  lines: LyricLine[];
  hasWordSync: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
  syncLevel: "word" | "line" | "none";
} {
  if (!data) {
    return { lines: [], hasWordSync: false, plainLyrics: null, syncedLyrics: null, syncLevel: "none" };
  }

  // Plain fallback schema: { plain: string }
  if (typeof data === "object" && data !== null && "plain" in data && typeof (data as { plain: unknown }).plain === "string") {
    const plainText = (data as { plain: string }).plain.trim();
    if (!plainText) {
      return { lines: [], hasWordSync: false, plainLyrics: null, syncedLyrics: null, syncLevel: "none" };
    }
    const lines: LyricLine[] = plainText
      .split(/\r?\n/)
      .map((t) => ({ timeMs: null, text: t.trim() }))
      .filter((l) => l.text.length > 0);
    return {
      lines,
      hasWordSync: false,
      plainLyrics: plainText,
      syncedLyrics: null,
      syncLevel: lines.length > 0 ? "none" : "none",
    };
  }

  // Synchronized compact JSON: array of lines
  if (Array.isArray(data)) {
    const lines: LyricLine[] = [];
    const syncedParts: string[] = [];
    const plainParts: string[] = [];
    let detectedWordSync = false;

    for (const rawLine of data) {
      if (!Array.isArray(rawLine)) continue;

      // Extract syllable/word tokens: [vocalType, startMs, lengthMs, text]
      const tokenTuples = rawLine.filter(
        (item): item is [number, number, number, string] =>
          Array.isArray(item) &&
          item.length >= 4 &&
          typeof item[1] === "number" &&
          typeof item[2] === "number" &&
          typeof item[3] === "string",
      );

      if (tokenTuples.length > 0) {
        const lineStartMs = tokenTuples[0][1];
        const lineWords: LyricWord[] = [];
        let fullLineText = "";

        for (const token of tokenTuples) {
          const text = token[3];
          const startMs = token[1];
          const lengthMs = token[2];
          fullLineText += text;

          if (Number.isFinite(startMs)) {
            lineWords.push({
              text,
              startMs,
              endMs: Number.isFinite(lengthMs) && lengthMs > 0 ? startMs + lengthMs : null,
            });
            if (lengthMs > 0 && text.trim().length > 0) {
              detectedWordSync = true;
            }
          }
        }

        const trimmedText = fullLineText.trim();
        lines.push({
          timeMs: lineStartMs,
          text: fullLineText,
          words: lineWords.length > 0 ? lineWords : undefined,
        });

        if (trimmedText.length > 0) {
          syncedParts.push(`${formatLrcTimestamp(lineStartMs)} ${fullLineText}`);
          plainParts.push(fullLineText);
        }
      } else {
        // Line without token tuples (e.g. string line)
        const textParts = rawLine.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
        if (textParts.length > 0) {
          const text = textParts.join(" ");
          lines.push({ timeMs: null, text });
          plainParts.push(text);
        }
      }
    }

    const hasAnyTime = lines.some((l) => l.timeMs !== null);
    const syncLevel: "word" | "line" | "none" = detectedWordSync ? "word" : hasAnyTime ? "line" : "none";

    return {
      lines,
      hasWordSync: detectedWordSync,
      plainLyrics: plainParts.length > 0 ? plainParts.join("\n") : null,
      syncedLyrics: syncedParts.length > 0 ? syncedParts.join("\n") : null,
      syncLevel,
    };
  }

  return { lines: [], hasWordSync: false, plainLyrics: null, syncedLyrics: null, syncLevel: "none" };
}

// -- Public API ---------------------------------------------------------------

/** Search track metadata by keyword query. */
export async function lyricsDbSearchTracks(query: string, limit = 10, signal?: AbortSignal): Promise<LyricsDbTrack[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const results = await requestJson<LyricsDbTrack[]>("/tracks/search", { q: trimmed, limit }, signal);
  if (!results || !Array.isArray(results)) return [];
  return results.filter((item) => item && typeof item.id === "string" && typeof item.title === "string");
}

/** Fetch raw lyrics for a given LyricsDB track UUID. */
export async function lyricsDbFetchLyrics(trackId: string, format = "json", signal?: AbortSignal): Promise<unknown> {
  const cleanId = encodeURIComponent(trackId.trim());
  return await requestJson<unknown>(`/tracks/${cleanId}/lyrics`, { format }, signal);
}

/** Structured discovery search: searches tracks and builds normalized LyricsDbRecords. */
export async function lyricsDbSearch(query: LyricsDbQuery, signal?: AbortSignal): Promise<LyricsDbRecord[]> {
  const primaryTerm = query.trackName?.trim() || query.q?.trim() || query.artistName?.trim();
  if (!primaryTerm) return [];

  let tracks = await lyricsDbSearchTracks(primaryTerm, 10, signal);
  if (tracks.length === 0 && query.artistName && query.trackName) {
    const combined = `${query.trackName} ${query.artistName}`.trim();
    if (combined !== primaryTerm) {
      tracks = await lyricsDbSearchTracks(combined, 10, signal);
    }
  }
  if (tracks.length === 0) return [];

  // Filter to tracks with lyrics
  const candidateTracks = tracks.filter((t) => t.hasLyrics !== false);
  const records: LyricsDbRecord[] = [];

  for (const track of candidateTracks) {
    if (signal?.aborted) throw new LyricsDbError("aborted", "Cancelled during candidate fetch.");
    try {
      const lyricsPayload = await lyricsDbFetchLyrics(track.id, "json", signal);
      if (!lyricsPayload) continue;

      const parsed = parseLyricsDbJsonPayload(lyricsPayload);
      if (parsed.lines.length === 0 && !parsed.plainLyrics) continue;

      const artistName = Array.isArray(track.artists) && track.artists.length > 0 ? track.artists.join(", ") : null;
      records.push({
        id: track.id,
        trackName: track.title || null,
        artistName,
        albumName: track.album || null,
        duration: track.durationMs ? track.durationMs / 1000 : null,
        instrumental: false,
        hasWordSync: parsed.hasWordSync,
        lines: parsed.lines,
        syncedLyrics: parsed.syncedLyrics,
        plainLyrics: parsed.plainLyrics,
        source: track.lyricsProvider ? `lyricsdb (${track.lyricsProvider})` : "lyricsdb",
        syncLevel: parsed.syncLevel,
        provider: "lyricsdb",
      });
    } catch (err) {
      if (err instanceof LyricsDbError && err.kind === "aborted") throw err;
      // Skip tracks that failed individual lyrics fetch
    }
  }

  return records;
}

/** Exact lookup via search and matching. Returns null on miss. */
export async function lyricsDbGet(query: LyricsDbQuery, signal?: AbortSignal): Promise<LyricsDbRecord | null> {
  const primaryTerm = query.trackName?.trim() || query.q?.trim();
  if (!primaryTerm) return null;

  let tracks = await lyricsDbSearchTracks(primaryTerm, 10, signal);
  if (tracks.length === 0 && query.artistName) {
    const combined = `${query.trackName ?? ""} ${query.artistName}`.trim();
    if (combined !== primaryTerm) {
      tracks = await lyricsDbSearchTracks(combined, 10, signal);
    }
  }
  if (tracks.length === 0) return null;

  // Find the track closest in artist and duration
  const targetDuration = query.duration;
  let bestTrack: LyricsDbTrack | null = null;
  let bestScore = -Infinity;

  for (const track of tracks) {
    if (track.hasLyrics === false) continue;

    const artistStr = Array.isArray(track.artists) ? track.artists.join(", ") : "";
    let artistMatch = 1.0;
    if (query.artistName && artistStr) {
      const qArt = query.artistName.toLowerCase().trim();
      const tArt = artistStr.toLowerCase().trim();
      if (tArt.includes(qArt) || qArt.includes(tArt)) {
        artistMatch = 1.0;
      } else {
        artistMatch = 0.5;
      }
    }

    const durationDelta =
      targetDuration != null && track.durationMs != null
        ? Math.abs(track.durationMs / 1000 - targetDuration)
        : 0;

    if (targetDuration != null && durationDelta > 60) continue;

    const score = artistMatch * 100 - durationDelta;
    if (score > bestScore) {
      bestScore = score;
      bestTrack = track;
    }
  }

  if (!bestTrack) return null;

  try {
    const payload = await lyricsDbFetchLyrics(bestTrack.id, "json", signal);
    if (!payload) return null;

    const parsed = parseLyricsDbJsonPayload(payload);
    if (parsed.lines.length === 0 && !parsed.plainLyrics) return null;

    const artistName = Array.isArray(bestTrack.artists) && bestTrack.artists.length > 0 ? bestTrack.artists.join(", ") : null;
    return {
      id: bestTrack.id,
      trackName: bestTrack.title || null,
      artistName,
      albumName: bestTrack.album || null,
      duration: bestTrack.durationMs ? bestTrack.durationMs / 1000 : null,
      instrumental: false,
      hasWordSync: parsed.hasWordSync,
      lines: parsed.lines,
      syncedLyrics: parsed.syncedLyrics,
      plainLyrics: parsed.plainLyrics,
      source: bestTrack.lyricsProvider ? `lyricsdb (${bestTrack.lyricsProvider})` : "lyricsdb",
      syncLevel: parsed.syncLevel,
      provider: "lyricsdb",
    };
  } catch (err) {
    if (err instanceof LyricsDbError && err.kind === "aborted") throw err;
    return null;
  }
}

/** Test hooks for mocking network and timers in Vitest. */
export const __testHooks = {
  setTransport(replacement: ((url: string, init?: RequestInit) => Promise<Response>) | null): void {
    const restore: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init);
    transport = replacement ?? restore;
  },
  setTimers(timers: { queueGapMs?: number; retryDelaysMs?: number[]; requestTimeoutMs?: number; rateLimitWaitCapMs?: number }): void {
    if (timers.queueGapMs !== undefined) queueGapMs = timers.queueGapMs;
    if (timers.retryDelaysMs !== undefined) retryDelaysMs = timers.retryDelaysMs;
    if (timers.requestTimeoutMs !== undefined) requestTimeoutMs = timers.requestTimeoutMs;
    if (timers.rateLimitWaitCapMs !== undefined) rateLimitWaitCapMs = timers.rateLimitWaitCapMs;
  },
  setBaseUrl(url: string | null): void {
    customBaseUrl = url;
  },
};
