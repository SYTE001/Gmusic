import type { LyricLine, LyricWord } from "../../types";

/**
 * lrcmux API client (https://api.lrcmux.dev / https://lrcmux.dev/docs).
 *
 * Reliability and politeness rules:
 * - One sequential request queue with a 300 ms gap — never parallel requests.
 * - CORS-safe simple requests only: no custom headers (a header like
 *   `X-Client` triggers an OPTIONS preflight, which the API rejects, making
 *   every lookup fail from the browser). Identification relies on the
 *   User-Agent the browser sends automatically.
 * - Per-request timeout (10 s), cancellation via AbortSignal, bounded retries
 *   for transient failures (up to 3 attempts), `Retry-After` respected on 429.
 * - Offline is detected before any network attempt.
 * - Only metadata strings are sent; audio never leaves the device.
 */

export const LRCMUX_BASE_URL = "https://api.lrcmux.dev";

export type LrcmuxWord = {
  text: string;
  start: number; // in milliseconds
  end: number; // in milliseconds
};

export type LrcmuxLine = {
  text: string;
  start?: number; // in milliseconds
  end?: number; // in milliseconds
  words?: LrcmuxWord[] | null;
};

export type LrcmuxTrack = {
  title: string;
  artist: string;
  album: string;
  duration: number; // in seconds
  isrc?: string;
  cover?: {
    small?: string;
    medium?: string;
    big?: string;
  };
};

export type LrcmuxMeta = {
  source?: {
    id: string;
    name: string;
    url?: string;
  };
  level: "word" | "line" | "none";
  instrumental?: boolean;
};

export type LrcmuxJsonResponse = {
  track: LrcmuxTrack;
  meta: LrcmuxMeta;
  lines: LrcmuxLine[] | null;
};

export type LrcmuxCompatResponse = {
  id: number;
  trackName: string | null;
  artistName: string | null;
  albumName: string | null;
  duration: number | null;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
  lyricsfile: string | null;
};

export type LrcmuxRecord = {
  id: number | string;
  trackName: string | null;
  artistName: string | null;
  albumName: string | null;
  /** Seconds. */
  duration: number | null;
  instrumental: boolean;
  hasWordSync: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
  /** Normalized lines with milliseconds when present. */
  lines?: LyricLine[];
  /** Raw lyricsfile text if available from compat search. */
  lyricsfile?: string | null;
  source?: string;
  syncLevel?: "word" | "line" | "none";
};

export type LrcmuxQuery = {
  trackName?: string;
  artistName?: string;
  albumName?: string;
  /** Seconds. */
  duration?: number;
  q?: string;
};

export class LrcmuxError extends Error {
  readonly kind: "offline" | "rate-limited" | "timeout" | "http" | "malformed" | "network" | "aborted";
  readonly status?: number;
  constructor(kind: LrcmuxError["kind"], message: string, options?: { status?: number; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "LrcmuxError";
    this.kind = kind;
    this.status = options?.status;
  }
}

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const RATE_LIMIT_MAX_WAIT_MS = 30_000;

let queueGapMs = 300;
let retryDelaysMs = [500, 1500];
let requestTimeoutMs = REQUEST_TIMEOUT_MS;
let rateLimitWaitCapMs = RATE_LIMIT_MAX_WAIT_MS;

const USER_VISIBLE_MESSAGES: Record<LrcmuxError["kind"], string> = {
  offline: "You are offline. Lyrics already saved on this device still work.",
  "rate-limited": "The lyrics service is busy. Try again in a moment.",
  timeout: "The lyrics service took too long to respond.",
  http: "The lyrics service had a problem.",
  malformed: "The lyrics service returned an unexpected response.",
  network: "Could not reach the lyrics service.",
  aborted: "Request cancelled.",
};

export function describeLrcmuxError(error: unknown): string {
  if (error instanceof LrcmuxError) return USER_VISIBLE_MESSAGES[error.kind];
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
        reject(new LrcmuxError("aborted", "Cancelled while waiting."));
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

// -- HTTP core ----------------------------------------------------------------

function buildUrl(path: string, params: Record<string, string | number | boolean | undefined>): string {
  const url = new URL(`${LRCMUX_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "" || (typeof value === "number" && !Number.isFinite(value))) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

let transport: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init);

async function fetchWithTimeout(url: string, signal: AbortSignal | undefined): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), requestTimeoutMs);
  const onExternalAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onExternalAbort, { once: true });
  try {
    return await transport(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
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
  params: Record<string, string | number | boolean | undefined>,
  signal?: AbortSignal,
): Promise<T | null> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new LrcmuxError("offline", "Device is offline.");
  }
  const url = buildUrl(path, params);

  const existing = inFlightByUrl.get(url);
  if (existing) return existing as Promise<T | null>;

  const attempt = enqueue(async () => {
    for (let attemptIndex = 0; attemptIndex < MAX_ATTEMPTS; attemptIndex += 1) {
      if (signal?.aborted) throw new LrcmuxError("aborted", "Cancelled before dispatch.");
      try {
        const response = await fetchWithTimeout(url, signal);
        if (response.status === 404) return null;
        if (response.status === 400) {
          // Bad request (e.g. missing required params or unsupported format)
          return null;
        }
        if (response.status === 429) {
          const retryAfterHeader = response.headers.get("Retry-After");
          const retryAfterSeconds = retryAfterHeader ? Number.parseFloat(retryAfterHeader) : NaN;
          const waitMs = Math.min(
            Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : RATE_LIMIT_MAX_WAIT_MS,
            rateLimitWaitCapMs,
          );
          if (attemptIndex === MAX_ATTEMPTS - 1 || waitMs >= rateLimitWaitCapMs) {
            throw new LrcmuxError("rate-limited", "Rate limited by lrcmux.", { status: 429 });
          }
          await sleep(waitMs, signal);
          continue;
        }
        if (response.status >= 500) {
          if (attemptIndex === MAX_ATTEMPTS - 1) {
            throw new LrcmuxError("http", `lrcmux server error ${response.status}.`, { status: response.status });
          }
          await sleep(retryDelaysMs[attemptIndex] ?? 1500, signal);
          continue;
        }
        if (!response.ok) {
          throw new LrcmuxError("http", `lrcmux responded ${response.status}.`, { status: response.status });
        }
        try {
          return (await response.json()) as T;
        } catch (error) {
          throw new LrcmuxError("malformed", "lrcmux returned invalid JSON.", { cause: error });
        }
      } catch (error) {
        if (error instanceof LrcmuxError) throw error;
        if (signal?.aborted) throw new LrcmuxError("aborted", "Cancelled.", { cause: error });
        if (error instanceof DOMException && error.name === "TimeoutError") {
          if (attemptIndex === MAX_ATTEMPTS - 1) throw new LrcmuxError("timeout", "lrcmux request timed out.", { cause: error });
          await sleep(retryDelaysMs[attemptIndex] ?? 1500, signal);
          continue;
        }
        if (attemptIndex === MAX_ATTEMPTS - 1) {
          const offline = typeof navigator !== "undefined" && navigator.onLine === false;
          throw new LrcmuxError(offline ? "offline" : "network", "Could not reach lrcmux.", { cause: error });
        }
        await sleep(retryDelaysMs[attemptIndex] ?? 1500, signal);
      }
    }
    throw new LrcmuxError("network", "lrcmux request failed.");
  });

  inFlightByUrl.set(url, attempt);
  try {
    return await attempt;
  } finally {
    inFlightByUrl.delete(url);
  }
}

// -- Mapping helpers ----------------------------------------------------------

function formatLrcTimestamp(ms: number): string {
  const totalSeconds = Math.max(0, ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toFixed(2).padStart(5, "0");
  return `[${String(minutes).padStart(2, "0")}:${seconds}]`;
}

export function mapJsonResponseToRecord(data: LrcmuxJsonResponse): LrcmuxRecord {
  const isInstrumental = Boolean(data.meta.instrumental);
  const syncLevel = data.meta.level ?? "none";
  const hasWordSync = syncLevel === "word";

  const lines: LyricLine[] = [];
  const syncedParts: string[] = [];
  const plainParts: string[] = [];

  if (Array.isArray(data.lines)) {
    for (const rawLine of data.lines) {
      if (!rawLine.text && rawLine.start === undefined) continue;
      const timeMs = typeof rawLine.start === "number" ? rawLine.start : null;
      let words: LyricWord[] | undefined;

      if (Array.isArray(rawLine.words) && rawLine.words.length > 0) {
        words = rawLine.words.map((w) => ({
          text: w.text,
          startMs: w.start,
          endMs: w.end,
        }));
      }

      lines.push({
        timeMs,
        text: rawLine.text ?? "",
        words,
      });

      if (timeMs !== null) {
        syncedParts.push(`${formatLrcTimestamp(timeMs)} ${rawLine.text ?? ""}`);
      }
      plainParts.push(rawLine.text ?? "");
    }
  }

  return {
    id: data.track.isrc || `${data.track.artist}-${data.track.title}`,
    trackName: data.track.title || null,
    artistName: data.track.artist || null,
    albumName: data.track.album || null,
    duration: data.track.duration ?? null,
    instrumental: isInstrumental,
    hasWordSync,
    lines,
    syncedLyrics: syncedParts.length > 0 ? syncedParts.join("\n") : null,
    plainLyrics: plainParts.length > 0 ? plainParts.join("\n") : null,
    source: data.meta.source?.name ?? data.meta.source?.id ?? "lrcmux",
    syncLevel,
  };
}

// -- Public API ---------------------------------------------------------------

/** Exact lookup via lrcmux native /get endpoint. Returns null on 404 or bad parameters. */
export async function lrcmuxGet(query: LrcmuxQuery, signal?: AbortSignal): Promise<LrcmuxRecord | null> {
  if (!query.trackName || !query.artistName) {
    return null;
  }
  const data = await requestJson<LrcmuxJsonResponse>(
    "/get",
    {
      title: query.trackName,
      artist: query.artistName,
      album: query.albumName,
      duration: query.duration ? Math.round(query.duration) : undefined,
      level: "word",
      format: "json",
    },
    signal,
  );
  if (!data || typeof data !== "object") return null;
  if (!data.track || !data.meta) {
    throw new LrcmuxError("malformed", "lrcmux /get returned an unexpected shape.");
  }
  return mapJsonResponseToRecord(data);
}

/** Fallback search via /compat/lrclib/api/search. Returns ranked candidates. */
export async function lrcmuxSearch(query: LrcmuxQuery, signal?: AbortSignal): Promise<LrcmuxRecord[]> {
  if (!query.trackName && !query.artistName && !query.q) return [];
  const data = await requestJson<LrcmuxCompatResponse[]>(
    "/compat/lrclib/api/search",
    {
      q: query.q,
      track_name: query.trackName,
      artist_name: query.artistName,
      album_name: query.albumName,
    },
    signal,
  );
  if (!data) return [];
  if (!Array.isArray(data)) {
    throw new LrcmuxError("malformed", "lrcmux /compat/lrclib/api/search returned an unexpected shape.");
  }

  return data.map((item) => ({
    id: item.id,
    trackName: item.trackName,
    artistName: item.artistName,
    albumName: item.albumName,
    duration: item.duration,
    instrumental: Boolean(item.instrumental),
    hasWordSync: Boolean(item.lyricsfile && item.lyricsfile.includes("start_ms")),
    plainLyrics: item.plainLyrics,
    syncedLyrics: item.syncedLyrics,
    lyricsfile: item.lyricsfile,
    source: "lrcmux (compat)",
    syncLevel: (item.lyricsfile && item.lyricsfile.includes("start_ms")) ? "word" : item.syncedLyrics ? "line" : "none",
  }));
}

/** Test hook: replace the transport or tweak timers. */
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
};
