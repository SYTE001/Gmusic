import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Worker itself is covered by worker/test; these tests pin the browser-
 * side contract of r2StorageService: caching, expiry, refresh, dedupe, and
 * the error kinds callers branch on.
 *
 * cloudAuthService is mocked so tests never need a real Supabase session.
 */
const auth = vi.hoisted(() => ({
  token: "test-token" as string | null,
  workerOrigin: "https://worker.example",
}));

vi.mock("./cloudAuthService", () => ({
  cloudConfigured: () => true,
  workerConfigured: () => auth.workerOrigin.length > 0,
  workerUrl: () => auth.workerOrigin,
  getAccessToken: async () => auth.token,
}));

import {
  __resetForTests,
  cachedPlayUrlExpiry,
  completeUpload,
  deleteCloudObject,
  getPlayUrl,
  invalidatePlayUrl,
  requestUploadUrl,
  CloudStorageError,
} from "./r2StorageService";

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function installFetchMock(respond: (url: string, init: RequestInit) => unknown): FetchMock {
  const mock: FetchMock = vi.fn(async (url: string, init: RequestInit) => respond(url, init));
  vi.stubGlobal("fetch", mock);
  return mock;
}

const KEY = "users/u-1/tracks/t-1/audio.mp3";

describe("r2StorageService (in-memory, short-lived URLs)", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    auth.token = "test-token";
    auth.workerOrigin = "https://worker.example";
    __resetForTests();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("sends the Supabase access token to the Worker and returns the server-built key", async () => {
    fetchMock = installFetchMock(() =>
      jsonResponse(200, {
        objectKey: KEY,
        uploadUrl: "https://r2/put",
        expiresIn: 120,
        requiredHeaders: { "content-type": "audio/mpeg" },
      }),
    );
    const result = await requestUploadUrl({ trackId: "t-1", fileName: "song.mp3", mimeType: "audio/mpeg", sizeBytes: 42 });
    expect(result.objectKey).toBe(KEY);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://worker.example/api/audio/upload-url");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-token");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("treats an issued URL as meaningless until the Worker verifies the upload", async () => {
    fetchMock = installFetchMock(() =>
      jsonResponse(200, { verified: true, objectKey: KEY, size: 42, etag: "abc", contentType: "audio/mpeg" }),
    );
    const result = await completeUpload({ objectKey: KEY, trackId: "t-1", sizeBytes: 42, mimeType: "audio/mpeg" });
    expect(result.size).toBe(42);
    expect(result.etag).toBe("abc");
  });

  it("caches a play URL and reuses it while fresh, but only in memory", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    fetchMock = installFetchMock(() => jsonResponse(200, { url: "https://r2/get?sig=a", expiresIn: 300, expiresAt }));
    const first = await getPlayUrl(KEY);
    const second = await getPlayUrl(KEY);
    expect(first).toBe("https://r2/get?sig=a");
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cachedPlayUrlExpiry(KEY)).toBe(expiresAt);
    // Nothing is written to any persistent store; a reset clears everything.
    __resetForTests();
    expect(cachedPlayUrlExpiry(KEY)).toBeNull();
  });

  it("refreshes a play URL when the cached entry is inside the refresh margin", async () => {
    const stale = Math.floor(Date.now() / 1000) + 10;
    const fresh = Math.floor(Date.now() / 1000) + 300;
    let calls = 0;
    fetchMock = installFetchMock(() => {
      calls += 1;
      return jsonResponse(200, { url: calls === 1 ? "https://r2/get?sig=old" : "https://r2/get?sig=new", expiresIn: 300, expiresAt: calls === 1 ? stale : fresh });
    });
    expect(await getPlayUrl(KEY)).toBe("https://r2/get?sig=old");
    expect(await getPlayUrl(KEY)).toBe("https://r2/get?sig=new");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honours a forced refresh even when the cache looks fresh", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    fetchMock = installFetchMock(() => jsonResponse(200, { url: "https://r2/get?sig=a", expiresIn: 300, expiresAt }));
    await getPlayUrl(KEY);
    await getPlayUrl(KEY, { forceFresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent requests for the same object into one round trip", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    fetchMock = installFetchMock(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(jsonResponse(200, { url: "https://r2/get?sig=a", expiresIn: 300, expiresAt })), 5),
        ),
    );
    const [a, b, c] = await Promise.all([getPlayUrl(KEY), getPlayUrl(KEY), getPlayUrl(KEY)]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports 401s as auth failures so callers can sign in again instead of looping", async () => {
    fetchMock = installFetchMock(() => jsonResponse(401, { error: { code: "expired-token", message: "Session expired" } }));
    await expect(getPlayUrl(KEY)).rejects.toMatchObject({ kind: "auth", status: 401 });
  });

  it("reports a dropped connection as a network failure", async () => {
    fetchMock = installFetchMock(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(getPlayUrl(KEY)).rejects.toMatchObject({ kind: "network" });
  });

  it("reports a removed cloud object as not-found", async () => {
    fetchMock = installFetchMock(() => jsonResponse(404, { error: { code: "not-found", message: "gone" } }));
    await expect(getPlayUrl(KEY)).rejects.toMatchObject({ kind: "not-found" });
  });

  it("reports a rejected upload instead of treating an issued URL as a success", async () => {
    fetchMock = installFetchMock(() => jsonResponse(409, { error: { code: "upload-unverified", message: "The upload never arrived." } }));
    await expect(completeUpload({ objectKey: KEY, trackId: "t-1", sizeBytes: 42, mimeType: "audio/mpeg" })).rejects.toMatchObject({
      kind: "server",
      status: 409,
    });
  });

  it("fails closed when there is no access token to send", async () => {
    auth.token = null;
    fetchMock = installFetchMock(() => jsonResponse(200, {}));
    await expect(getPlayUrl(KEY)).rejects.toMatchObject({ kind: "auth" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when the Worker is not configured", async () => {
    auth.workerOrigin = "";
    fetchMock = installFetchMock(() => jsonResponse(200, {}));
    await expect(requestUploadUrl({ trackId: "t-1", fileName: "song.mp3", mimeType: "audio/mpeg", sizeBytes: 1 })).rejects.toMatchObject({
      kind: "unconfigured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards deleted object keys so callers can audit removals", async () => {
    fetchMock = installFetchMock(() =>
      jsonResponse(200, {
        deleted: [{ objectKey: KEY }, { objectKey: "users/u-1/tracks/t-1/artwork.jpg" }],
      }),
    );
    const deleted = await deleteCloudObject(KEY);
    expect(deleted).toEqual([KEY, "users/u-1/tracks/t-1/artwork.jpg"]);
  });

  it("drops a cached URL on demand", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    fetchMock = installFetchMock(() => jsonResponse(200, { url: "https://r2/get?sig=a", expiresIn: 300, expiresAt }));
    await getPlayUrl(KEY);
    invalidatePlayUrl(KEY);
    expect(cachedPlayUrlExpiry(KEY)).toBeNull();
    await getPlayUrl(KEY);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("error surface", () => {
  it("exposes a typed error with an actionable message", () => {
    const error = new CloudStorageError("auth", "Sign in to use cloud storage.", 401);
    expect(error.kind).toBe("auth");
    expect(error.status).toBe(401);
    expect(error.message).toBe("Sign in to use cloud storage.");
  });
});
