/**
 * Object-key handling (spec §3).
 *
 * Keys are ALWAYS constructed and validated on the server. The browser may
 * only propose a track id and a file name; it never supplies a key. Personal
 * audio lives under a per-user prefix so R2 keys alone encode ownership:
 *
 *   users/{userId}/tracks/{trackId}/audio.{ext}
 *   users/{userId}/tracks/{trackId}/artwork.{ext}
 */

import { ApiError } from "./errors";

/** Characters allowed in ids. Local Music ids are UUIDs or `id-...` tokens. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Extensions the app considers audio, matching the frontend import picker. */
const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  "mp3", "m4a", "m4b", "aac", "wav", "wave", "ogg", "oga", "opus", "flac", "webm", "weba", "mp4",
]);

/** Extensions accepted for artwork objects. */
const ARTWORK_EXTENSIONS: ReadonlySet<string> = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

export type ObjectKind = "audio" | "artwork";

/**
 * Content types accepted per extension (spec §3 hardening). The declared type
 * must be a real audio/image type AND consistent with the file's extension, so
 * a “song.mp3” cannot be stored as text/html or application/octet-stream.
 * Sets keep the lookup O(1) and the coverage explicit.
 */
const AUDIO_MIME_BY_EXTENSION: Readonly<Record<string, ReadonlySet<string>>> = {
  mp3: new Set(["audio/mpeg", "audio/mp3"]),
  m4a: new Set(["audio/mp4", "audio/m4a", "audio/x-m4a", "video/mp4"]),
  m4b: new Set(["audio/mp4", "audio/x-m4b", "video/mp4"]),
  aac: new Set(["audio/aac", "audio/x-aac", "audio/x-hx-aac-adts"]),
  wav: new Set(["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"]),
  wave: new Set(["audio/wav", "audio/x-wav", "audio/wave"]),
  ogg: new Set(["audio/ogg", "application/ogg", "audio/x-ogg"]),
  oga: new Set(["audio/ogg", "application/ogg"]),
  opus: new Set(["audio/ogg", "audio/opus", "audio/iopus", "application/ogg"]),
  flac: new Set(["audio/flac", "audio/x-flac", "application/flac"]),
  weba: new Set(["audio/webm", "audio/x-webm"]),
  webm: new Set(["audio/webm", "video/webm", "application/webm"]),
  mp4: new Set(["audio/mp4", "video/mp4"]),
};

const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, ReadonlySet<string>>> = {
  jpg: new Set(["image/jpeg"]),
  jpeg: new Set(["image/jpeg"]),
  png: new Set(["image/png"]),
  webp: new Set(["image/webp"]),
  gif: new Set(["image/gif"]),
};

/** Content types this service will ever sign an upload for. */
export function allowedMimeTypes(kind: ObjectKind): readonly string[] {
  const table: Readonly<Record<string, ReadonlySet<string>>> = kind === "audio" ? AUDIO_MIME_BY_EXTENSION : IMAGE_MIME_BY_EXTENSION;
  return Object.values(table).flatMap((types) => [...types]);
}

/**
 * Validates the client-declared content type against the extension allow-list
 * and returns the canonical (lowercased) type to sign. Throws 400 with the
 * accepted types so the caller can fix the request rather than guess.
 */
export function contentTypeForUpload(kind: ObjectKind, extension: string, declaredMimeType: string): string {
  const table: Readonly<Record<string, ReadonlySet<string>>> = kind === "audio" ? AUDIO_MIME_BY_EXTENSION : IMAGE_MIME_BY_EXTENSION;
  const allowed = table[extension];
  const normalized = declaredMimeType.trim().toLowerCase();
  if (normalized.length === 0) {
    throw new ApiError(
      400,
      "bad-request",
      "A content type is required for uploads; send the file's real MIME type.",
    );
  }
  if (normalized === "application/octet-stream" || normalized === "binary/octet-stream") {
    throw new ApiError(
      400,
      "bad-request",
      `A generic content type (${normalized}) is not accepted. Use the file's real type, e.g. ${canonicalExample(kind)}.`,
    );
  }
  if (!allowed || !allowed.has(normalized)) {
    const expected = allowed ? [...allowed].join(", ") : allowedMimeTypes(kind).slice(0, 4).join(", ");
    throw new ApiError(
      400,
      "bad-request",
      `Content type “${normalized}” is not accepted for a .${extension} ${kind} upload. Expected one of: ${expected}.`,
    );
  }
  return normalized;
}

function canonicalExample(kind: ObjectKind): string {
  return kind === "audio" ? "audio/mpeg for .mp3" : "image/jpeg for .jpg";
}

export class KeySpec {
  private constructor(
    readonly userId: string,
    readonly trackId: string,
    readonly kind: ObjectKind,
    readonly extension: string,
  ) {}

  get objectKey(): string {
    return `users/${this.userId}/tracks/${this.trackId}/${this.kind}.${this.extension}`;
  }

  /** Prefix covering every object that belongs to this track. */
  get trackPrefix(): string {
    return `users/${this.userId}/tracks/${this.trackId}/`;
  }

  toString(): string {
    return this.objectKey;
  }

  static audio(userId: string, trackId: string, extension: string): KeySpec {
    return new KeySpec(validateId(userId, "user id"), validateId(trackId, "track id"), "audio", validateExtension(extension, AUDIO_EXTENSIONS));
  }

  static artwork(userId: string, trackId: string, extension: string): KeySpec {
    return new KeySpec(
      validateId(userId, "user id"),
      validateId(trackId, "track id"),
      "artwork",
      validateExtension(extension, ARTWORK_EXTENSIONS),
    );
  }

  /**
   * Parses a caller-supplied key and ensures it belongs to `userId`.
   * Throws when the shape is wrong or the key belongs to another user.
   */
  static parseAndAuthorize(objectKey: string, userId: string): KeySpec {
    const parts = objectKey.split("/");
    if (parts.length !== 5) throw invalidKey();
    const [users, owner, tracks, trackId, file] = parts;
    if (users !== "users" || tracks !== "tracks") throw invalidKey();
    if (!ID_PATTERN.test(owner ?? "") || !ID_PATTERN.test(trackId ?? "")) throw invalidKey();
    if (owner !== userId) throw invalidKey(); // cross-user access is never authorized
    const dot = file.lastIndexOf(".");
    if (dot <= 0 || dot === file.length - 1) throw invalidKey();
    const kind = file.slice(0, dot);
    const extension = file.slice(dot + 1).toLowerCase();
    if (kind !== "audio" && kind !== "artwork") throw invalidKey();
    const allowed = kind === "audio" ? AUDIO_EXTENSIONS : ARTWORK_EXTENSIONS;
    if (!allowed.has(extension)) throw invalidKey();
    return new KeySpec(owner, trackId, kind, extension);
  }
}

function invalidKey(): ApiError {
  return new ApiError(403, "invalid-object-key", "This object does not belong to your account.");
}

export function validateId(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new ApiError(400, "bad-request", `Invalid ${label}.`);
  }
  return value;
}

function validateExtension(extension: string, allowed: ReadonlySet<string>): string {
  const normalized = extension.toLowerCase();
  if (!allowed.has(normalized)) {
    throw new ApiError(400, "bad-request", `Unsupported file type “.${extension}”. Supported: ${[...allowed].map((e) => `.${e}`).join(", ")}.`);
  }
  return normalized;
}

/** Deterministic, allow-listed extension from a file name. */
export function extensionFromFileName(fileName: string): string {
  const match = fileName.match(/\.([^.]+)$/);
  return match ? match[1].toLowerCase() : "";
}

export function allowedExtensionsFor(kind: ObjectKind): readonly string[] {
  return kind === "audio" ? [...AUDIO_EXTENSIONS] : [...ARTWORK_EXTENSIONS];
}
