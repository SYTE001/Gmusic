import { invoke } from "@tauri-apps/api/core";
import type { LyricLine, Track } from "../../types";
import type { RankedCandidate } from "../lyrics/matching";
import { isTauriRuntime } from "./desktop";

export type NativeDiscoveryResult = {
  candidates: RankedCandidate[];
  errors: string[];
  fromCache: boolean;
  offline: boolean;
  cacheWarning: string | null;
};

export type NativeParsedLyrics = { lines: LyricLine[]; format: "lrc" | "txt"; skippedLines: number };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validLines(value: unknown): value is LyricLine[] {
  return Array.isArray(value) && value.length <= 20_000 && value.every((line: unknown) =>
    object(line) && typeof line.text === "string" &&
    (line.timeMs === null || (Number.isSafeInteger(line.timeMs) && Number(line.timeMs) >= 0)) &&
    (line.words === undefined || (Array.isArray(line.words) && line.words.every((word: unknown) =>
      object(word) && typeof word.text === "string" && Number.isSafeInteger(word.startMs) && Number(word.startMs) >= 0 &&
      (word.endMs === null || (Number.isSafeInteger(word.endMs) && Number(word.endMs) >= Number(word.startMs))),
    ))),
  );
}

function validDiscovery(value: unknown): value is NativeDiscoveryResult {
  return object(value) && Array.isArray(value.candidates) && value.candidates.length <= 12 &&
    value.candidates.every((entry: unknown) => object(entry) && object(entry.record) &&
      ["lrcmux", "lrclib", "lyricsdb"].includes(String(entry.record.provider)) &&
      (typeof entry.record.id === "string" || typeof entry.record.id === "number") &&
      validLines(entry.record.lines) && object(entry.quality) && typeof entry.quality.score === "number" &&
      Number.isFinite(entry.quality.score) && typeof entry.autoAcceptable === "boolean" &&
      typeof entry.hasSynced === "boolean" && typeof entry.hasPlain === "boolean" &&
      ["none", "instrumental", "plain", "line", "word"].includes(String(entry.capability))) &&
    Array.isArray(value.errors) && value.errors.every((error: unknown) => typeof error === "string") &&
    typeof value.fromCache === "boolean" && typeof value.offline === "boolean" &&
    (value.cacheWarning === null || typeof value.cacheWarning === "string");
}

/** Cancellation detaches the caller; native work can only populate its reusable
 * discovery cache. It cannot attach lyrics or mutate the playback/store state. */
async function cancellable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new DOMException("Request cancelled.", "AbortError");
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new DOMException("Request cancelled.", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

export async function discoverDesktopLyrics(
  track: Pick<Track, "id" | "title" | "artist" | "album" | "durationMs">,
  options: { providers: string[]; force?: boolean; signal?: AbortSignal },
): Promise<NativeDiscoveryResult | null> {
  if (!isTauriRuntime()) return null;
  if (options.signal?.aborted) throw new DOMException("Request cancelled.", "AbortError");
  try {
    const result: unknown = await cancellable(invoke("discover_desktop_lyrics", {
      request: {
        track: { id: track.id, title: track.title, artist: track.artist, album: track.album, durationMs: track.durationMs },
        providers: options.providers,
        force: options.force ?? false,
        offline: typeof navigator !== "undefined" && navigator.onLine === false,
      },
    }), options.signal);
    if (!validDiscovery(result)) throw new Error("Invalid native lyrics response.");
    if (result.cacheWarning) console.warn("Desktop lyrics cache:", result.cacheWarning);
    return result;
  } catch (error) {
    if (options.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
    // An unavailable/outdated native command can use the established web path.
    // Provider failures arrive as typed results and never cause a second lookup.
    console.warn("Native lyrics unavailable; using web lyrics services.", error);
    return null;
  }
}

export async function parseDesktopLyrics(content: string): Promise<NativeParsedLyrics | null> {
  if (!isTauriRuntime()) return null;
  try {
    const result: unknown = await invoke("parse_desktop_lyrics", { content });
    if (!object(result) || !validLines(result.lines) || (result.format !== "lrc" && result.format !== "txt") ||
      !Number.isSafeInteger(result.skippedLines) || Number(result.skippedLines) < 0) {
      throw new Error("Invalid native lyrics parse response.");
    }
    return result as NativeParsedLyrics;
  } catch (error) {
    console.warn("Native lyrics parser unavailable; using web parser.", error);
    return null;
  }
}
