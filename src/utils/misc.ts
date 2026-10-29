/** Small shared helpers. Kept dependency-free on purpose. */

export function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 73012 -> "1:13" */
export function formatClock(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "0:00";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** 4981000 -> "1 hr 23 min" */
export function formatDurationLong(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "0 min";
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  if (minutes === 0) return `${hours} hr`;
  return `${hours} hr ${minutes} min`;
}

export function formatDate(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Normalizes text for the local search index: lowercase, strip diacritics,
 * collapse whitespace. Runs entirely on-device (rules §11).
 */
export function normalizeForSearch(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "01 - Song Name.mp3" -> { title: "Song Name", artist: "" } style fallbacks. */
export function deriveTitleFromFileName(fileName: string): { title: string; trackNumber: number | null } {
  const withoutExt = fileName.replace(/\.[^./\\]+$/, "");
  const numbered = withoutExt.match(/^\s*(\d{1,3})\s*[-._)]\s*(.+)$/);
  if (numbered) {
    const n = Number.parseInt(numbered[1], 10);
    return { title: numbered[2].trim(), trackNumber: Number.isFinite(n) ? n : null };
  }
  return { title: withoutExt.trim() || fileName, trackNumber: null };
}

/** "Artist - Title" split used when tags are missing. */
export function deriveArtistTitleFromFileName(
  fileName: string,
): { artist: string; title: string; trackNumber: number | null } {
  const { title: base, trackNumber } = deriveTitleFromFileName(fileName);
  const split = base.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (split) {
    return { artist: split[1].trim(), title: split[2].trim(), trackNumber };
  }
  return { artist: "", title: base, trackNumber };
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wrapped = (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, waitMs);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return wrapped;
}

/** Extension -> likely audio type. Only used for a pre-check; the audio element is the real decider. */
const AUDIO_EXTENSIONS = new Set([
  "mp3",
  "m4a",
  "m4b",
  "aac",
  "wav",
  "wave",
  "ogg",
  "oga",
  "opus",
  "flac",
  "webm",
  "weba",
  "mp4",
]);

export function fileExtension(fileName: string): string {
  const match = fileName.match(/\.([^.]+)$/);
  return match ? match[1].toLowerCase() : "";
}

export function looksLikeAudioFile(fileName: string, mimeType: string): boolean {
  if (mimeType.startsWith("audio/")) return true;
  return AUDIO_EXTENSIONS.has(fileExtension(fileName));
}

export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function greetingForNow(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 5) return "Late night listening";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}
