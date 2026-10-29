import { describe, expect, it } from "vitest";
import {
  clampLyricOffset,
  findActiveLineIndex,
  findActiveWordIndex,
  hasWordTimestamps,
  parseLyricFile,
} from "./lyricsService";

describe("parseLyricFile (LRC)", () => {
  it("parses basic timed lines into sorted entries", () => {
    const result = parseLyricFile("t1", "a.lrc", "[00:12.00]Second line\n[00:05.50]First line\n");
    expect(result.lyrics.format).toBe("lrc");
    expect(result.lyrics.lines).toHaveLength(2);
    expect(result.lyrics.lines[0].timeMs).toBe(5500);
    expect(result.lyrics.lines[0].text).toBe("First line");
    expect(result.lyrics.lines[1].timeMs).toBe(12000);
  });

  it("supports multiple timestamps on one line", () => {
    const result = parseLyricFile("t1", "a.lrc", "[00:10.00][01:20.00]Repeated\n");
    expect(result.lyrics.lines).toHaveLength(2);
    expect(result.lyrics.lines.every((line) => line.text === "Repeated")).toBe(true);
  });

  it("parses millisecond and comma fraction formats", () => {
    const result = parseLyricFile("t1", "a.lrc", "[00:01.500]Half\n[00:02,250]Quarter\n");
    expect(result.lyrics.lines[0].timeMs).toBe(1500);
    expect(result.lyrics.lines[1].timeMs).toBe(2250);
  });

  it("applies the [offset:] tag: positive shifts lyrics earlier", () => {
    const result = parseLyricFile("t1", "a.lrc", "[offset:1000]\n[00:10.00]Line\n");
    expect(result.lyrics.lines[0].timeMs).toBe(9000);
  });

  it("skips and counts malformed lines while keeping valid ones", () => {
    const result = parseLyricFile("t1", "a.lrc", "[00:01.00]Good\nThis has no timestamp\n[99:xx]Broken\n[00:02.00]Also good\n");
    expect(result.skippedLines).toBe(2);
    expect(result.lyrics.lines).toHaveLength(2);
  });

  it("keeps source order for equal timestamps (stable sort)", () => {
    const result = parseLyricFile("t1", "a.lrc", "[00:05.00]First\n[00:05.00]Second\n");
    expect(result.lyrics.lines[0].text).toBe("First");
    expect(result.lyrics.lines[1].text).toBe("Second");
  });

  it("preserves brackets inside lyric text", () => {
    const result = parseLyricFile("t1", "a.lrc", "[00:05.00][Chorus] Here we go\n");
    expect(result.lyrics.lines[0].text).toBe("[Chorus] Here we go");
  });

  it("falls back to plain text when no line has timestamps", () => {
    const result = parseLyricFile("t1", "notes.txt", "la la la\nno timestamps here\n");
    expect(result.lyrics.format).toBe("txt");
    expect(result.lyrics.lines).toHaveLength(2);
    expect(result.lyrics.lines[0].timeMs).toBeNull();
  });

  it("treats an empty file as empty plain-text lyrics, not an error", () => {
    const result = parseLyricFile("t1", "empty.lrc", "\n\n");
    expect(result.lyrics.lines).toHaveLength(0);
    expect(result.lyrics.format).toBe("txt");
  });

  it("clamps timestamps before zero to zero", () => {
    const result = parseLyricFile("t1", "a.lrc", "[offset:5000]\n[00:02.00]Early\n");
    expect(result.lyrics.lines[0].timeMs).toBe(0);
  });

  it("parses enhanced word-level timestamps only when present", () => {
    const enhanced = parseLyricFile("t1", "a.lrc", "[00:10.00]<00:10.00>Yeah <00:11.50>oh oh\n");
    expect(hasWordTimestamps(enhanced.lyrics.lines)).toBe(true);
    const words = enhanced.lyrics.lines[0].words!;
    expect(words[0].text.trim()).toBe("Yeah");
    expect(words[0].startMs).toBe(10000);
    expect(words[1].startMs).toBe(11500);
    expect(words[0].endMs).toBe(11500);

    const plain = parseLyricFile("t2", "a.lrc", "[00:10.00]Yeah oh oh\n");
    expect(hasWordTimestamps(plain.lyrics.lines)).toBe(false);
  });
});

describe("findActiveLineIndex", () => {
  const lines = parseLyricFile("t", "a.lrc", "[00:00.00]A\n[00:10.00]B\n[00:20.00]C\n").lyrics.lines;

  it("returns -1 before the first line", () => {
    expect(findActiveLineIndex(lines, -100, 0)).toBe(-1);
  });

  it("selects at exact boundaries", () => {
    expect(findActiveLineIndex(lines, 0, 0)).toBe(0);
    expect(findActiveLineIndex(lines, 10000, 0)).toBe(1);
    expect(findActiveLineIndex(lines, 20000, 0)).toBe(2);
  });

  it("selects the last line at or before the current time", () => {
    expect(findActiveLineIndex(lines, 9999, 0)).toBe(0);
    expect(findActiveLineIndex(lines, 15000, 0)).toBe(1);
    expect(findActiveLineIndex(lines, 999999, 0)).toBe(2);
  });

  it("applies a positive offset as lyrics arriving later", () => {
    // +1s offset: line B (10s) is active only from 11s.
    expect(findActiveLineIndex(lines, 10500, 1000)).toBe(0);
    expect(findActiveLineIndex(lines, 11000, 1000)).toBe(1);
  });

  it("ignores untimed lines", () => {
    const mixed = [
      { timeMs: null, text: "intro" },
      { timeMs: 5000, text: "first" },
      { timeMs: null, text: "gap" },
    ];
    expect(findActiveLineIndex(mixed, 6000, 0)).toBe(1);
  });
});

describe("findActiveWordIndex", () => {
  it("returns the word at or before the position", () => {
    const line = {
      timeMs: 0,
      text: "a b",
      words: [
        { text: "a", startMs: 1000, endMs: 2000 },
        { text: "b", startMs: 2000, endMs: null },
      ],
    };
    expect(findActiveWordIndex(line, 500, 0)).toBe(-1);
    expect(findActiveWordIndex(line, 1000, 0)).toBe(0);
    expect(findActiveWordIndex(line, 1999, 0)).toBe(0);
    expect(findActiveWordIndex(line, 2000, 0)).toBe(1);
  });
});

describe("clampLyricOffset", () => {
  it("clamps to the -10s..+10s range", () => {
    expect(clampLyricOffset(-20000)).toBe(-10000);
    expect(clampLyricOffset(20000)).toBe(10000);
    expect(clampLyricOffset(250)).toBe(250);
  });
});
