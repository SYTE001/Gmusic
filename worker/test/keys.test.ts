import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors";
import { KeySpec } from "../src/keys";

describe("object key construction", () => {
  it("builds server-controlled keys scoped to the authenticated user", () => {
    const spec = KeySpec.audio("user-1", "track-9", "mp3");
    expect(spec.objectKey).toBe("users/user-1/tracks/track-9/audio.mp3");
    expect(spec.trackPrefix).toBe("users/user-1/tracks/track-9/");
  });

  it("keeps artwork under the same track prefix", () => {
    const artwork = KeySpec.artwork("user-1", "track-9", "jpg");
    expect(artwork.objectKey).toBe("users/user-1/tracks/track-9/artwork.jpg");
    expect(artwork.trackPrefix).toBe(KeySpec.audio("user-1", "track-9", "mp3").trackPrefix);
  });

  it("rejects ids that could escape the key structure", () => {
    expect(() => KeySpec.audio("user/1", "track", "mp3")).toThrow(ApiError);
    expect(() => KeySpec.audio("user", "../escape", "mp3")).toThrow(ApiError);
    expect(() => KeySpec.audio("user", "track", "")).toThrow(ApiError);
    expect(() => KeySpec.audio("user", "track", "exe")).toThrow(ApiError);
    expect(() => KeySpec.artwork("user", "track", "svg")).toThrow(ApiError);
  });
});

describe("object key authorization", () => {
  it("accepts the owner's own keys", () => {
    const key = "users/user-1/tracks/track-9/audio.flac";
    expect(KeySpec.parseAndAuthorize(key, "user-1").trackId).toBe("track-9");
  });

  it("rejects keys belonging to another user", () => {
    const key = "users/user-1/tracks/track-9/audio.mp3";
    expect(() => KeySpec.parseAndAuthorize(key, "user-2")).toThrow(ApiError);
    const error = (() => {
      try {
        KeySpec.parseAndAuthorize(key, "user-2");
      } catch (candidate) {
        return candidate;
      }
    })() as ApiError;
    expect(error.status).toBe(403);
  });

  it("rejects malformed shapes", () => {
    const bad = [
      "users/user-1/audio.mp3",
      "users//tracks/t/audio.mp3",
      "tracks/t/audio.mp3",
      "users/user-1/tracks/t/folder",
      "users/user-1/tracks/t/",
      "users/user-1/tracks/t/audio",
      "users/user-1/tracks/t/audio.mp4.exe",
      "users/user-1/tracks/t/cover.jpgg",
    ];
    for (const key of bad) {
      expect(() => KeySpec.parseAndAuthorize(key, "user-1"), key).toThrow(ApiError);
    }
  });
});
