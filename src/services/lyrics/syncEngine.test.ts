import { describe, expect, it } from "vitest";
import { findActiveLineIndex, findActiveWordIndex, hasWordTimestamps, parseLyricFile } from "./lyricsService";

/**
 * Synchronization engine tests against a deterministic mock audio clock
 * (feature spec §9): the "clock" here is simply positions we would read from
 * audio.currentTime. The engine derives the active line purely from that
 * value, so pause/resume/seek/rate-change correctness reduces to selection
 * correctness at arbitrary positions — plus the invariant that no state is
 * carried between calls (an independent timer would fail that).
 */

const LINES = parseLyricFile("t", "a.lrc", [
  "[00:01.00]First line", // 1000
  "[00:03.50]Second line", // 3500
  "[00:03.50]Second line (repeat timestamp)", // 3500 — repeated timestamp
  "[00:07.00]Third line", // 7000
  "", // gap: nothing between 7s and 20s
  "[00:20.00]Outro line", // 20000 — far beyond the 8s audio used elsewhere
].join("\n")).lyrics.lines;

describe("active line selection (audio-clock driven)", () => {
  it("is -1 before the first timestamp", () => {
    expect(findActiveLineIndex(LINES, 0, 0)).toBe(-1);
    expect(findActiveLineIndex(LINES, 999, 0)).toBe(-1);
  });

  it("activates exactly at the boundary and stays on the last line", () => {
    expect(findActiveLineIndex(LINES, 1000, 0)).toBe(0);
    expect(findActiveLineIndex(LINES, 3499, 0)).toBe(0);
    expect(findActiveLineIndex(LINES, 7000, 0)).toBe(3);
    expect(findActiveLineIndex(LINES, 999_999, 0)).toBe(4); // beyond audio end
  });

  it("keeps the previous line active across gaps and picks the last of equal timestamps", () => {
    expect(findActiveLineIndex(LINES, 10_000, 0)).toBe(3); // gap: third line still active
    expect(findActiveLineIndex(LINES, 3500, 0)).toBe(2); // repeated timestamp → later entry
  });

  it("handles seek forward and backward as plain position changes", () => {
    // Playing at 2s → seek to 8s → seek back to 1.5s. No timer state exists,
    // so every lookup is exact.
    expect(findActiveLineIndex(LINES, 2000, 0)).toBe(0);
    expect(findActiveLineIndex(LINES, 8000, 0)).toBe(3);
    expect(findActiveLineIndex(LINES, 1500, 0)).toBe(0);
  });

  it("produces identical results after pause/resume (no carried state)", () => {
    const beforePause = findActiveLineIndex(LINES, 4000, 0);
    const afterResume = findActiveLineIndex(LINES, 4000, 0);
    expect(afterResume).toBe(beforePause);
    expect(afterResume).toBe(2);
  });

  it("applies positive offsets as lyrics arriving later", () => {
    expect(findActiveLineIndex(LINES, 1000, 1000)).toBe(-1); // first line now needs 2s
    expect(findActiveLineIndex(LINES, 2000, 1000)).toBe(0);
    expect(findActiveLineIndex(LINES, 7999, 1000)).toBe(2);
    expect(findActiveLineIndex(LINES, 8000, 1000)).toBe(3);
  });

  it("applies negative offsets as lyrics arriving earlier", () => {
    expect(findActiveLineIndex(LINES, 0, -1000)).toBe(0);
  });

  it("ignores untimed lines exactly like the linear reference", () => {
    const mixed = [
      { timeMs: null, text: "intro" },
      { timeMs: 5000, text: "timed" },
      { timeMs: null, text: "untimed interlude" },
    ];
    expect(findActiveLineIndex(mixed, 6000, 0)).toBe(1);
    expect(findActiveLineIndex(mixed, 1000, 0)).toBe(-1);
  });

  it("matches the O(n) reference semantics on random-ish positions", () => {
    const reference = (lines: typeof LINES, positionMs: number, offsetMs: number) => {
      let active = -1;
      for (let i = 0; i < lines.length; i += 1) {
        const timeMs = lines[i].timeMs;
        if (timeMs === null) continue;
        if (timeMs + offsetMs <= positionMs) active = i;
        else break;
      }
      return active;
    };
    for (let position = 0; position <= 25_000; position += 317) {
      for (const offset of [-1500, 0, 700]) {
        expect(findActiveLineIndex(LINES, position, offset)).toBe(reference(LINES, position, offset));
      }
    }
  });
});

describe("word-level selection", () => {
  const enhanced = parseLyricFile("t", "a.lrc", "[00:10.00]<00:10.00>Yeah <00:11.50>oh oh").lyrics.lines;

  it("flags word timing only when present", () => {
    expect(hasWordTimestamps(enhanced)).toBe(true);
    expect(hasWordTimestamps(LINES)).toBe(false);
  });

  it("selects the active word from the audio position", () => {
    expect(findActiveWordIndex(enhanced[0], 10_000, 0)).toBe(0);
    expect(findActiveWordIndex(enhanced[0], 11_000, 0)).toBe(0);
    expect(findActiveWordIndex(enhanced[0], 11_500, 0)).toBe(1);
    expect(findActiveWordIndex(enhanced[0], 9900, 0)).toBe(-1);
  });

  it("shifts word timing with the same offset as lines", () => {
    expect(findActiveWordIndex(enhanced[0], 10_500, 1000)).toBe(-1); // word 1 now needs 11s
    expect(findActiveWordIndex(enhanced[0], 11_000, 1000)).toBe(0);
  });

  it("words sharing a timestamp stay grouped", () => {
    const shared = parseLyricFile("t", "a.lrc", "[00:05.00]<00:05.00>a <00:05.00>b <00:06.00>c").lyrics.lines;
    expect(findActiveWordIndex(shared[0], 5000, 0)).toBe(1); // last of equal timestamps
    expect(findActiveWordIndex(shared[0], 6000, 0)).toBe(2);
  });

  it("returns -1 for line-level data instead of fabricating word timing", () => {
    expect(findActiveWordIndex(LINES[0], 100_000, 0)).toBe(-1);
  });
});

describe("track changes", () => {
  it("switching lyrics documents cannot leak state — each document is independent", () => {
    const other = parseLyricFile("t2", "b.lrc", "[00:30.00]Other track line").lyrics.lines;
    // Reading the new document at any position never consults the old one.
    expect(findActiveLineIndex(other, 4000, 0)).toBe(-1);
    expect(findActiveLineIndex(LINES, 4000, 0)).toBe(2); // last of the repeated 3.5s pair
    expect(findActiveLineIndex(other, 31_000, 0)).toBe(0);
  });

  it("offsets belong to their own document", () => {
    const withOffset = { ...LINES };
    expect(findActiveLineIndex(withOffset, 1000, 5000)).toBe(-1);
    expect(findActiveLineIndex(LINES, 1000, 0)).toBe(0);
  });
});
