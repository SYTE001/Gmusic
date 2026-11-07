import { describe, expect, it } from "vitest";
import type { LyricLine } from "../../types";
import {
  LAST_LINE_FALLBACK_MS,
  LAST_LINE_MAX_MS,
  lineSeekTargetMs,
  toAmllLines,
  toLyricClockMs,
} from "./amllAdapter";

const wordLine: LyricLine = {
  timeMs: 1000,
  text: "Word up now",
  words: [
    { text: "Word", startMs: 1000, endMs: 1500 },
    { text: "up", startMs: 1500, endMs: 2000 },
    { text: "now", startMs: 2000, endMs: null },
  ],
};
const plainTimed: LyricLine = { timeMs: 5000, text: "second line" };

describe("toAmllLines", () => {
  it("emits one word per real word timestamp in word style", () => {
    const [first, second] = toAmllLines({ lines: [wordLine, plainTimed] }, { style: "word", durationMs: 60000 });
    expect(first.words.map((w) => [w.word, w.startTime, w.endTime])).toEqual([
      ["Word", 1000, 1500],
      [" up", 1500, 2000],
      [" now", 2000, 5000],
    ]);
    expect(first.startTime).toBe(1000);
    expect(first.endTime).toBe(5000);
    expect(second.words).toHaveLength(1);
  });

  it("never fabricates word timings for line-only data", () => {
    const [line] = toAmllLines({ lines: [{ timeMs: 1000, text: "hello big world" }, plainTimed] }, { style: "word", durationMs: 60000 });
    expect(line.words).toEqual([{ word: "hello big world", startTime: 1000, endTime: 5000 }]);
  });

  it("uses the next line's start as a line-only end and bounds the last line by track duration", () => {
    const lines = toAmllLines({ lines: [{ timeMs: 1000, text: "a" }, { timeMs: 4000, text: "b" }] }, { style: "line", durationMs: 6000 });
    expect(lines[0].endTime).toBe(4000);
    expect(lines[1].endTime).toBe(6000);
  });

  it("caps a long outro after the last line and falls back without a duration", () => {
    const withLong = toAmllLines({ lines: [{ timeMs: 1000, text: "a" }] }, { style: "line", durationMs: 600000 });
    expect(withLong[0].endTime).toBe(1000 + LAST_LINE_MAX_MS);
    const noDuration = toAmllLines({ lines: [{ timeMs: 1000, text: "a" }] }, { style: "line", durationMs: null });
    expect(noDuration[0].endTime).toBe(1000 + LAST_LINE_FALLBACK_MS);
    const staleDuration = toAmllLines({ lines: [{ timeMs: 9000, text: "a" }] }, { style: "line", durationMs: 4000 });
    expect(staleDuration[0].endTime).toBe(9000 + LAST_LINE_FALLBACK_MS);
  });

  it("forces single-word lines in line style even when word data exists", () => {
    const [line] = toAmllLines({ lines: [wordLine, plainTimed] }, { style: "line", durationMs: 60000 });
    expect(line.words).toEqual([{ word: "Word up now", startTime: 1000, endTime: 5000 }]);
  });

  it("drops empty lines but lets them end the previous line", () => {
    const lines = toAmllLines(
      { lines: [{ timeMs: 1000, text: "sung" }, { timeMs: 3000, text: "   " }, { timeMs: 8000, text: "later" }] },
      { style: "line", durationMs: 20000 },
    );
    expect(lines.map((l) => l.words[0].word)).toEqual(["sung", "later"]);
    expect(lines[0].endTime).toBe(3000);
  });

  it("returns nothing for empty or untimed input", () => {
    expect(toAmllLines({ lines: [] }, { style: "line", durationMs: 1000 })).toEqual([]);
    expect(toAmllLines({ lines: [{ timeMs: null, text: "plain" }] }, { style: "line", durationMs: 1000 })).toEqual([]);
  });

  it("does not bake the offset into the converted lines", () => {
    const base = toAmllLines({ lines: [wordLine, plainTimed] }, { style: "word", durationMs: 60000 });
    expect(base[0].startTime).toBe(1000);
    expect(toLyricClockMs(11000, 2000)).toBe(9000);
    expect(toLyricClockMs(1000, -500)).toBe(1500);
    expect(lineSeekTargetMs(1000, 2000)).toBe(3000);
    expect(lineSeekTargetMs(1000, -5000)).toBe(0);
  });

  it("emits empty translation and romanization (Gmusic stores neither)", () => {
    const [line] = toAmllLines({ lines: [wordLine] }, { style: "word", durationMs: 10000 });
    expect(line.translatedLyric).toBe("");
    expect(line.romanLyric).toBe("");
    expect(line.isBG).toBe(false);
    expect(line.isDuet).toBe(false);
  });

  it("sorts unsorted lines and trims overlapping words", () => {
    const lines = toAmllLines(
      {
        lines: [
          { timeMs: 6000, text: "b" },
          {
            timeMs: 1000,
            text: "ab cd",
            words: [
              { text: "cd", startMs: 1400, endMs: 3000 },
              { text: "ab", startMs: 1000, endMs: 2000 },
            ],
          },
        ],
      },
      { style: "word", durationMs: 20000 },
    );
    expect(lines.map((l) => l.startTime)).toEqual([1000, 6000]);
    expect(lines[0].words.map((w) => [w.word, w.startTime, w.endTime])).toEqual([
      ["ab", 1000, 1400],
      [" cd", 1400, 3000],
    ]);
  });

  it("keeps equal timestamps in source order and skips unusable words", () => {
    const lines = toAmllLines(
      {
        lines: [
          { timeMs: 2000, text: "one" },
          { timeMs: 2000, text: "two", words: [{ text: " ", startMs: 2000, endMs: null }, { text: "two", startMs: Number.NaN, endMs: null }] },
        ],
      },
      { style: "word", durationMs: 9000 },
    );
    expect(lines.map((l) => l.words[0].word)).toEqual(["one", "two"]);
    expect(lines[1].words).toHaveLength(1);
  });
});
