/* eslint-disable no-control-regex */
export type ParsedTags = {
  title?: string;
  artist?: string;
  album?: string;
  trackNumber?: number;
  albumTrackCount?: number;
  durationMs?: number;
  artwork?: Blob;
};

/**
 * Attempts to repair UTF-8 bytes that were inadvertently decoded as Windows-1252 / Latin-1
 * (e.g. "BeyoncÃ©" -> "Beyoncé"). If not valid mojibake, returns the input unchanged.
 */
export function tryRepairMojibake(input: string): string {
  if (!/[\xC0-\xDF][\x80-\xBF]|[\xE0-\xEF][\x80-\xBF]{2}|[\xF0-\xF7][\x80-\xBF]{3}/.test(input)) {
    return input;
  }
  try {
    const bytes = Uint8Array.from(input, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return input;
  }
}

/**
 * Detects whether a metadata string contains mojibake, unexpanded BOMs,
 * NUL bytes, or control characters that indicate corruption.
 * Safely preserves all legitimate Unicode characters (Latin with accents,
 * CJK, Cyrillic, Thai, Arabic, etc.), punctuation, and quotes.
 */
export function isCorruptedOrSuspiciousMetadata(value: string | undefined | null): boolean {
  if (!value) return false;
  // 1. Raw BOM characters or decoded BOM mojibake
  if (value.includes("ÿþ") || value.includes("þÿ") || value.includes("\uFEFF") || value.includes("\uFFFE")) {
    return true;
  }
  // 2. NUL bytes or unprintable C0/C1 control characters
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/.test(value)) {
    return true;
  }
  // 3. Unicode replacement characters (indicates byte decoding error)
  if (value.includes("\uFFFD")) {
    return true;
  }
  // 4. Purely whitespace or empty
  if (value.trim().length === 0) {
    return true;
  }
  return false;
}

export function parseTrackPair(value: string | undefined): { trackNumber?: number; albumTrackCount?: number } {
  if (!value) return {};
  const match = value.trim().match(/^(\d+)\s*(?:\/\s*(\d+))?$/);
  if (!match) {
    const bare = Number.parseInt(value.trim(), 10);
    return Number.isFinite(bare) && bare > 0 ? { trackNumber: bare } : {};
  }
  const trackNumber = Number.parseInt(match[1], 10);
  const albumTrackCount = match[2] ? Number.parseInt(match[2], 10) : undefined;
  return {
    trackNumber: Number.isFinite(trackNumber) && trackNumber > 0 ? trackNumber : undefined,
    albumTrackCount: albumTrackCount !== undefined && Number.isFinite(albumTrackCount) && albumTrackCount > 0 ? albumTrackCount : undefined,
  };
}

export function cleanTagText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  // Strip BOM
  let str = value.replace(/^\uFEFF/, "");
  // Attempt to repair Latin-1 / UTF-8 mojibake
  str = tryRepairMojibake(str);
  // Remove NUL bytes and control characters
  str = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "");
  // Collapse whitespace
  str = str.replace(/\s+/g, " ").trim();
  // Safe Unicode normalization using NFC
  try {
    str = str.normalize("NFC");
  } catch {
    // Preserve if normalize is not supported in environment
  }
  if (str.length === 0) return undefined;
  // Reject if corrupted or suspicious
  if (isCorruptedOrSuspiciousMetadata(str)) {
    return undefined;
  }
  return str;
}
