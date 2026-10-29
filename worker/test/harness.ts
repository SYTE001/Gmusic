/**
 * Shared harness: runs the Worker inside Miniflare with an in-memory R2
 * bucket and a known test JWT secret, so auth and object handling can be
 * exercised end to end without any real cloud credentials.
 */
import { Miniflare } from "miniflare";
import { createServer, type Server } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
export { exportJWK };
import type { Env } from "../src/env";

export const TEST_JWT_SECRET = "test-jwt-secret-do-not-use-in-production";
export const TEST_ACCOUNT_ID = "test-account-id";
export const TEST_ACCESS_KEY_ID = "test-access-key-id";
export const TEST_SECRET_ACCESS_KEY = "test-secret-access-key";
export const TEST_ANON_KEY = "test-anon-key";
/** A Supabase user id — the only id any request may ever act on. */
export const USER_A = "11111111-1111-1111-1111-111111111111";
export const USER_B = "22222222-2222-2222-2222-222222222222";

export type TestContext = {
  mf: Miniflare;
  /** Fetches against the Worker as a given user (or anonymous when omitted). */
  api: (path: string, init?: { method?: string; headers?: Record<string, string>; body?: string | null; userId?: string }) => Promise<WorkerResponse>;
  /** Raw R2 access for seeding assertions. */
  bucket: R2Bucket;
};

/**
 * Structural view of a fetch response. Declared locally so the Worker's
 * ambient types (from @cloudflare/workers-types) never clash with Node's.
 */
export type WorkerResponse = {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  headers: { get(name: string): string | null };
};

function base64UrlEncode(bytes: Uint8Array | string): string {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Mints an HS256 JWT the way Supabase does: role "authenticated", an issued-at
 * claim, and the project's auth/v1 issuer. Tests use this to build valid
 * tokens (and, deliberately, invalid, expired, and mistrusted ones).
 */
export async function makeAsymmetricKeyPair() {
  return generateKeyPair("RS256");
}

export async function makeAsymmetricToken(
  keyPair: { privateKey: CryptoKey },
  claims: {
    sub: string;
    exp?: number;
    iat?: number;
    nbf?: number;
    iss?: string;
    role?: string;
    aud?: string | string[];
    is_anonymous?: boolean;
    kid?: string;
  },
  alg: string = "RS256",
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({
    iss: claims.iss ?? "https://test.supabase.co/auth/v1",
    role: "authenticated",
    iat: now,
    ...claims,
  })
    .setProtectedHeader({ alg, typ: "JWT", kid: claims.kid ?? "key-1" })
    .setExpirationTime(claims.exp ?? now + 3600);

  if (claims.nbf !== undefined) {
    jwt.setNotBefore(claims.nbf);
  }
  if (claims.aud !== undefined) {
    jwt.setAudience(claims.aud);
  }
  if (claims.iss !== undefined) {
    jwt.setIssuer(claims.iss);
  }
  if (claims.sub !== undefined) {
    jwt.setSubject(claims.sub);
  }
  return jwt.sign(keyPair.privateKey);
}

export type MockSupabaseServer = {
  url: string;
  server: Server;
  setJwksKeys: (keys: unknown[]) => void;
  setUserHandler: (handler: (reqHeaders: Record<string, string>) => { status: number; body: unknown }) => void;
  close: () => Promise<void>;
};

export async function createMockSupabaseServer(initialKeys: unknown[] = []): Promise<MockSupabaseServer> {
  let jwksKeys = [...initialKeys];
  let userHandler: (reqHeaders: Record<string, string>) => { status: number; body: unknown } = () => ({
    status: 200,
    body: { id: USER_A, role: "authenticated", is_anonymous: false },
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname === "/auth/v1/.well-known/jwks.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: jwksKeys }));
      return;
    }
    if (url.pathname === "/auth/v1/user") {
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(",") : v ?? ""]),
      );
      const result = userHandler(headers);
      res.writeHead(result.status, { "content-type": "application/json" });
      res.end(JSON.stringify(result.body));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    server,
    setJwksKeys: (keys) => {
      jwksKeys = [...keys];
    },
    setUserHandler: (handler) => {
      userHandler = handler;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function makeToken(
  claims: {
    sub: string;
    exp?: number;
    iat?: number;
    nbf?: number;
    iss?: string;
    role?: string;
    aud?: string | string[];
    is_anonymous?: boolean;
  },
  secret: string = TEST_JWT_SECRET,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signWith(
    { alg: "HS256", typ: "JWT" },
    {
      iss: "https://test.supabase.co/auth/v1",
      role: "authenticated",
      iat: now,
      ...claims,
      exp: claims.exp ?? now + 3600,
    },
    secret,
  );
}

/** Mints a token whose header can claim anything — used for algorithm-confusion tests. */
export async function makeTokenWithDeclaredAlgorithm(
  alg: string,
  claims: Record<string, unknown>,
  secret: string = TEST_JWT_SECRET,
): Promise<string> {
  return signWith({ alg, typ: "JWT" }, claims, secret);
}

async function signWith(header: Record<string, unknown>, payload: Record<string, unknown>, secret: string): Promise<string> {
  const headerSegment = base64UrlEncode(JSON.stringify(header));
  const payloadSegment = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerSegment}.${payloadSegment}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput)));
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

/** Builds the same env object the Worker receives in production. */
function envFor(overrides: Partial<Env> = {}): Env {
  const env: Env = {
    R2_BUCKET: undefined as unknown as R2Bucket, // supplied by the R2 binding
    R2_ACCOUNT_ID: TEST_ACCOUNT_ID,
    R2_ACCESS_KEY_ID: TEST_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: TEST_SECRET_ACCESS_KEY,
    SUPABASE_URL: "https://test.supabase.co",
    SUPABASE_JWT_SECRET: TEST_JWT_SECRET,
    SUPABASE_ANON_KEY: TEST_ANON_KEY,
    R2_BUCKET_NAME: "local-music-media",
    ALLOWED_ORIGIN: "http://localhost:5173",
    MAX_UPLOAD_BYTES: "524288000",
    PUT_URL_TTL_SECONDS: "120",
    GET_URL_TTL_SECONDS: "300",
    ...overrides,
  };
  // The bucket comes from the r2Buckets binding, not from `bindings`.
  const { R2_BUCKET: _ignored, ...bindings } = env;
  const cleanBindings = Object.fromEntries(
    Object.entries(bindings).filter(([_, v]) => v !== undefined),
  );
  return cleanBindings as unknown as Env;
}

export async function startWorker(overrides: Partial<Env> = {}): Promise<TestContext> {
  const env = envFor(overrides);
  const mf = new Miniflare({
    modules: true,
    // Tests run against the esbuild bundle (npm run build) so the harness
    // exercises exactly what wrangler would deploy.
    scriptPath: "dist/index.js",
    compatibilityDate: "2024-11-06",
    compatibilityFlags: ["nodejs_compat"],
    bindings: env as never,
    r2Buckets: ["R2_BUCKET"],
  });
  await mf.ready;

  const api = async (
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string | null; userId?: string } = {},
  ): Promise<WorkerResponse> => {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    headers["content-type"] = "application/json";
    if (init.userId) {
      headers.authorization = `Bearer ${await makeToken({ sub: init.userId })}`;
    }
    const raw = await mf.dispatchFetch(`http://localhost${path}`, {
      method: init.method ?? "POST",
      headers: Object.entries(headers),
      body: init.body ?? null,
    } as never);
    return raw as unknown as WorkerResponse;
  };

  const bucket = (await mf.getR2Bucket("R2_BUCKET")) as R2Bucket;
  return { mf, api, bucket };
}

/** Helper for tests that need a bare (unverified) token string. */
export function unsignedToken(claims: Record<string, unknown>): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64UrlEncode(JSON.stringify(claims));
  return `${header}.${payload}.bm90LXNpZ25lZA`;
}
