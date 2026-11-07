import { describe, expect, it } from "vitest";
import { parseLyricsfile } from "./lyricsfile";

/** Shape observed from the live LRCLIB API on 2026-10-25. */
const OBSERVED_LINE_SYNC = `version: '1.0'
metadata:
  title: Yesterday
  artist: The Beatles
  album: Help!
  duration_ms: 125028
  instrumental: false
lines:
- text: Yesterday, all my troubles seemed so far away
  start_ms: 5340
  end_ms: 13200
- text: Now it looks as though they're here to stay
  start_ms: 13200
  end_ms: 17160
`;

describe("parseLyricsfile", () => {
  it("parses the observed line-sync shape", () => {
    const parsed = parseLyricsfile(OBSERVED_LINE_SYNC);
    expect(parsed).not.toBeNull();
    expect(parsed?.metadataDurationMs).toBe(125028);
    expect(parsed?.hasWordTiming).toBe(false);
    expect(parsed?.lines).toHaveLength(2);
    expect(parsed?.lines[0]).toEqual({ timeMs: 5340, text: "Yesterday, all my troubles seemed so far away" });
    expect(parsed?.lines[1].timeMs).toBe(13200);
  });

  it("handles quoted values and colons inside text", () => {
    const parsed = parseLyricsfile(`lines:
- text: 'Time: after time'
  start_ms: 1000
`);
    expect(parsed?.lines[0]?.text).toBe("Time: after time");
    expect(parsed?.lines[0]?.timeMs).toBe(1000);
  });

  it("parses per-word timing into word arrays", () => {
    const parsed = parseLyricsfile(`lines:
- text: hello world
  start_ms: 1000
  end_ms: 3000
  words:
  - text: hello
    start_ms: 1000
    end_ms: 2000
  - text: world
    start_ms: 2000
    end_ms: 3000
`);
    expect(parsed?.hasWordTiming).toBe(true);
    const line = parsed?.lines[0];
    expect(line?.words).toEqual([
      { text: "hello", startMs: 1000, endMs: 2000 },
      { text: "world", startMs: 2000, endMs: 3000 },
    ]);
  });

  it("treats word entries missing start_ms as no word timing (fallback path)", () => {
    const parsed = parseLyricsfile(`lines:
- text: hello world
  start_ms: 1000
  words:
  - text: hello
  - text: world
`);
    expect(parsed?.hasWordTiming).toBe(false);
    expect(parsed?.lines[0]?.words).toBeUndefined();
  });

  it("sorts out-of-order lines chronologically", () => {
    const parsed = parseLyricsfile(`lines:
- text: second
  start_ms: 5000
- text: first
  start_ms: 1000
`);
    expect(parsed?.lines.map((line) => line.text)).toEqual(["first", "second"]);
  });

  it("returns null for documents without a lines block", () => {
    expect(parseLyricsfile("version: '1.0'\nmetadata:\n  title: x\n")).toBeNull();
  });

  it("returns null when a line lacks timing (invalid for sync)", () => {
    expect(parseLyricsfile("lines:\n- text: untimed\n")).toBeNull();
  });

  it("returns null on an empty lines block", () => {
    expect(parseLyricsfile("lines: []\n")).toBeNull();
  });
});
