import { APP_VERSION } from "../../types";

/**
 * LRCLIB API client (https://lrclib.net/docs).
 *
 * Reliability rules (feature spec §2):
 * - One sequential request queue with a 300 ms gap — never parallel requests.
 * - Identifies itself with the `Lrclib-Client` header (CORS-allowed by the API).
 * - Per-request timeout (10 s), cancellation via AbortSignal, bounded retries
 *   for transient failures, `Retry-After` respected on 429.
 * - Offline is detected before any network attempt.
 * - Only metadata strings are sent; audio never leaves the device.
 */

export const LRCLIB_BASE_URL = "https://lrclib.net/api";

export type LrclibRecord = {
  id: number;
  name?: string;
  trackName: string | null;
  artistName: string | null;
  albumName: string | null;
  duration: number | null;
  instrumental: boolean;
  hasWordSync: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
  lyricsfile: string | null;
};

export type LrclibQuery = {
  trackName?: string;
  artistName?: string;
  albumName?: string;
  /** Seconds. */
  duration?: number;
};

export class LrclibError extends Error {
  readonly kind: "offline" | "rate-limited" | "timeout" | "http" | "malformed" | "network" | "aborted";
  readonly status?: number;
  constructor(kind: LrclibError["kind"], message: string, options?: { status?: number; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "LrclibError";
    this.kind = kind;
    this.status = options?.status;
  }
}

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const RATE_LIMIT_MAX_WAIT_MS = 30_000;

/** Mutable so tests can shrink delays without real sleeping. */
let queueGapMs = 300;
let retryDelaysMs = [500, 1500];
let requestTimeoutMs = REQUEST_TIMEOUT_MS;
let rateLimitWaitCapMs = RATE_LIMIT_MAX_WAIT_MS;
const USER_VISIBLE_MESSAGES: Record<LrclibError["kind"], string> = {
  offline: "You are offline. Lyrics already saved on this device still work.",
  "rate-limited": "The lyrics service is busy. Try again in a moment.",
  timeout: "The lyrics service took too long to respond.",
  http: "The lyrics service had a problem.",
  malformed: "The lyrics service returned an unexpected response.",
  network: "Could not reach the lyrics service.",
  aborted: "Request cancelled.",
};

export function describeLrclibError(error: unknown): string {
  if (error instanceof LrclibError) return USER_VISIBLE_MESSAGES[error.kind];
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
        reject(new LrclibError("aborted", "Cancelled while waiting."));
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
      // Polite spacing between requests (200–500 ms band).
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

/** Test hook: drops queued-but-unstarted jobs (used when tracks change rapidly). */
export function cancelQueuedJobs(): void {
  queue.length = 0;
}

// -- HTTP core ----------------------------------------------------------------

function buildUrl(path: string, params: Record<string, string | number | undefined>): string {
  const url = new URL(`${LRCLIB_BASE_URL}${path}`);
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
      headers: { "Lrclib-Client": `local-music/${APP_VERSION} (personal offline music player)` },
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
    throw new LrclibError("offline", "Device is offline.");
  }
  const url = buildUrl(path, params);

  // Collapse duplicate in-flight requests for the same URL.
  const existing = inFlightByUrl.get(url);
  if (existing) return existing as Promise<T | null>;

  const attempt = enqueue(async () => {
    for (let attemptIndex = 0; attemptIndex < MAX_ATTEMPTS; attemptIndex += 1) {
      if (signal?.aborted) throw new LrclibError("aborted", "Cancelled before dispatch.");
      try {
        const response = await fetchWithTimeout(url, signal);
        if (response.status === 404) return null;
        if (response.status === 429) {
          const retryAfterHeader = response.headers.get("Retry-After");
          const retryAfterSeconds = retryAfterHeader ? Number.parseFloat(retryAfterHeader) : NaN;
          const waitMs = Math.min(
            Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : RATE_LIMIT_MAX_WAIT_MS,
            rateLimitWaitCapMs,
          );
          // Give up immediately when honoring Retry-After would stall the queue
          // for the maximum wait, or when retries are exhausted.
          if (attemptIndex === MAX_ATTEMPTS - 1 || waitMs >= rateLimitWaitCapMs) {
            throw new LrclibError("rate-limited", "Rate limited by LRCLIB.", { status: 429 });
          }
          await sleep(waitMs, signal);
          continue;
        }
        if (response.status >= 500) {
          if (attemptIndex === MAX_ATTEMPTS - 1) {
            throw new LrclibError("http", `LRCLIB server error ${response.status}.`, { status: response.status });
          }
          await sleep(retryDelaysMs[attemptIndex] ?? 1500, signal);
          continue;
        }
        if (!response.ok) {
          throw new LrclibError("http", `LRCLIB responded ${response.status}.`, { status: response.status });
        }
        try {
          return (await response.json()) as T;
        } catch (error) {
          throw new LrclibError("malformed", "LRCLIB returned invalid JSON.", { cause: error });
        }
      } catch (error) {
        if (error instanceof LrclibError) throw error;
        if (signal?.aborted) throw new LrclibError("aborted", "Cancelled.", { cause: error });
        if (error instanceof DOMException && error.name === "TimeoutError") {
          if (attemptIndex === MAX_ATTEMPTS - 1) throw new LrclibError("timeout", "LRCLIB request timed out.", { cause: error });
          await sleep(retryDelaysMs[attemptIndex] ?? 1500, signal);
          continue;
        }
        // Network-level failure (DNS, connection refused…). One retry, then give up
        // with an offline-leaning message.
        if (attemptIndex === MAX_ATTEMPTS - 1) {
          const offline = typeof navigator !== "undefined" && navigator.onLine === false;
          throw new LrclibError(offline ? "offline" : "network", "Could not reach LRCLIB.", { cause: error });
        }
        await sleep(retryDelaysMs[attemptIndex] ?? 1500, signal);
      }
    }
    throw new LrclibError("network", "LRCLIB request failed.");
  });

  inFlightByUrl.set(url, attempt);
  try {
    return await attempt;
  } finally {
    inFlightByUrl.delete(url);
  }
}

function isValidRecord(value: unknown): value is LrclibRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "number" && (typeof record.trackName === "string" || record.trackName === null);
}

// -- Public API ---------------------------------------------------------------

/** Exact lookup. Returns null on 404. Durations are seconds. */
export async function lrclibGet(query: LrclibQuery, signal?: AbortSignal): Promise<LrclibRecord | null> {
  const data = await requestJson<LrclibRecord>("/get", {
    track_name: query.trackName,
    artist_name: query.artistName,
    album_name: query.albumName,
    duration: query.duration,
  }, signal);
  if (data === null) return null;
  if (!isValidRecord(data)) throw new LrclibError("malformed", "LRCLIB /get returned an unexpected shape.");
  return data;
}

/** Free-text / field search. Returns ranked-by-server candidates (unvalidated). */
export async function lrclibSearch(query: LrclibQuery, signal?: AbortSignal): Promise<LrclibRecord[]> {
  const data = await requestJson<unknown>("/search", {
    q: query.trackName ? `${query.trackName} ${query.artistName ?? ""}`.trim() : undefined,
    track_name: query.trackName,
    artist_name: query.artistName,
  }, signal);
  if (data === null) return [];
  if (!Array.isArray(data)) throw new LrclibError("malformed", "LRCLIB /search returned an unexpected shape.");
  return data.filter(isValidRecord);
}

/** Injectable transport so tests can stub the network without touching global fetch. */
let transport: (url: string, init?: RequestInit) => Promise<Response> = (url, init) =>
  fetch(url, init);

/** Test hook: replace the transport (pass null to restore the real one). */
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
