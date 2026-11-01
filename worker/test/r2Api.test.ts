import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeUploadIntent, startWorker, USER_A, USER_B, type TestContext, type WorkerResponse } from "./harness";

/** Decodes the base64url payload segment of an upload intent token. */
function base64UrlDecode(segment: string): Uint8Array {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/") + "===".slice(0, (4 - (segment.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

let ctx: TestContext | null = null;

beforeAll(async () => {
  ctx = await startWorker();
});
afterAll(async () => {
  await ctx?.mf.dispose();
  ctx = null;
});

type UploadUrlResponse = {
  objectKey: string;
  uploadUrl: string;
  uploadIntent: string;
  expiresIn: number;
  requiredHeaders: { "content-type": string };
  kind: string;
};

async function requestUploadUrl(
  body: Record<string, unknown>,
  userId: string = USER_A,
): Promise<{ response: WorkerResponse; body: UploadUrlResponse | null }> {
  const response = await ctx!.api("/api/audio/upload-url", { body: JSON.stringify(body), userId });
  const parsed = (response.ok ? ((await response.json()) as UploadUrlResponse) : null) satisfies UploadUrlResponse | null;
  return { response, body: parsed };
}

describe("upload-url", () => {
  it("builds a server-controlled key scoped to the authenticated user", async () => {
    const { response, body } = await requestUploadUrl({
      trackId: "track-1",
      fileName: "Song.mp3",
      mimeType: "audio/mpeg",
      sizeBytes: 1234,
    });
    expect(response.status).toBe(200);
    expect(body!.objectKey).toBe(`users/${USER_A}/tracks/track-1/audio.mp3`);
    expect(body!.requiredHeaders["content-type"]).toBe("audio/mpeg");
    expect(body!.expiresIn).toBeGreaterThan(0);
    expect(body!.uploadUrl).toContain("local-music-media");
  });

  it("never trusts a client-supplied object key", async () => {
    const { body } = await requestUploadUrl({
      trackId: "track-1",
      fileName: "song.mp3",
      mimeType: "audio/mpeg",
      sizeBytes: 1234,
      // A forged key must be ignored outright.
      objectKey: `users/${USER_B}/tracks/track-1/audio.mp3`,
    });
    expect(body!.objectKey).toBe(`users/${USER_A}/tracks/track-1/audio.mp3`);
  });

  it("rejects unsupported file types", async () => {
    const { response } = await requestUploadUrl({ trackId: "track-1", fileName: "song.exe", mimeType: "application/x-msdownload", sizeBytes: 10 });
    expect(response.status).toBe(400);
  });

  it("rejects oversized uploads", async () => {
    const { response } = await requestUploadUrl({
      trackId: "track-1",
      fileName: "song.mp3",
      mimeType: "audio/mpeg",
      sizeBytes: 524288001,
    });
    expect([400, 413]).toContain(response.status);
  });

  it("accepts artwork under the track prefix", async () => {
    const { response, body } = await requestUploadUrl({
      trackId: "track-1",
      fileName: "cover.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 5000,
      kind: "artwork",
    });
    expect(response.status).toBe(200);
    expect(body!.objectKey).toBe(`users/${USER_A}/tracks/track-1/artwork.jpg`);
  });
});

describe("upload content-type validation", () => {
  it("rejects a document content type for an audio upload", async () => {
    const { response } = await requestUploadUrl({ trackId: "track-mime-1", fileName: "notes.mp3", mimeType: "text/html", sizeBytes: 100 });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/audio\/mpeg|not accepted/i);
  });

  it("rejects a generic octet-stream declaration", async () => {
    const { response } = await requestUploadUrl({
      trackId: "track-mime-2",
      fileName: "song.mp3",
      mimeType: "application/octet-stream",
      sizeBytes: 100,
    });
    expect(response.status).toBe(400);
  });

  it("rejects a content type that does not match the file extension", async () => {
    // A JPEG declared for a .mp3 track: neither the extension mapping nor the
    // audio kind allows it.
    const { response } = await requestUploadUrl({ trackId: "track-mime-3", fileName: "song.mp3", mimeType: "image/jpeg", sizeBytes: 100 });
    expect(response.status).toBe(400);
  });

  it("rejects a non-image type for artwork", async () => {
    const { response } = await requestUploadUrl({
      trackId: "track-mime-4",
      fileName: "cover.jpg",
      mimeType: "audio/mpeg",
      sizeBytes: 100,
      kind: "artwork",
    });
    expect(response.status).toBe(400);
  });

  it("accepts a browser-specific but consistent audio type", async () => {
    const { response, body } = await requestUploadUrl({ trackId: "track-mime-5", fileName: "song.m4a", mimeType: "audio/x-m4a", sizeBytes: 100 });
    expect(response.status).toBe(200);
    expect(body?.requiredHeaders["content-type"]).toBe("audio/x-m4a");
  });

  it("signs and returns exactly the validated content type", async () => {
    const { response, body } = await requestUploadUrl({ trackId: "track-mime-6", fileName: "SONG.MP3", mimeType: "audio/mpeg", sizeBytes: 100 });
    expect(response.status).toBe(200);
    expect(body?.requiredHeaders["content-type"]).toBe("audio/mpeg");
    expect(body?.objectKey).toBe("users/11111111-1111-1111-1111-111111111111/tracks/track-mime-6/audio.mp3");
  });

  it("rejects a zero-size upload request outright", async () => {
    const { response } = await requestUploadUrl({ trackId: "track-mime-7", fileName: "song.mp3", mimeType: "audio/mpeg", sizeBytes: 0 });
    expect(response.status).toBe(400);
  });

  it("refuses to complete an upload whose declared content type is not allowed", async () => {
    const key = "users/11111111-1111-1111-1111-111111111111/tracks/track-swap/audio.mp3";
    await ctx!.bucket.put(key, new Uint8Array(800), { httpMetadata: { contentType: "application/pdf" } });
    const response = await ctx!.api("/api/audio/complete", {
      userId: USER_A,
      body: JSON.stringify({ objectKey: key, trackId: "track-swap", sizeBytes: 800, mimeType: "application/pdf" }),
    });
    // The type is checked before the object is even inspected.
    expect(response.status).toBe(400);
    expect(await ctx!.bucket.head(key)).not.toBeNull(); // nothing was deleted
  });
});

describe("complete (upload verification)", () => {
  it("refuses to complete an upload that never happened", async () => {
    const { body } = await requestUploadUrl({ trackId: "track-9", fileName: "song.flac", mimeType: "audio/flac", sizeBytes: 999 });
    const response = await ctx!.api("/api/audio/complete", {
      userId: USER_A,
      body: JSON.stringify({ objectKey: body!.objectKey, sizeBytes: 999, mimeType: "audio/flac" }),
    });
    expect(response.status).toBe(409);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("upload-unverified");
  });

  it("fails verification when the stored size does not match the claim", async () => {
    const { body } = await requestUploadUrl({ trackId: "track-2", fileName: "song.mp3", mimeType: "audio/mpeg", sizeBytes: 2000 });
    // The client lied about the size: only 1000 bytes actually landed.
    await ctx!.bucket.put(body!.objectKey, new Uint8Array(1000), { httpMetadata: { contentType: "audio/mpeg" } });
    const response = await ctx!.api("/api/audio/complete", {
      userId: USER_A,
      body: JSON.stringify({ objectKey: body!.objectKey, sizeBytes: 2000, mimeType: "audio/mpeg" }),
    });
    expect(response.status).toBe(422);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("verification-failed");
  });

  it("fails verification when the stored content type does not match", async () => {
    const { body } = await requestUploadUrl({ trackId: "track-3", fileName: "song.mp3", mimeType: "audio/mpeg", sizeBytes: 800 });
    await ctx!.bucket.put(body!.objectKey, new Uint8Array(800), { httpMetadata: { contentType: "audio/ogg" } });
    const response = await ctx!.api("/api/audio/complete", {
      userId: USER_A,
      body: JSON.stringify({ objectKey: body!.objectKey, sizeBytes: 800, mimeType: "audio/mpeg" }),
    });
    expect(response.status).toBe(422);
  });

  it("verifies and reports the object when size and metadata match", async () => {
    const { body } = await requestUploadUrl({ trackId: "track-4", fileName: "song.mp3", mimeType: "audio/mpeg", sizeBytes: 4096 });
    await ctx!.bucket.put(body!.objectKey, new Uint8Array(4096), { httpMetadata: { contentType: "audio/mpeg" } });
    const response = await ctx!.api("/api/audio/complete", {
      userId: USER_A,
      body: JSON.stringify({ objectKey: body!.objectKey, trackId: "track-4", sizeBytes: 4096, mimeType: "audio/mpeg" }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { verified: boolean; objectKey: string; size: number };
    expect(payload.verified).toBe(true);
    expect(payload.objectKey).toBe(body!.objectKey);
    expect(payload.size).toBe(4096);
  });

  it("refuses to complete another user's object", async () => {
    const key = `users/${USER_A}/tracks/track-5/audio.mp3`;
    await ctx!.bucket.put(key, new Uint8Array(64), { httpMetadata: { contentType: "audio/mpeg" } });
    const response = await ctx!.api("/api/audio/complete", {
      userId: USER_B,
      body: JSON.stringify({ objectKey: key, sizeBytes: 64, mimeType: "audio/mpeg" }),
    });
    expect(response.status).toBe(403);
  });

  it("verifies and binds completion using signed uploadIntent", async () => {
    const { body } = await requestUploadUrl({ trackId: "track-intent-1", fileName: "song.mp3", mimeType: "audio/mpeg", sizeBytes: 1500 });
    expect(body?.uploadIntent).toBeDefined();

    await ctx!.bucket.put(body!.objectKey, new Uint8Array(1500), { httpMetadata: { contentType: "audio/mpeg" } });

    // Client provides uploadIntent; server verifies using cryptographically bound values
    const response = await ctx!.api("/api/audio/complete", {
      userId: USER_A,
      body: JSON.stringify({
        uploadIntent: body!.uploadIntent,
        objectKey: body!.objectKey,
      }),
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as { verified: boolean; size: number };
    expect(result.verified).toBe(true);
    expect(result.size).toBe(1500);
  });

  it("does not trust browser-supplied sizeBytes when uploadIntent is present", async () => {
    const { body } = await requestUploadUrl({ trackId: "track-intent-tamper", fileName: "song.mp3", mimeType: "audio/mpeg", sizeBytes: 2000 });

    // Stored object has 1000 bytes; browser claims 1000 in request body to try to fool verification
    await ctx!.bucket.put(body!.objectKey, new Uint8Array(1000), { httpMetadata: { contentType: "audio/mpeg" } });

    const response = await ctx!.api("/api/audio/complete", {
      userId: USER_A,
      body: JSON.stringify({
        uploadIntent: body!.uploadIntent,
        objectKey: body!.objectKey,
        sizeBytes: 1000, // Browser tries to overwrite approved intent size
      }),
    });
    expect(response.status).toBe(422);
    // Rejected object is deleted from R2
    expect(await ctx!.bucket.head(body!.objectKey)).toBeNull();
  });

  it("rejects completion with tampered uploadIntent token", async () => {
    const { body } = await requestUploadUrl({ trackId: "track-intent-tamper2", fileName: "song.mp3", mimeType: "audio/mpeg", sizeBytes: 500 });
    const tampered = body!.uploadIntent.slice(0, -6) + "xxxxxx";

    const response = await ctx!.api("/api/audio/complete", {
      userId: USER_A,
      body: JSON.stringify({
        uploadIntent: tampered,
        objectKey: body!.objectKey,
      }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects an expired upload intent with the documented expiry message", async () => {
    // Reproduces the reported failure for tracks like "Oladrys (128k)": the
    // PUT succeeded but /complete rejected because the intent had lapsed.
    const { body } = await requestUploadUrl({ trackId: "track-intent-expired", fileName: "song.mp3", mimeType: "audio/mpeg", sizeBytes: 600 });
    const intent = body!.uploadIntent;

    // Decode the signed payload, shift its expiry into the past, re-sign.
    const encoded = intent.split(".")[0]!;
    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(encoded)),
    ) as { expiresAt: number };
    const expired = await makeUploadIntent({ ...payload, expiresAt: Math.floor(Date.now() / 1000) - 60 });

    await ctx!.bucket.put(body!.objectKey, new Uint8Array(600), { httpMetadata: { contentType: "audio/mpeg" } });
    const response = await ctx!.api("/api/audio/complete", {
      userId: USER_A,
      body: JSON.stringify({ uploadIntent: expired, objectKey: body!.objectKey }),
    });
    expect(response.status).toBe(409);
    const result = (await response.json()) as { error: { code: string; message: string } };
    expect(result.error.code).toBe("upload-unverified");
    expect(result.error.message).toMatch(/upload intent has expired/i);
  });

  it("accepts a freshly minted intent for the same object after an expiry", async () => {
    // The retry path: a new upload-url request issues a new intent, and the
    // already-stored object completes against it — no re-upload required.
    const { body } = await requestUploadUrl({ trackId: "track-intent-refresh", fileName: "song.mp3", mimeType: "audio/mpeg", sizeBytes: 700 });
    await ctx!.bucket.put(body!.objectKey, new Uint8Array(700), { httpMetadata: { contentType: "audio/mpeg" } });

    const refreshed = await requestUploadUrl({ trackId: "track-intent-refresh", fileName: "song.mp3", mimeType: "audio/mpeg", sizeBytes: 700 });
    const response = await ctx!.api("/api/audio/complete", {
      userId: USER_A,
      body: JSON.stringify({ uploadIntent: refreshed.body!.uploadIntent, objectKey: refreshed.body!.objectKey }),
    });
    expect(response.status).toBe(200);
  });

  it("rejects completion when uploadIntent was issued to a different user", async () => {
    const { body } = await requestUploadUrl({ trackId: "track-intent-cross", fileName: "song.mp3", mimeType: "audio/mpeg", sizeBytes: 500 }, USER_A);

    await ctx!.bucket.put(body!.objectKey, new Uint8Array(500), { httpMetadata: { contentType: "audio/mpeg" } });

    const response = await ctx!.api("/api/audio/complete", {
      userId: USER_B,
      body: JSON.stringify({
        uploadIntent: body!.uploadIntent,
        objectKey: body!.objectKey,
      }),
    });
    expect(response.status).toBe(403);
  });

  it("cleans up rejected object and fails with 422 when stored object has missing or mismatched content type metadata", async () => {
    const { body } = await requestUploadUrl({ trackId: "track-no-meta", fileName: "song.mp3", mimeType: "audio/mpeg", sizeBytes: 400 });

    // Missing httpMetadata completely
    await ctx!.bucket.put(body!.objectKey, new Uint8Array(400));

    const response = await ctx!.api("/api/audio/complete", {
      userId: USER_A,
      body: JSON.stringify({
        uploadIntent: body!.uploadIntent,
        objectKey: body!.objectKey,
      }),
    });
    expect(response.status).toBe(422);
    // Object cleaned up
    expect(await ctx!.bucket.head(body!.objectKey)).toBeNull();
  });
});

describe("play-url", () => {
  it("issues a short-lived URL for an existing object owned by the caller", async () => {
    const key = `users/${USER_A}/tracks/track-6/audio.mp3`;
    await ctx!.bucket.put(key, new Uint8Array(64), { httpMetadata: { contentType: "audio/mpeg" } });
    const response = await ctx!.api("/api/audio/play-url", { userId: USER_A, body: JSON.stringify({ objectKey: key }) });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { url: string; expiresAt: number; expiresIn: number };
    expect(payload.url).toContain("X-Amz-Signature");
    expect(payload.expiresIn).toBeGreaterThan(0);
    expect(payload.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("reports a clear 404 when the cloud copy is gone", async () => {
    const key = `users/${USER_A}/tracks/track-missing/audio.mp3`;
    const response = await ctx!.api("/api/audio/play-url", { userId: USER_A, body: JSON.stringify({ objectKey: key }) });
    expect(response.status).toBe(404);
  });

  it("denies playback URLs for another user's object", async () => {
    const key = `users/${USER_A}/tracks/track-7/audio.mp3`;
    await ctx!.bucket.put(key, new Uint8Array(64), { httpMetadata: { contentType: "audio/mpeg" } });
    const response = await ctx!.api("/api/audio/play-url", { userId: USER_B, body: JSON.stringify({ objectKey: key }) });
    expect(response.status).toBe(403);
  });
});

describe("delete", () => {
  it("removes the audio object and sibling artwork for the track", async () => {
    const audioKey = `users/${USER_A}/tracks/track-8/audio.mp3`;
    const artworkKey = `users/${USER_A}/tracks/track-8/artwork.jpg`;
    await ctx!.bucket.put(audioKey, new Uint8Array(64), { httpMetadata: { contentType: "audio/mpeg" } });
    await ctx!.bucket.put(artworkKey, new Uint8Array(16), { httpMetadata: { contentType: "image/jpeg" } });

    const response = await ctx!.api("/api/audio/delete", { userId: USER_A, body: JSON.stringify({ objectKey: audioKey }) });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { deleted: { objectKey: string }[] };
    const deletedKeys = payload.deleted.map((entry) => entry.objectKey);
    expect(deletedKeys).toContain(audioKey);
    expect(deletedKeys).toContain(artworkKey);
    expect(await ctx!.bucket.head(audioKey)).toBeNull();
    expect(await ctx!.bucket.head(artworkKey)).toBeNull();
  });

  it("never deletes another user's objects", async () => {
    const audioKey = `users/${USER_B}/tracks/track-10/audio.mp3`;
    await ctx!.bucket.put(audioKey, new Uint8Array(64), { httpMetadata: { contentType: "audio/mpeg" } });
    const response = await ctx!.api("/api/audio/delete", { userId: USER_A, body: JSON.stringify({ objectKey: audioKey }) });
    expect(response.status).toBe(403);
    expect(await ctx!.bucket.head(audioKey)).not.toBeNull();
  });

  it("is idempotent and succeeds with empty list when track objects are already deleted", async () => {
    const audioKey = `users/${USER_A}/tracks/track-already-deleted/audio.mp3`;
    const response = await ctx!.api("/api/audio/delete", { userId: USER_A, body: JSON.stringify({ objectKey: audioKey }) });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { deleted: unknown[] };
    expect(payload.deleted).toEqual([]);
  });

  it("accepts deletion by trackId directly without objectKey", async () => {
    const audioKey = `users/${USER_A}/tracks/track-by-id/audio.mp3`;
    const artworkKey = `users/${USER_A}/tracks/track-by-id/artwork.jpg`;
    await ctx!.bucket.put(audioKey, new Uint8Array(32), { httpMetadata: { contentType: "audio/mpeg" } });
    await ctx!.bucket.put(artworkKey, new Uint8Array(32), { httpMetadata: { contentType: "image/jpeg" } });

    const response = await ctx!.api("/api/audio/delete", {
      userId: USER_A,
      body: JSON.stringify({ trackId: "track-by-id" }),
    });
    expect(response.status).toBe(200);
    expect(await ctx!.bucket.head(audioKey)).toBeNull();
    expect(await ctx!.bucket.head(artworkKey)).toBeNull();
  });

  it("deletes across paginated listings without leaving any objects behind", async () => {
    const trackId = "track-paginated";
    const totalObjects = 150; // exceeds list limit of 100
    for (let i = 0; i < totalObjects; i++) {
      const key = `users/${USER_A}/tracks/${trackId}/sibling-${i}.mp3`;
      await ctx!.bucket.put(key, new Uint8Array(10), { httpMetadata: { contentType: "audio/mpeg" } });
    }

    const checkBefore = await ctx!.bucket.list({ prefix: `users/${USER_A}/tracks/${trackId}/` });
    expect(checkBefore.objects.length).toBeGreaterThan(0);

    const response = await ctx!.api("/api/audio/delete", {
      userId: USER_A,
      body: JSON.stringify({ trackId }),
    });
    expect(response.status).toBe(200);

    const checkAfter = await ctx!.bucket.list({ prefix: `users/${USER_A}/tracks/${trackId}/` });
    expect(checkAfter.objects).toHaveLength(0);
  });
});
