import { describe, expect, it } from "vitest";
import { summarizePlaybackError } from "./summarizePlaybackError";

describe("summarizePlaybackError", () => {
  it("summarizes single-sentence errors cleanly", () => {
    const error = new Error("Audio file not found on disk");
    const result = summarizePlaybackError(error);

    expect(result.title).toBe("Audio not found");
    expect(result.summary).toBe("The audio file could not be found or opened.");
    expect(result.category).toBe("missing");
    expect(result.originalMessage).toBe("Audio file not found on disk");
  });

  it("simplifies multi-sentence technical errors to core message <= 90 chars (spec example)", () => {
    const raw =
      "NotSupportedError: Failed to load because no supported source was found. The browser could not decode the audio resource. Please check the media format and source.";
    const result = summarizePlaybackError(raw);

    expect(result.title).toBe("Playback failed");
    expect(result.summary.length).toBeLessThanOrEqual(90);
    expect(result.summary).toBe("This audio file could not be decoded or played.");
    expect(result.category).toBe("decoding");
    expect(result.originalMessage).toBe(raw);
  });

  it("simplifies unsupported audio codec format errors", () => {
    const raw = "This audio format is not supported by your browser. FLAC codec unsupported.";
    const result = summarizePlaybackError(raw);

    expect(result.title).toBe("Unsupported audio");
    expect(result.summary).toBe("This audio format is not supported.");
    expect(result.category).toBe("unsupported");
  });

  it("strips file paths and stack traces from summary while preserving them in originalMessage", () => {
    const rawWithStack = `Error: Cannot open audio file at C:\\Users\\User\\Music\\song.mp3: unreadable file\n    at HTMLAudioElement.<anonymous> (file:///engine.ts:12:4)\n    at emitError (file:///core.ts:40:9)`;
    const result = summarizePlaybackError(rawWithStack);

    expect(result.title).toBe("Unreadable audio");
    expect(result.summary).not.toContain("C:\\Users");
    expect(result.summary).not.toContain("at HTMLAudioElement");
    expect(result.summary.length).toBeLessThanOrEqual(90);
    expect(result.originalMessage).toBe(rawWithStack);
  });

  it("handles DOMException instances", () => {
    const notFoundDom = new DOMException("The requested file was not found", "NotFoundError");
    const res1 = summarizePlaybackError(notFoundDom);
    expect(res1.title).toBe("Audio not found");
    expect(res1.category).toBe("missing");
    expect(res1.errorCode).toBe("NotFoundError");

    const notSupportedDom = new DOMException("Format is not supported", "NotSupportedError");
    const res2 = summarizePlaybackError(notSupportedDom);
    expect(res2.title).toBe("Unsupported audio");
    expect(res2.category).toBe("unsupported");
    expect(res2.errorCode).toBe("NotSupportedError");

    const securityDom = new DOMException("Access was denied", "SecurityError");
    const res3 = summarizePlaybackError(securityDom);
    expect(res3.title).toBe("Access denied");
    expect(res3.category).toBe("permission");
    expect(res3.errorCode).toBe("SecurityError");
  });

  it("handles MediaError code objects (MediaError codes 1..4)", () => {
    // Code 4: MEDIA_ERR_SRC_NOT_SUPPORTED
    const err4 = { code: 4, message: "Format not supported" };
    const res4 = summarizePlaybackError(err4);
    expect(res4.title).toBe("Unsupported audio");
    expect(res4.category).toBe("unsupported");
    expect(res4.errorCode).toBe("MEDIA_ERR_SRC_NOT_SUPPORTED (4)");

    // Code 3: MEDIA_ERR_DECODE
    const err3 = { code: 3, message: "Decode error" };
    const res3 = summarizePlaybackError(err3);
    expect(res3.title).toBe("Playback failed");
    expect(res3.category).toBe("decoding");
    expect(res3.summary).toBe("The audio file could not be decoded.");
    expect(res3.errorCode).toBe("MEDIA_ERR_DECODE (3)");

    // Code 2: MEDIA_ERR_NETWORK
    const err2 = { code: 2, message: "Network connection lost" };
    const res2 = summarizePlaybackError(err2);
    expect(res2.title).toBe("Network error");
    expect(res2.category).toBe("network");
    expect(res2.errorCode).toBe("MEDIA_ERR_NETWORK (2)");
  });

  it("classifies corrupted/damaged audio", () => {
    const error = new Error("File data corrupted or damaged header");
    const result = summarizePlaybackError(error);

    expect(result.title).toBe("Damaged audio");
    expect(result.summary).toBe("This audio file appears to be damaged.");
    expect(result.category).toBe("corrupted");
  });

  it("classifies missing source or unavailable audio", () => {
    const error = "Source audio is no longer available on remote server";
    const result = summarizePlaybackError(error);

    expect(result.title).toBe("Source unavailable");
    expect(result.summary).toBe("The audio source is no longer available.");
    expect(result.category).toBe("missing");
  });

  it("classifies permission denied", () => {
    const error = new Error("Permission to read local file was denied");
    const result = summarizePlaybackError(error);

    expect(result.title).toBe("Access denied");
    expect(result.summary).toBe("Permission to access this audio file was denied.");
    expect(result.category).toBe("permission");
  });

  it("handles unknown or empty errors safely with fallback", () => {
    const resEmpty = summarizePlaybackError("");
    expect(resEmpty.title).toBe("Playback error");
    expect(resEmpty.summary).toBe("This track could not be played.");
    expect(resEmpty.category).toBe("playback");

    const resNull = summarizePlaybackError(null);
    expect(resNull.title).toBe("Playback error");
    expect(resNull.summary).toBe("This track could not be played.");
    expect(resNull.category).toBe("playback");

    const resObj = summarizePlaybackError({ something: "weird" });
    expect(resObj.title).toBe("Playback error");
    expect(resObj.category).toBe("playback");
  });
});
