import type { LyricLine, LyricWord } from "../../types";

/**
 * Parser for LRCLIB's `lyricsfile` payload: a small YAML-like document.
 *
 * Observed shape (line-sync records):
 *   version: '1.0'
 *   metadata:
 *     title: ...
 *     duration_ms: 125028
 *   lines:
 *   - text: Yesterday, all my troubles…
 *     start_ms: 5340
 *     end_ms: 13200
 *
 * Word-sync records additionally carry per-word timing. LRCLIB's word-sync
 * catalog is currently sparse, so this parser is deliberately defensive: it
 * accepts `words` lists under each line (`- text: / start_ms: / end_ms:`) and
 * returns null on any inconsistency — callers then fall back to the synced LRC.
 */

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"')))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseScalar(raw: string): string | number | boolean | null {
  const value = stripQuotes(raw);
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return Number.parseFloat(value);
  if (value === "true" || value === "false") return value === "true";
  if (value === "null" || value === "~" || value === "") return null;
  return value;
}

type Block = { indent: number; key: string; value: string | null };

/** Splits the document into `key: value` lines, preserving nesting by indent. */
function tokenize(text: string): Block[] {
  const blocks: Block[] = [];
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    if (rawLine.trim().length === 0 || rawLine.trimStart().startsWith("#")) continue;
    const withoutListDash = rawLine.replace(/^(\s*)-\s/, "$1  ");
    const match = withoutListDash.match(/^(\s*)([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!match) continue;
    blocks.push({ indent: match[1].length, key: match[2], value: match[3].length > 0 ? match[3] : null });
  }
  return blocks;
}

export type ParsedLyricsfile = {
  lines: LyricLine[];
  hasWordTiming: boolean;
  metadataDurationMs: number | null;
};

export function parseLyricsfile(text: string): ParsedLyricsfile | null {
  const blocks = tokenize(text);
  // Locate the top-level `lines:` block.
  const linesIndex = blocks.findIndex((block) => block.indent === 0 && block.key === "lines" && block.value === null);
  if (linesIndex === -1) return null;

  const lines: LyricLine[] = [];
  let hasWordTiming = false;
  let i = linesIndex + 1;

  // YAML list items look like `- text: …` — the tokenizer normalizes the dash
  // to spaces, so an item's `text` and its sibling properties (`start_ms`,
  // `words`) share one indent level; nested word entries sit deeper.
  while (i < blocks.length) {
    const block = blocks[i];
    if (block.indent === 0) break; // next top-level key — the lines block ended
    if (block.key !== "text" || block.value === null) {
      i += 1;
      continue;
    }
    const text = stripQuotes(block.value);
    let startMs: number | null = null;
    const words: LyricWord[] = [];
    let j = i + 1;

    while (j < blocks.length && blocks[j].indent >= block.indent) {
      const property = blocks[j];
      // The next item's `text` at the same level ends this item.
      if (property.key === "text" && property.indent === block.indent) break;

      if (property.key === "start_ms" && property.indent === block.indent && property.value !== null) {
        const parsed = parseScalar(property.value);
        if (typeof parsed === "number" && Number.isFinite(parsed)) startMs = parsed;
      } else if (property.key === "words" && property.indent === block.indent && property.value === null) {
        // Word entries are everything deeper than the item level until the
        // item ends; a `text` key inside starts a new word.
        let wordText: string | null = null;
        let wordStart: number | null = null;
        let wordEnd: number | null = null;
        const flushWord = () => {
          if (wordText !== null && wordStart !== null) {
            words.push({ text: wordText, startMs: wordStart, endMs: wordEnd });
          }
          wordText = null;
          wordStart = null;
          wordEnd = null;
        };
        let k = j + 1;
        while (k < blocks.length && blocks[k].indent > block.indent) {
          const wordBlock = blocks[k];
          if (wordBlock.key === "text" && wordBlock.value !== null) {
            flushWord();
            wordText = stripQuotes(wordBlock.value);
          } else if (wordBlock.key === "start_ms" && wordBlock.value !== null) {
            const parsed = parseScalar(wordBlock.value);
            if (typeof parsed === "number" && Number.isFinite(parsed)) wordStart = parsed;
          } else if (wordBlock.key === "end_ms" && wordBlock.value !== null) {
            const parsed = parseScalar(wordBlock.value);
            if (typeof parsed === "number" && Number.isFinite(parsed)) wordEnd = parsed;
          }
          k += 1;
        }
        flushWord();
        j = k - 1;
      }
      j += 1;
    }

    if (startMs === null) return null; // untimed line in a timed file — treat the whole file as invalid
    if (words.length > 0 && words.every((word) => Number.isFinite(word.startMs))) {
      hasWordTiming = true;
      lines.push({ timeMs: startMs, text, words });
    } else {
      lines.push({ timeMs: startMs, text });
    }
    i = j;
  }

  if (lines.length === 0) return null;
  lines.sort((a, b) => (a.timeMs as number) - (b.timeMs as number));

  let metadataDurationMs: number | null = null;
  const durationBlock = blocks.find((block) => block.key === "duration_ms" && block.value !== null);
  if (durationBlock?.value != null) {
    const parsed = parseScalar(durationBlock.value);
    if (typeof parsed === "number") metadataDurationMs = parsed;
  }

  return { lines, hasWordTiming, metadataDurationMs };
}
