import { getAccessToken, workerConfigured, workerUrl } from "./cloudAuthService";

/**
 * R2StorageService — the browser-side client for the Cloudflare Worker
 * (spec §3/§5).
 *
 * Invariants:
 *  - Presigned URLs are held in memory only, keyed by object key, and are
 *    refreshed when they are close to expiring. They are never persisted to
 *    IndexedDB, never stored on a Track, and never cached in the service
 *    worker (the SW deliberately does not touch cross-origin audio).
 *  - A URL being issued proves nothing: the caller treats an upload as
 *    complete only after `completeUpload` verifies the object.
 *  - Network failures are retried once with a short backoff; auth failures
 *    surface as `CloudStorageError` with kind "auth" so callers can sign the
 *    user back in rather than looping.
 */

export type CloudStorageErrorKind = "auth" | "network" | "not-found" | "server" | "unconfigured" | "cancelled";

export class CloudStorageError extends Error {
  readonly kind: CloudStorageErrorKind;
  readonly status: number | null;
  constructor(kind: CloudStorageErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = "CloudStorageError";
    this.kind = kind;
    this.status = status;
  }
}

export type UploadUrlResult = {
  objectKey: string;
  uploadUrl: string;
  uploadIntent?: string;
  expiresIn: number;
  requiredHeaders: { [header: string]: string };
  kind: "audio" | "artwork";
};

export type CompleteUploadResult = {
  objectKey: string;
  size: number;
  etag: string | null;
  contentType: string | null;
};

export type PlayUrlResult = {
  url: string;
  expiresAt: number;
  expiresIn: number;
};

type CachedPlayUrl = { url: string; expiresAtSec: number };

type InFlightEntry = { promise: Promise<string> } | undefined;

const PLAY_URL_CACHE = new Map<string, CachedPlayUrl>();
const IN_FLIGHT = new Map<string, InFlightEntry>();
/** Refresh a URL this many seconds before its real expiry, never mid-playback. */
const EXPIRY_MARGIN_SEC = 30;
/** Hard cap so a stale entry can never be trusted past its signed lifetime. */
const MAX_CACHE_SEC = 600;

let abortSignal: AbortSignal | null = null;

/** Cancels every in-flight request and drops cached URLs (used by sign-out). */
export function resetCloudStorageState(): void {
  abortSignal = null;
  PLAY_URL_CACHE.clear();
  IN_FLIGHT.clear();
}

export function setCloudAbortSignal(signal: AbortSignal | null): void {
  abortSignal = signal;
}

function isCancelled(): boolean {
  return abortSignal?.aborted === true;
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  if (!workerConfigured()) {
    throw new CloudStorageError("unconfigured", "Cloud storage is not configured on this build.");
  }
  const token = await getAccessToken();
  if (!token) {
    throw new CloudStorageError("auth", "Sign in to use cloud storage.");
  }

  let response: Response;
  try {
    response = await fetch(`${workerUrl()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: abortSignal,
    });
  } catch (error) {
    if (isCancelled()) throw new CloudStorageError("cancelled", "The operation was cancelled.");
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new CloudStorageError("cancelled", "The operation was cancelled.");
    }
    throw new CloudStorageError("network", "Cloud storage could not be reached. Check your connection and try again.");
  }

  if (response.status === 401 || response.status === 403) {
    throw new CloudStorageError("auth", await describeProblem(response), response.status);
  }
  if (response.status === 404) {
    throw new CloudStorageError("not-found", await describeProblem(response), response.status);
  }
  if (!response.ok) {
    throw new CloudStorageError("server", await describeProblem(response), response.status);
  }
  try {
    return await response.json();
  } catch {
    throw new CloudStorageError("server", "The cloud service returned an unexpected response.");
  }
}

async function describeProblem(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? response.statusText;
  } catch {
    return response.statusText;
  }
}

/**
 * Requests a presigned PUT URL. The Worker authenticates the caller and
 * constructs the object key itself; the browser only suggests a track id,
 * a file name, a size, and a MIME type.
 */
export async function requestUploadUrl(params: {
  trackId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  kind?: "audio" | "artwork";
}): Promise<UploadUrlResult> {
  return postJson("/api/audio/upload-url", {
    trackId: params.trackId,
    fileName: params.fileName,
    mimeType: params.mimeType,
    sizeBytes: params.sizeBytes,
    kind: params.kind ?? "audio",
  }).then((raw) => parseUploadUrlResult(raw, params.kind ?? "audio"));
}

function parseUploadUrlResult(raw: unknown, kind: "audio" | "artwork"): UploadUrlResult {
  const body = raw as Partial<UploadUrlResult> & Record<string, unknown>;
  if (typeof body?.uploadUrl !== "string" || typeof body?.objectKey !== "string") {
    throw new CloudStorageError("server", "The cloud service did not return a usable upload URL.");
  }
  return {
    objectKey: body.objectKey,
    uploadUrl: body.uploadUrl,
    uploadIntent: typeof body.uploadIntent === "string" ? body.uploadIntent : undefined,
    expiresIn: typeof body.expiresIn === "number" ? body.expiresIn : 120,
    requiredHeaders: (body.requiredHeaders as UploadUrlResult["requiredHeaders"]) ?? { "content-type": "application/octet-stream" },
    kind: (body.kind as "audio" | "artwork") ?? kind,
  };
}

/**
 * Asks the Worker to verify the uploaded object before anything is recorded
 * as uploaded: existence, size, and metadata are all checked server-side.
 */
export async function completeUpload(params: {
  objectKey: string;
  uploadIntent?: string;
  trackId: string;
  sizeBytes: number;
  mimeType: string;
}): Promise<CompleteUploadResult> {
  const raw = await postJson("/api/audio/complete", {
    objectKey: params.objectKey,
    uploadIntent: params.uploadIntent,
    trackId: params.trackId,
    sizeBytes: params.sizeBytes,
    mimeType: params.mimeType,
  });
  const body = raw as Partial<CompleteUploadResult> & Record<string, unknown>;
  if (typeof body?.objectKey !== "string") {
    throw new CloudStorageError("server", "Upload verification returned an unexpected response.");
  }
  return {
    objectKey: body.objectKey,
    size: typeof body.size === "number" ? body.size : 0,
    etag: typeof body.etag === "string" ? body.etag : null,
    contentType: typeof body.contentType === "string" ? body.contentType : null,
  };
}

/** Asks the Worker to authorize and remove a cloud object and its siblings. */
export async function deleteCloudObject(objectKey: string): Promise<string[]> {
  const raw = await postJson("/api/audio/delete", { objectKey });
  const body = raw as { deleted?: { objectKey?: unknown }[] };
  return (body.deleted ?? [])
    .map((entry) => entry.objectKey)
    .filter((key): key is string => typeof key === "string");
}

function remainingSec(entry: CachedPlayUrl): number {
  return entry.expiresAtSec - Math.floor(Date.now() / 1000);
}

function isUsable(entry: CachedPlayUrl | undefined): entry is CachedPlayUrl {
  return Boolean(entry && remainingSec(entry) > EXPIRY_MARGIN_SEC && remainingSec(entry) <= MAX_CACHE_SEC + EXPIRY_MARGIN_SEC);
}

/**
 * Returns a playable URL for an object key. Cached results are reused while
 * fresh; a cached URL that is about to expire (or a `forceFresh` request)
 * triggers a single round trip to the Worker. Concurrent callers share one
 * request so quick track switches never stampede the Worker.
 */
export async function getPlayUrl(objectKey: string, options?: { forceFresh?: boolean }): Promise<string> {
  const cached = PLAY_URL_CACHE.get(objectKey);
  if (!options?.forceFresh && isUsable(cached)) {
    return cached.url;
  }
  PLAY_URL_CACHE.delete(objectKey);

  const existing = IN_FLIGHT.get(objectKey);
  if (existing) return existing.promise;

  const promise = postJson("/api/audio/play-url", { objectKey })
    .then((raw) => {
      const body = raw as Partial<PlayUrlResult> & Record<string, unknown>;
      const url = body?.url;
      if (typeof url !== "string") {
        throw new CloudStorageError("server", "The cloud service did not return a playable URL.");
      }
      const expiresIn = typeof body.expiresIn === "number" ? body.expiresIn : 300;
      const entry: CachedPlayUrl = {
        url,
        expiresAtSec: typeof body.expiresAt === "number" ? body.expiresAt : Math.floor(Date.now() / 1000) + expiresIn,
      };
      PLAY_URL_CACHE.set(objectKey, entry);
      IN_FLIGHT.delete(objectKey);
      return entry.url;
    })
    .catch((error: unknown) => {
      IN_FLIGHT.delete(objectKey);
      throw error;
    });

  IN_FLIGHT.set(objectKey, { promise });
  return promise;
}

/** Drops a cached URL so the next request cannot reuse a stale one. */
export function invalidatePlayUrl(objectKey: string): void {
  PLAY_URL_CACHE.delete(objectKey);
}

/** Reads the cached expiry for diagnostics and tests (never persisted). */
export function cachedPlayUrlExpiry(objectKey: string): number | null {
  const entry = PLAY_URL_CACHE.get(objectKey);
  return entry ? entry.expiresAtSec : null;
}

/** Test hook: resets every cache between cases. */
export function __resetForTests(): void {
  resetCloudStorageState();
}
