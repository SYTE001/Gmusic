import { Errors } from "./errors";
import { KeySpec, type ObjectKind } from "./keys";
import type { Env } from "./env";

export type UploadIntentPayload = {
  intentId: string;
  userId: string;
  trackId: string;
  objectKey: string;
  kind: ObjectKind;
  expectedSize: number;
  expectedContentType: string;
  expiresAt: number;
};

function base64UrlEncode(bytes: Uint8Array | string): string {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (str.length % 4)) % 4);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function getIntentSecret(env: Env): string {
  const secret = env.INTENT_SECRET || env.R2_SECRET_ACCESS_KEY || env.SUPABASE_JWT_SECRET || "local-music-upload-intent";
  return secret;
}

async function getHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createUploadIntent(
  env: Env,
  spec: KeySpec,
  expectedSize: number,
  expectedContentType: string,
  expiresInSeconds: number,
): Promise<{ token: string; payload: UploadIntentPayload }> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + expiresInSeconds;
  const payload: UploadIntentPayload = {
    intentId: crypto.randomUUID(),
    userId: spec.userId,
    trackId: spec.trackId,
    objectKey: spec.objectKey,
    kind: spec.kind,
    expectedSize,
    expectedContentType,
    expiresAt,
  };

  const payloadJson = JSON.stringify(payload);
  const key = await getHmacKey(getIntentSecret(env));
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadJson)),
  );

  const token = `${base64UrlEncode(payloadJson)}.${base64UrlEncode(signature)}`;
  return { token, payload };
}

export async function verifyUploadIntent(
  env: Env,
  token: string,
  authenticatedUserId: string,
): Promise<UploadIntentPayload> {
  if (typeof token !== "string" || !token.includes(".")) {
    throw Errors.badRequest("Invalid upload intent token format.");
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    throw Errors.badRequest("Invalid upload intent token structure.");
  }

  const [encodedPayload, encodedSig] = parts;
  let payloadBytes: Uint8Array;
  let signatureBytes: Uint8Array;
  try {
    payloadBytes = base64UrlDecode(encodedPayload);
    signatureBytes = base64UrlDecode(encodedSig);
  } catch {
    throw Errors.badRequest("Malformed upload intent token encoding.");
  }

  const key = await getHmacKey(getIntentSecret(env));
  const valid = await crypto.subtle.verify("HMAC", key, signatureBytes, payloadBytes);
  if (!valid) {
    throw Errors.badRequest("Upload intent signature is invalid or tampered with.");
  }

  let payload: UploadIntentPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as UploadIntentPayload;
  } catch {
    throw Errors.badRequest("Upload intent payload is corrupt.");
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.expiresAt < now) {
    throw Errors.uploadUnverified("The upload intent has expired. Please request a new upload URL.");
  }

  if (payload.userId !== authenticatedUserId) {
    throw Errors.forbidden();
  }

  // Validate KeySpec structure
  KeySpec.parseAndAuthorize(payload.objectKey, authenticatedUserId);

  return payload;
}
