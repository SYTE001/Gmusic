/**
 * Worker entry point: authenticated, short-lived access to private R2
 * objects for Local Music (spec §3).
 *
 * POST /api/audio/upload-url  — issue a presigned PUT for a new object key
 * POST /api/audio/complete    — verify the object landed and matches
 * POST /api/audio/play-url    — issue a short-lived presigned GET
 * POST /api/audio/delete      — remove the object and its track siblings
 * GET  /api/health            — unauthenticated smoke check
 *
 * Every protected route calls `requireUser`, which verifies the Supabase
 * access-token signature — never a decoded JWT, never a client-supplied id.
 */
import { requireUser } from "./auth";
import { ApiError, Errors } from "./errors";
import { KeySpec, contentTypeForUpload, extensionFromFileName, validateId } from "./keys";
import { deleteTrackObjects, objectExists, presignGet, presignPut, verifyObject } from "./r2";
import { createUploadIntent, verifyUploadIntent } from "./uploadIntent";
import type { Env } from "./env";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

function corsHeaders(env: Env): Record<string, string> {
  const origin = env.ALLOWED_ORIGIN || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, GET, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

function json(body: unknown, status = 200, env: Env): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...corsHeaders(env) } });
}

function errorResponse(error: unknown, env: Env): Response {
  const apiError = error instanceof ApiError ? error : toServerError(error);
  const body = { error: { code: apiError.code, message: apiError.message } };
  return new Response(JSON.stringify(body), {
    status: apiError.status,
    headers: { ...JSON_HEADERS, ...corsHeaders(env) } as Record<string, string>,
  });
}

function toServerError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return Errors.server(error instanceof Error ? error.message : String(error));
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw Errors.badRequest("The request body must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw Errors.badRequest("The request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function nonNegativeInt(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isSafeInteger(parsed)) {
    throw Errors.badRequest(`${label} must be a non-negative integer.`);
  }
  return parsed;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512) {
    throw Errors.badRequest(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function maxUploadBytes(env: Env): number {
  const parsed = Number.parseInt(env.MAX_UPLOAD_BYTES ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 524288000;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({ ok: true, service: "local-music-r2" }, 200, env);
    }

    if (!url.pathname.startsWith("/api/audio/")) {
      return errorResponse(Errors.badRequest("Unknown endpoint. Use one of the documented /api/audio/* routes."), env);
    }

    if (request.method !== "POST") {
      return errorResponse(Errors.badRequest("This endpoint only accepts POST."), env);
    }

    try {
      const user = await requireUser(request, env);
      const body = await readJson(request);

      switch (url.pathname) {
        case "/api/audio/upload-url":
          return json(await handleUploadUrl(body, env, user.userId), 200, env);
        case "/api/audio/complete":
          return json(await handleComplete(body, env, user.userId), 200, env);
        case "/api/audio/play-url":
          return json(await handlePlayUrl(body, env, user.userId), 200, env);
        case "/api/audio/delete":
          return json(await handleDelete(body, env, user.userId), 200, env);
        default:
          return errorResponse(Errors.badRequest("Unknown endpoint."), env);
      }
    } catch (error) {
      return errorResponse(error, env);
    }
  },
} satisfies ExportedHandler<Env>;

type UploadUrlRequest = {
  trackId?: unknown;
  fileName?: unknown;
  mimeType?: unknown;
  sizeBytes?: unknown;
  kind?: unknown;
};

async function handleUploadUrl(body: Record<string, unknown>, env: Env, userId: string) {
  const payload = body as UploadUrlRequest;
  const trackId = validateId(nonEmptyString(payload.trackId, "trackId"), "trackId");
  const fileName = nonEmptyString(payload.fileName, "fileName");
  const mimeType = nonEmptyString(payload.mimeType, "mimeType");
  const sizeBytes = nonNegativeInt(payload.sizeBytes, "sizeBytes");
  const kind = payload.kind === "artwork" ? "artwork" : "audio";

  const limit = maxUploadBytes(env);
  if (sizeBytes === 0 || sizeBytes > limit) {
    throw Errors.badRequest(`sizeBytes must be between 1 and ${limit}.`);
  }

  const extension = extensionFromFileName(fileName);
  const spec = kind === "artwork" ? KeySpec.artwork(userId, trackId, extension) : KeySpec.audio(userId, trackId, extension);

  // The declared type must be a real audio/image type consistent with the
  // extension; whatever survives this check is what gets signed.
  const contentType = contentTypeForUpload(spec.kind, extension, mimeType);
  const { url, expiresIn } = await presignPut(env, spec, contentType);
  const { token: uploadIntent } = await createUploadIntent(env, spec, sizeBytes, contentType, expiresIn);

  return {
    objectKey: spec.objectKey,
    uploadUrl: url,
    uploadIntent,
    expiresIn,
    /** Headers the client MUST send on the PUT for the signature to match. */
    requiredHeaders: { "content-type": contentType },
    kind,
  };
}

type CompleteRequest = {
  uploadIntent?: unknown;
  objectKey?: unknown;
  trackId?: unknown;
  sizeBytes?: unknown;
  mimeType?: unknown;
};

async function handleComplete(body: Record<string, unknown>, env: Env, userId: string) {
  const payload = body as CompleteRequest;
  let spec: KeySpec;
  let expectedSize: number;
  let expectedContentType: string;

  if (payload.uploadIntent) {
    const intent = await verifyUploadIntent(env, String(payload.uploadIntent), userId);
    spec = KeySpec.parseAndAuthorize(intent.objectKey, userId);
    expectedSize = intent.expectedSize;
    expectedContentType = intent.expectedContentType;

    if (payload.objectKey !== undefined) {
      const explicitKey = nonEmptyString(payload.objectKey, "objectKey");
      if (explicitKey !== intent.objectKey) {
        throw Errors.badRequest("The objectKey does not match the upload intent.");
      }
    }
    if (payload.trackId !== undefined) {
      const explicitTrackId = nonEmptyString(payload.trackId, "trackId");
      if (explicitTrackId !== intent.trackId) {
        throw Errors.badRequest("The trackId does not match the upload intent.");
      }
    }
  } else {
    // Legacy / direct completion path
    const objectKey = nonEmptyString(payload.objectKey, "objectKey");
    const sizeBytes = nonNegativeInt(payload.sizeBytes, "sizeBytes");
    const mimeType = nonEmptyString(payload.mimeType, "mimeType").trim().toLowerCase();
    const trackId = payload.trackId === undefined ? undefined : nonEmptyString(payload.trackId, "trackId");

    const limit = maxUploadBytes(env);
    if (sizeBytes > limit) throw Errors.tooLarge(limit);
    if (sizeBytes === 0) {
      throw Errors.badRequest("sizeBytes must be greater than zero.");
    }

    spec = KeySpec.parseAndAuthorize(objectKey, userId);
    if (trackId !== undefined && trackId !== spec.trackId) {
      throw Errors.badRequest("The object key does not match the reported track id.");
    }
    contentTypeForUpload(spec.kind, spec.extension, mimeType);
    expectedSize = sizeBytes;
    expectedContentType = mimeType;
  }

  const verified = await verifyObject(env, spec, expectedSize, expectedContentType);
  return { verified: true, objectKey: verified.objectKey, size: verified.size, etag: verified.etag, contentType: verified.contentType };
}

type PlayUrlRequest = {
  objectKey?: unknown;
};

async function handlePlayUrl(body: Record<string, unknown>, env: Env, userId: string) {
  const payload = body as PlayUrlRequest;
  const objectKey = nonEmptyString(payload.objectKey, "objectKey");
  const spec = KeySpec.parseAndAuthorize(objectKey, userId);

  if (!(await objectExists(env, spec))) {
    throw Errors.notFound("This track's cloud copy no longer exists. It may have been removed from another device.");
  }

  const { url, expiresIn } = await presignGet(env, spec);
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
  return { url, expiresIn, expiresAt, objectKey: spec.objectKey };
}

type DeleteRequest = {
  objectKey?: unknown;
  trackId?: unknown;
};

async function handleDelete(body: Record<string, unknown>, env: Env, userId: string) {
  const payload = body as DeleteRequest;
  let spec: KeySpec;

  if (payload.objectKey) {
    const objectKey = nonEmptyString(payload.objectKey, "objectKey");
    spec = KeySpec.parseAndAuthorize(objectKey, userId);
  } else if (payload.trackId) {
    const trackId = validateId(nonEmptyString(payload.trackId, "trackId"), "trackId");
    spec = KeySpec.audio(userId, trackId, "mp3");
  } else {
    throw Errors.badRequest("Either objectKey or trackId must be provided.");
  }

  const deleted = await deleteTrackObjects(env, spec);
  // Cloud metadata is removed by the client through its own RLS-scoped
  // deletes; this response lets it reconcile what is actually gone.
  return { deleted };
}
