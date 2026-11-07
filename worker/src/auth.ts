/**
 * Supabase access-token verification (spec §3).
 *
 * The browser is never trusted. A decoded JWT without a verified signature is
 * worthless here, and neither is a user id supplied by the client.
 *
 * Supported verification paths:
 *  1. Asymmetric verification (RS256, ES256, etc.) against the Supabase project's
 *     official JWKS endpoint (${SUPABASE_URL}/auth/v1/.well-known/jwks.json).
 *     This is the modern default for Supabase projects.
 *  2. Local HS256 signature verification against `SUPABASE_JWT_SECRET`
 *     (legacy projects with shared secret).
 *  3. Verification against the Supabase Auth service (`GET /auth/v1/user`),
 *     used when no JWT secret is configured for HS256 tokens.
 *
 * A token that fails validation yields 401. A verified token contributes
 * exactly one thing: the authenticated `sub` (user id), which scopes every
 * object key.
 */
import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  errors,
  jwtVerify,
  type JWTPayload,
} from "jose";
import { ApiError, Errors } from "./errors";
import type { Env } from "./env";

export type VerifiedUser = {
  userId: string;
  /** Which verification path accepted the token, for auditability. */
  verifiedBy: "jwks" | "jwt-secret" | "auth-service";
};

const CLOCK_SKEW_SECONDS = 30;
const textEncoder = new TextEncoder();

/** Explicitly allowed asymmetric algorithms supported via JWKS. */
const ALLOWED_ASYMMETRIC_ALGS = new Set([
  "RS256",
  "RS384",
  "RS512",
  "ES256",
  "ES384",
  "ES512",
  "PS256",
  "PS384",
  "PS512",
]);

/** Explicitly allowed symmetric algorithms supported via shared secret. */
const ALLOWED_SYMMETRIC_ALGS = new Set(["HS256"]);

/** JWKS cache per endpoint to respect rotation while caching reasonably. */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function getJwks(url: string) {
  let jwks = jwksCache.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url), {
      cacheMaxAge: 10 * 60 * 1000, // 10 minutes cache
      cooldownDuration: 250, // 250ms cooldown between re-fetches
    });
    jwksCache.set(url, jwks);
  }
  return jwks;
}

export function clearJwksCacheForTests(): void {
  jwksCache.clear();
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

/** Validates required Supabase claims on a verified payload. */
function validateClaims(payload: JWTPayload): string {
  const nowSeconds = Math.floor(Date.now() / 1000);

  // iat is mandatory
  const iat = asNumber(payload.iat);
  if (!Number.isFinite(iat)) {
    throw Errors.invalidToken("The sign-in token is missing its issued-at claim.");
  }
  if (iat > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw Errors.invalidToken("This sign-in token was issued in the future.");
  }

  // Only real, signed-in users may own cloud objects.
  if (typeof payload.role !== "string" || payload.role !== "authenticated") {
    throw Errors.invalidToken("This token does not represent a signed-in user.");
  }
  if (payload.is_anonymous === true) {
    throw Errors.invalidToken("Anonymous sessions cannot use cloud storage.");
  }

  const userId = payload.sub;
  if (typeof userId !== "string" || userId.trim().length === 0) {
    throw Errors.invalidToken("The verified token does not identify a user.");
  }
  return userId;
}

async function verifyWithJwks(
  token: string,
  alg: string,
  env: Env,
): Promise<VerifiedUser> {
  if (!env.SUPABASE_URL) {
    throw Errors.misconfigured("The Worker cannot verify token issuers because SUPABASE_URL is not configured.");
  }

  const expectedIssuer = `${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1`;
  const jwksUrl = env.SUPABASE_JWKS_URL || `${expectedIssuer}/.well-known/jwks.json`;
  const jwks = getJwks(jwksUrl);

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: expectedIssuer,
      audience: env.SUPABASE_JWT_AUDIENCE,
      algorithms: [alg], // Pin strictly to the declared supported algorithm
      clockTolerance: CLOCK_SKEW_SECONDS,
    });
    const userId = validateClaims(payload);
    return { userId, verifiedBy: "jwks" };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof errors.JWTExpired) {
      throw Errors.expiredToken();
    }
    if (error instanceof errors.JOSEError) {
      throw Errors.invalidToken(error.message);
    }
    // Network / fetch / JWKS retrieval failure - cannot verify token signature
    throw Errors.invalidToken("The sign-in authority's keys could not be reached to verify this token.");
  }
}

async function verifyWithJwtSecret(
  token: string,
  env: Env,
): Promise<VerifiedUser> {
  if (!env.SUPABASE_JWT_SECRET) {
    throw Errors.misconfigured("SUPABASE_JWT_SECRET is not configured on this Worker.");
  }
  if (!env.SUPABASE_URL) {
    throw Errors.misconfigured("The Worker cannot verify token issuers because SUPABASE_URL is not configured.");
  }

  const expectedIssuer = `${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1`;
  const secretBytes = textEncoder.encode(env.SUPABASE_JWT_SECRET);

  try {
    const { payload } = await jwtVerify(token, secretBytes, {
      issuer: expectedIssuer,
      audience: env.SUPABASE_JWT_AUDIENCE,
      algorithms: ["HS256"], // Pin strictly to HS256
      clockTolerance: CLOCK_SKEW_SECONDS,
    });
    const userId = validateClaims(payload);
    return { userId, verifiedBy: "jwt-secret" };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof errors.JWTExpired) {
      throw Errors.expiredToken();
    }
    if (error instanceof errors.JOSEError) {
      throw Errors.invalidToken(error.message);
    }
    throw Errors.invalidToken();
  }
}

/** Fallback: let the Supabase Auth service adjudicate legacy HS256 tokens. */
async function verifyWithAuthService(
  token: string,
  supabaseUrl: string,
  serviceKey: string,
): Promise<VerifiedUser> {
  let response: Response;
  try {
    response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/user`, {
      headers: { apikey: serviceKey, authorization: `Bearer ${token}` },
      cf: { cacheTtl: 0 },
    });
  } catch {
    throw Errors.server("The sign-in service could not be reached. Please try again.");
  }
  if (response.status === 401 || response.status === 403) {
    throw Errors.expiredToken();
  }
  if (!response.ok) {
    throw Errors.server("The sign-in service did not accept the token.");
  }

  let body: { id?: unknown; role?: unknown; is_anonymous?: unknown };
  try {
    body = (await response.json()) as { id?: unknown; role?: unknown; is_anonymous?: unknown };
  } catch {
    throw Errors.server("The sign-in service returned an unparseable response.");
  }

  // Reject anonymous sessions and non-authenticated roles
  if (body.role !== "authenticated") {
    throw Errors.invalidToken("This token does not represent a signed-in user.");
  }
  if (body.is_anonymous === true) {
    throw Errors.invalidToken("Anonymous sessions cannot use cloud storage.");
  }

  const userId = body.id;
  if (typeof userId !== "string" || userId.trim().length === 0) {
    throw Errors.invalidToken("The sign-in service did not return a user.");
  }
  return { userId, verifiedBy: "auth-service" };
}

/**
 * Extracts and verifies a Bearer token from the request. Throws an `ApiError`
 * (401/502) when the request is not authenticated.
 */
export async function requireUser(request: Request, env: Env): Promise<VerifiedUser> {
  const header = request.headers.get("authorization");
  if (!header) throw Errors.unauthorized();
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) throw Errors.unauthorized("The authorization header is malformed.");

  const token = match[1]!.trim();

  // Exactly three segments are required for a standard JWT (RFC 7519)
  const segments = token.split(".");
  if (segments.length !== 3 || !segments[0] || !segments[1] || !segments[2]) {
    throw Errors.invalidToken("The sign-in token must consist of exactly three segments.");
  }

  // Safely decode protected header
  let protectedHeader: { alg?: string; typ?: string; kid?: string };
  try {
    protectedHeader = decodeProtectedHeader(token);
  } catch {
    throw Errors.invalidToken("The sign-in token header is malformed.");
  }

  const alg = protectedHeader.alg;
  if (!alg || typeof alg !== "string") {
    throw Errors.invalidToken("The sign-in token header is missing an algorithm.");
  }

  // Reject unsupported algorithms, including 'none'
  if (ALLOWED_ASYMMETRIC_ALGS.has(alg)) {
    return verifyWithJwks(token, alg, env);
  }

  if (ALLOWED_SYMMETRIC_ALGS.has(alg)) {
    // If JWT secret is explicitly configured, use local HMAC
    if (env.SUPABASE_JWT_SECRET) {
      return verifyWithJwtSecret(token, env);
    }
    // Prefer official Auth service verification endpoint for shared-secret tokens without distributing secret
    if (env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
      return verifyWithAuthService(token, env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
    }
    throw Errors.misconfigured("HS256 verification is not configured on this Worker.");
  }

  throw Errors.invalidToken(`Unsupported token algorithm: ${alg}.`);
}

/**
 * Asserts that an `ApiError` carries a 401-class status. Exposed for tests
 * and for callers that want to distinguish auth failures from server errors.
 */
export function isAuthError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}
