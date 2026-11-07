import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createMockSupabaseServer,
  makeAsymmetricKeyPair,
  makeAsymmetricToken,
  makeToken,
  makeTokenWithDeclaredAlgorithm,
  startWorker,
  TEST_JWT_SECRET,
  unsignedToken,
  USER_A,
  USER_B,
  exportJWK,
  type TestContext,
  type WorkerResponse,
} from "./harness";

let ctx: TestContext | null = null;

beforeAll(async () => {
  ctx = await startWorker();
});
afterAll(async () => {
  await ctx?.mf.dispose();
  ctx = null;
});

/** Unauthenticated POST — responses are the auth gate's responsibility. */
async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<WorkerResponse> {
  const response = await ctx!.api(path, { body: JSON.stringify(body), headers });
  return response;
}

/** Authenticated POST as USER_A — used to reach the body-validation layer. */
async function postAsUser(path: string, body: unknown, headers: Record<string, string> = {}): Promise<WorkerResponse> {
  const token = await makeToken({ sub: USER_A });
  const response = await ctx!.api(path, { body: JSON.stringify(body), headers: { authorization: `Bearer ${token}`, ...headers } });
  return response;
}

function unauthorizedPath(path: string) {
  return async () => {
    const response = await post(path, { trackId: "track-1", fileName: "song.mp3", mimeType: "audio/mpeg", sizeBytes: 100 });
    expect(response.status).toBe(401);
  };
}

describe("authentication", () => {
  it("rejects an absent authorization header", unauthorizedPath("/api/audio/upload-url"));
  it("rejects a completions call without an authorization header", unauthorizedPath("/api/audio/complete"));
  it("rejects a play-url call without an authorization header", unauthorizedPath("/api/audio/play-url"));
  it("rejects a delete call without an authorization header", unauthorizedPath("/api/audio/delete"));

  it("rejects a malformed header", async () => {
    const response = await post(
      "/api/audio/upload-url",
      { trackId: "track-1", fileName: "song.mp3", mimeType: "audio/mpeg", sizeBytes: 100 },
      { authorization: "Bearer" },
    );
    expect(response.status).toBe(401);
  });

  it("rejects a decoded-but-unsigned JWT", async () => {
    const response = await post(
      "/api/audio/upload-url",
      { trackId: "track-1", fileName: "song.mp3", mimeType: "audio/mpeg", sizeBytes: 100 },
      { authorization: `Bearer ${unsignedToken({ sub: USER_A })}` },
    );
    expect(response.status).toBe(401);
  });

  it("rejects a JWT signed with the wrong secret", async () => {
    const token = await makeToken({ sub: USER_A }, "wrong-secret");
    const response = await post(
      "/api/audio/upload-url",
      { trackId: "track-1", fileName: "song.mp3", mimeType: "audio/mpeg", sizeBytes: 100 },
      { authorization: `Bearer ${token}` },
    );
    expect(response.status).toBe(401);
  });

  it("rejects an expired JWT", async () => {
    const token = await makeToken({ sub: USER_A, exp: Math.floor(Date.now() / 1000) - 3600 });
    const response = await post(
      "/api/audio/upload-url",
      { trackId: "track-1", fileName: "song.mp3", mimeType: "audio/mpeg", sizeBytes: 100 },
      { authorization: `Bearer ${token}` },
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("expired-token");
  });

  it("accepts a valid token signed with the configured secret", async () => {
    const token = await makeToken({ sub: USER_A }, TEST_JWT_SECRET);
    const response = await post(
      "/api/audio/upload-url",
      { trackId: "track-1", fileName: "song.mp3", mimeType: "audio/mpeg", sizeBytes: 100 },
      { authorization: `Bearer ${token}` },
    );
    expect(response.status).toBe(200);
  });

  it("returns actionable error bodies for unauthorized requests", async () => {
    const response = await post("/api/audio/upload-url", {});
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.message.length).toBeGreaterThan(0);
  });
});


describe("token algorithm and claim validation", () => {
  // A request body shared by every case in this block.
  const body = JSON.stringify({ trackId: "track-1", fileName: "song.mp3", mimeType: "audio/mpeg", sizeBytes: 10 });

  const postToken = async (token: string): Promise<WorkerResponse> =>
    ctx!.api("/api/audio/upload-url", { body, headers: { authorization: `Bearer ${token}` } });

  it("rejects a token that declares the none algorithm", async () => {
    const token = await makeTokenWithDeclaredAlgorithm("none", { sub: USER_A, role: "authenticated" });
    expect((await postToken(token)).status).toBe(401);
  });

  it("rejects an HS256-signed token whose header declares RS256 (algorithm confusion)", async () => {
    // A correct HMAC signature under a deliberately wrong declared algorithm:
    // the verifier must not let the header choose how the signature is checked.
    const token = await makeTokenWithDeclaredAlgorithm("RS256", {
      sub: USER_A,
      role: "authenticated",
      iat: Math.floor(Date.now() / 1000),
    });
    expect((await postToken(token)).status).toBe(401);
  });

  it("rejects the publishable anon key presented as a user token", async () => {
    // The anon key is a real JWT signed with the same project secret; only
    // the role claim separates it from a session token.
    const token = await makeToken({ sub: USER_A, role: "anon" });
    expect((await postToken(token)).status).toBe(401);
  });

  it("rejects a token that carries a service role", async () => {
    const token = await makeToken({ sub: USER_A, role: "service_role" });
    expect((await postToken(token)).status).toBe(401);
  });

  it("rejects an anonymous-auth user", async () => {
    const token = await makeToken({ sub: USER_A, is_anonymous: true });
    expect((await postToken(token)).status).toBe(401);
  });

  it("rejects a properly signed token from an unknown issuer", async () => {
    const token = await makeToken({ sub: USER_A, iss: "https://evil.example/auth/v1" });
    expect((await postToken(token)).status).toBe(401);
  });

  it("rejects a token without an issued-at claim", async () => {
    const token = await makeTokenWithDeclaredAlgorithm("HS256", {
      sub: USER_A,
      role: "authenticated",
      iss: "https://test.supabase.co/auth/v1",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    expect((await postToken(token)).status).toBe(401);
  });

  it("rejects a token issued in the future", async () => {
    const token = await makeToken({ sub: USER_A, iat: Math.floor(Date.now() / 1000) + 3600 });
    expect((await postToken(token)).status).toBe(401);
  });

  it("rejects a token that is not valid yet", async () => {
    const token = await makeToken({ sub: USER_A, nbf: Math.floor(Date.now() / 1000) + 3600 });
    expect((await postToken(token)).status).toBe(401);
  });
});

describe("token audience (opt-in)", () => {
  const body = JSON.stringify({ trackId: "track-1", fileName: "song.mp3", mimeType: "audio/mpeg", sizeBytes: 10 });

  it("accepts a token whose audience matches the configured value", async () => {
    const audienceWorker = await startWorker({ SUPABASE_JWT_AUDIENCE: "local-music-r2" });
    try {
      const token = await makeToken({ sub: USER_A, aud: "local-music-r2" });
      const response = await audienceWorker.api("/api/audio/upload-url", {
        body,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
    } finally {
      await audienceWorker.mf.dispose();
    }
  });

  it("rejects a token whose audience differs from the configured value", async () => {
    const audienceWorker = await startWorker({ SUPABASE_JWT_AUDIENCE: "local-music-r2" });
    try {
      const token = await makeToken({ sub: USER_A, aud: "somebody-else" });
      const response = await audienceWorker.api("/api/audio/upload-url", {
        body,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(401);
    } finally {
      await audienceWorker.mf.dispose();
    }
  });

  it("rejects a token with no audience when one is required", async () => {
    const audienceWorker = await startWorker({ SUPABASE_JWT_AUDIENCE: "local-music-r2" });
    try {
      // A default token (no aud claim) is good for everything except audience.
      const token = await makeToken({ sub: USER_A });
      const response = await audienceWorker.api("/api/audio/upload-url", {
        body,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(401);
    } finally {
      await audienceWorker.mf.dispose();
    }
  });
});

describe("request validation", () => {
  it("rejects a body that is not JSON", async () => {
    const response = await ctx!.api("/api/audio/upload-url", {
      userId: USER_A,
      body: "not json",
      headers: { "content-type": "text/plain" },
    });
    expect(response.status).toBe(400);
  });

  it("rejects missing required fields", async () => {
    const response = await postAsUser("/api/audio/upload-url", { trackId: "track-1" });
    // authenticated, but fileName/mimeType/sizeBytes are absent
    expect(response.status).toBe(400);
  });

  it("rejects unknown endpoints", async () => {
    const response = await postAsUser("/api/audio/nope", {});
    expect(response.status).toBe(400);
  });

  it("answers the unauthenticated health check", async () => {
    const response = await ctx!.api("/api/health", { method: "GET" });
    expect(response.status).toBe(200);
  });

  it("answers CORS preflight requests", async () => {
    const response = await ctx!.api("/api/audio/upload-url", { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBeDefined();
  });
});

describe("JWT segment structure and malformed token handling", () => {
  const reqBody = JSON.stringify({ trackId: "track-seg-1", fileName: "song.mp3", mimeType: "audio/mpeg", sizeBytes: 10 });
  const postWithToken = (token: string) =>
    ctx!.api("/api/audio/upload-url", { body: reqBody, headers: { authorization: `Bearer ${token}` } });

  it("rejects a token with only 1 segment with 401", async () => {
    const res = await postWithToken("only-one-segment");
    expect(res.status).toBe(401);
  });

  it("rejects a token with only 2 segments with 401", async () => {
    const res = await postWithToken("segment1.segment2");
    expect(res.status).toBe(401);
  });

  it("rejects a token with 4 segments with 401", async () => {
    const res = await postWithToken("seg1.seg2.seg3.seg4");
    expect(res.status).toBe(401);
  });

  it("rejects a token with empty segments like '..'", async () => {
    const res = await postWithToken("..");
    expect(res.status).toBe(401);
  });

  it("rejects completely invalid/malformed base64 with 401 instead of 500", async () => {
    const res = await postWithToken("%%%invalid%%%.***bad***.###fail###");
    expect(res.status).toBe(401);
  });
});

describe("Asymmetric JWT verification against official JWKS", () => {
  const body = JSON.stringify({ trackId: "track-asym-1", fileName: "song.mp3", mimeType: "audio/mpeg", sizeBytes: 100 });

  it("accepts a valid RS256 token verified against the project's official JWKS endpoint", async () => {
    const keyPair = await makeAsymmetricKeyPair();
    const publicJwk = await exportJWK(keyPair.publicKey);
    publicJwk.kid = "key-1";
    publicJwk.alg = "RS256";

    const mockServer = await createMockSupabaseServer([publicJwk]);
    const worker = await startWorker({
      SUPABASE_URL: mockServer.url,
      SUPABASE_JWT_SECRET: undefined, // no HS256 secret!
    });

    try {
      const token = await makeAsymmetricToken(keyPair, {
        sub: USER_A,
        iss: `${mockServer.url}/auth/v1`,
        kid: "key-1",
      });

      const response = await worker.api("/api/audio/upload-url", {
        body,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      const json = (await response.json()) as { objectKey: string };
      expect(json.objectKey).toBe(`users/${USER_A}/tracks/track-asym-1/audio.mp3`);
    } finally {
      await worker.mf.dispose();
      await mockServer.close();
    }
  });

  it("rejects an RS256 token signed by an unknown private key", async () => {
    const registeredKeyPair = await makeAsymmetricKeyPair();
    const rogueKeyPair = await makeAsymmetricKeyPair();

    const registeredJwk = await exportJWK(registeredKeyPair.publicKey);
    registeredJwk.kid = "key-reg";

    const mockServer = await createMockSupabaseServer([registeredJwk]);
    const worker = await startWorker({
      SUPABASE_URL: mockServer.url,
      SUPABASE_JWT_SECRET: undefined,
    });

    try {
      const rogueToken = await makeAsymmetricToken(rogueKeyPair, {
        sub: USER_A,
        iss: `${mockServer.url}/auth/v1`,
        kid: "key-rogue",
      });

      const response = await worker.api("/api/audio/upload-url", {
        body,
        headers: { authorization: `Bearer ${rogueToken}` },
      });
      expect(response.status).toBe(401);
    } finally {
      await worker.mf.dispose();
      await mockServer.close();
    }
  });

  it("rejects an expired asymmetric token with 401 and code 'expired-token'", async () => {
    const keyPair = await makeAsymmetricKeyPair();
    const publicJwk = await exportJWK(keyPair.publicKey);
    publicJwk.kid = "key-exp";

    const mockServer = await createMockSupabaseServer([publicJwk]);
    const worker = await startWorker({
      SUPABASE_URL: mockServer.url,
      SUPABASE_JWT_SECRET: undefined,
    });

    try {
      const expiredToken = await makeAsymmetricToken(keyPair, {
        sub: USER_A,
        iss: `${mockServer.url}/auth/v1`,
        kid: "key-exp",
        exp: Math.floor(Date.now() / 1000) - 300,
      });

      const response = await worker.api("/api/audio/upload-url", {
        body,
        headers: { authorization: `Bearer ${expiredToken}` },
      });
      expect(response.status).toBe(401);
      const json = (await response.json()) as { error: { code: string } };
      expect(json.error.code).toBe("expired-token");
    } finally {
      await worker.mf.dispose();
      await mockServer.close();
    }
  });

  it("rejects an asymmetric token from wrong issuer", async () => {
    const keyPair = await makeAsymmetricKeyPair();
    const publicJwk = await exportJWK(keyPair.publicKey);
    publicJwk.kid = "key-iss";

    const mockServer = await createMockSupabaseServer([publicJwk]);
    const worker = await startWorker({
      SUPABASE_URL: mockServer.url,
      SUPABASE_JWT_SECRET: undefined,
    });

    try {
      const token = await makeAsymmetricToken(keyPair, {
        sub: USER_A,
        iss: "https://impostor.supabase.co/auth/v1",
        kid: "key-iss",
      });

      const response = await worker.api("/api/audio/upload-url", {
        body,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(401);
    } finally {
      await worker.mf.dispose();
      await mockServer.close();
    }
  });

  it("rejects an anonymous user in asymmetric token", async () => {
    const keyPair = await makeAsymmetricKeyPair();
    const publicJwk = await exportJWK(keyPair.publicKey);
    publicJwk.kid = "key-anon";

    const mockServer = await createMockSupabaseServer([publicJwk]);
    const worker = await startWorker({
      SUPABASE_URL: mockServer.url,
      SUPABASE_JWT_SECRET: undefined,
    });

    try {
      const token = await makeAsymmetricToken(keyPair, {
        sub: USER_A,
        iss: `${mockServer.url}/auth/v1`,
        kid: "key-anon",
        is_anonymous: true,
      });

      const response = await worker.api("/api/audio/upload-url", {
        body,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(401);
    } finally {
      await worker.mf.dispose();
      await mockServer.close();
    }
  });

  it("handles key rotation gracefully via JWKS cache re-fetch", async () => {
    const keyPair1 = await makeAsymmetricKeyPair();
    const keyPair2 = await makeAsymmetricKeyPair();

    const jwk1 = await exportJWK(keyPair1.publicKey);
    jwk1.kid = "key-1";
    const jwk2 = await exportJWK(keyPair2.publicKey);
    jwk2.kid = "key-2";

    const mockServer = await createMockSupabaseServer([jwk1]);
    const worker = await startWorker({
      SUPABASE_URL: mockServer.url,
      SUPABASE_JWT_SECRET: undefined,
    });

    try {
      // First token with key-1 succeeds
      const token1 = await makeAsymmetricToken(keyPair1, {
        sub: USER_A,
        iss: `${mockServer.url}/auth/v1`,
        kid: "key-1",
      });
      const res1 = await worker.api("/api/audio/upload-url", {
        body,
        headers: { authorization: `Bearer ${token1}` },
      });
      expect(res1.status).toBe(200);

      // Rotate keys in JWKS
      mockServer.setJwksKeys([jwk1, jwk2]);
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Token signed with rotated key-2 succeeds
      const token2 = await makeAsymmetricToken(keyPair2, {
        sub: USER_B,
        iss: `${mockServer.url}/auth/v1`,
        kid: "key-2",
      });
      const res2 = await worker.api("/api/audio/upload-url", {
        body,
        headers: { authorization: `Bearer ${token2}` },
      });
      expect(res2.status).toBe(200);
      const json = (await res2.json()) as { objectKey: string };
      expect(json.objectKey).toBe(`users/${USER_B}/tracks/track-asym-1/audio.mp3`);
    } finally {
      await worker.mf.dispose();
      await mockServer.close();
    }
  });
});

describe("Auth-service fallback for legacy tokens", () => {
  const body = JSON.stringify({ trackId: "track-fb-1", fileName: "song.mp3", mimeType: "audio/mpeg", sizeBytes: 100 });

  it("accepts a legacy HS256 token via official Supabase Auth user endpoint when no JWT secret is configured", async () => {
    const mockServer = await createMockSupabaseServer();
    const worker = await startWorker({
      SUPABASE_URL: mockServer.url,
      SUPABASE_JWT_SECRET: undefined, // no local secret
      SUPABASE_ANON_KEY: "anon-key",
    });

    try {
      const token = await makeToken({ sub: USER_A });
      const response = await worker.api("/api/audio/upload-url", {
        body,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
    } finally {
      await worker.mf.dispose();
      await mockServer.close();
    }
  });

  it("rejects an anonymous user returned by the Auth-service fallback", async () => {
    const mockServer = await createMockSupabaseServer();
    mockServer.setUserHandler(() => ({
      status: 200,
      body: { id: USER_A, role: "authenticated", is_anonymous: true },
    }));

    const worker = await startWorker({
      SUPABASE_URL: mockServer.url,
      SUPABASE_JWT_SECRET: undefined,
      SUPABASE_ANON_KEY: "anon-key",
    });

    try {
      const token = await makeToken({ sub: USER_A });
      const response = await worker.api("/api/audio/upload-url", {
        body,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(401);
    } finally {
      await worker.mf.dispose();
      await mockServer.close();
    }
  });

  it("rejects when the Auth-service returns 401", async () => {
    const mockServer = await createMockSupabaseServer();
    mockServer.setUserHandler(() => ({
      status: 401,
      body: { message: "Invalid token" },
    }));

    const worker = await startWorker({
      SUPABASE_URL: mockServer.url,
      SUPABASE_JWT_SECRET: undefined,
      SUPABASE_ANON_KEY: "anon-key",
    });

    try {
      const token = await makeToken({ sub: USER_A });
      const response = await worker.api("/api/audio/upload-url", {
        body,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(401);
    } finally {
      await worker.mf.dispose();
      await mockServer.close();
    }
  });
});
