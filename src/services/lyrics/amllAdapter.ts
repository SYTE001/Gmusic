import type { LyricLine as AmllLyricLine, LyricWord as AmllLyricWord } from "@applemusic-like-lyrics/core";
import type { LyricLine, TrackLyrics } from "../../types";
import { hasWordTimestamps } from "./lyricsService";

/**
 * Pure converter from Gmusic's internal lyric model to the line/word shape the
 * AMLL lyric player consumes (`LyricLine` in `@applemusic-like-lyrics/core`,
 * all times in milliseconds).
 *
 * Rules (rules.md §8):
 * - Real per-word timestamps (lrcmux word sync, enhanced LRC `<mm:ss.xx>`) become
 *   multiple words; line-only data becomes a single word spanning the line.
 *   Word timings are never fabricated.
 * - The per-song offset is NOT baked in. It is applied to the player clock
 *   (see {@link toLyricClockMs}) so the converted lines stay stable — and
 *   memoizable — while the user nudges the offset, and the stored record is
 *   never rewritten.
 */

export type AmllLyricStyle = "line" | "word";

export type AmllAdapterOptions = {
  style: AmllLyricStyle;
  /** Track duration, used only to bound the end of the last line. */
  durationMs: number | null;
};

/** Longest a last line may stay highlighted when the track runs on after it. */
export const LAST_LINE_MAX_MS = 10000;
/** End of the last line when no usable track duration is available. */
export const LAST_LINE_FALLBACK_MS = 5000;

const NO_TRANSLATION = "";

type TimedSource = { line: LyricLine; startMs: number };

function usableWords(line: LyricLine) {
  return (line.words ?? [])
    .filter((word) => Number.isFinite(word.startMs) && word.text.trim().length > 0)
    .map((word, order) => ({ word, order }))
    .sort((a, b) => a.word.startMs - b.word.startMs || a.order - b.order)
    .map((entry) => entry.word);
}

/**
 * Word entries carry no whitespace of their own for some providers. Recover the
 * original spacing from the line text so the player lays words out exactly as
 * written, without inventing anything beyond a separating space.
 */
function withLineSpacing(text: string, words: { text: string }[]): string[] {
  let cursor = 0;
  return words.map((word, index) => {
    const found = text ? text.indexOf(word.text, cursor) : -1;
    if (found >= 0) {
      const gap = text.slice(cursor, found);
      cursor = found + word.text.length;
      return /^\s*$/.test(gap) ? gap + word.text : word.text;
    }
    return index > 0 && !/^\s/.test(word.text) ? ` ${word.text}` : word.text;
  });
}

function clampTime(ms: number): number {
  return Math.max(0, Math.round(ms));
}

function lastLineEnd(startMs: number, durationMs: number | null): number {
  if (durationMs !== null && Number.isFinite(durationMs) && durationMs > startMs) {
    return Math.min(durationMs, startMs + LAST_LINE_MAX_MS);
  }
  return startMs + LAST_LINE_FALLBACK_MS;
}

export function toAmllLines(lyrics: Pick<TrackLyrics, "lines">, options: AmllAdapterOptions): AmllLyricLine[] {
  const wordMode = options.style === "word" && hasWordTimestamps(lyrics.lines);

  // Timed lines only, stable-sorted by start so unsorted input stays well-formed.
  const timed: TimedSource[] = lyrics.lines
    .filter((line) => line.timeMs !== null && Number.isFinite(line.timeMs))
    .map((line) => ({ line, startMs: clampTime(line.timeMs as number) }))
    .map((entry, order) => ({ ...entry, order }))
    .sort((a, b) => a.startMs - b.startMs || a.order - b.order);

  const result: AmllLyricLine[] = [];
  timed.forEach((entry, position) => {
    const text = entry.line.text.trim();
    // Blank lines produce no output but still end the line before them.
    if (text.length === 0) return;

    const nextStart = position + 1 < timed.length ? timed[position + 1].startMs : null;
    const fallbackEnd = nextStart !== null ? nextStart : lastLineEnd(entry.startMs, options.durationMs);
    const startTime = entry.startMs;

    const realWords = wordMode ? usableWords(entry.line) : [];
    if (realWords.length === 0) {
      result.push(makeLine([{ word: text, startTime, endTime: Math.max(startTime, fallbackEnd) }], startTime, Math.max(startTime, fallbackEnd)));
      return;
    }

    const texts = withLineSpacing(entry.line.text, realWords);
    const words: AmllLyricWord[] = realWords.map((word, index) => {
      const wordStart = Math.max(startTime, clampTime(word.startMs));
      const followingStart = index + 1 < realWords.length ? clampTime(realWords[index + 1].startMs) : fallbackEnd;
      const declaredEnd = word.endMs !== null && Number.isFinite(word.endMs) ? clampTime(word.endMs) : followingStart;
      // Overlapping words are trimmed to the next word's start.
      const wordEnd = Math.max(wordStart, Math.min(declaredEnd, Math.max(followingStart, wordStart)));
      return { word: texts[index], startTime: wordStart, endTime: wordEnd };
    });
    const lineEnd = Math.max(words[words.length - 1].endTime, startTime);
    result.push(makeLine(words, startTime, lineEnd));
  });
  return result;
}

function makeLine(words: AmllLyricWord[], startTime: number, endTime: number): AmllLyricLine {
  return {
    words,
    translatedLyric: NO_TRANSLATION,
    romanLyric: NO_TRANSLATION,
    startTime,
    endTime,
    isBG: false,
    isDuet: false,
  };
}

/**
 * Converts the audio clock (ms) into the lyric clock the player is fed.
 * Gmusic displays a line at `line.timeMs + offsetMs` on the audio clock, so the
 * player — whose lines carry the original times — reads `audio - offset`.
 */
export function toLyricClockMs(audioMs: number, offsetMs: number): number {
  return audioMs - offsetMs;
}

/** Audio-clock position a click on a lyric line should seek to. */
export function lineSeekTargetMs(lineStartMs: number, offsetMs: number): number {
  return Math.max(0, lineStartMs + offsetMs);
}
