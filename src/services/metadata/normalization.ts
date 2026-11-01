import type { Track } from "../../types";
import { normalizeForSearch } from "../../utils/misc";

export type NormalizedIdentity = {
  title: string;
  artist: string;
  album?: string;
  durationMs?: number | null;
  /** Preserved original inputs for debugging and fallback. */
  original: {
    title: string;
    artist: string;
    album?: string;
    fileName?: string;
  };
  /** Meaningful descriptors detected and preserved (e.g. "Live", "Acoustic", "Remix", "Radio Edit"). */
  versionType?: string[];
  /** Cleaned title with all descriptors stripped (useful for fallback search query). */
  cleanedTitle: string;
  /** Alternative (trackName, artistName) queries to try in fallback stages. */
  alternateQueries: Array<{ trackName: string; artistName: string; q?: string; reason: string }>;
};

/**
 * Meaningful version qualifiers that must NOT be discarded during cleaning,
 * because they denote a distinct audio recording (e.g. acoustic or live version).
 */
const MEANINGFUL_QUALIFIERS = [
  "live",
  "acoustic",
  "remix",
  "mix",
  "radio edit",
  "instrumental",
  "acapella",
  "orchestral",
  "unplugged",
  "demo",
  "cover",
  "extended",
  "feat.",
  "ft.",
  "featuring",
];

const VERSION_QUALIFIER_REGEX =
  /\b(live|acoustic|remix|radio\s+edit|instrumental|acapella|orchestral|unplugged|demo|cover|extended)\b/i;

/** Bracketed segment regex matching `(...)`, `[...]`, `{...}` */
const BRACKETED_SEGMENT_REGEX = /\(([^()]*)\)|\[([^\][]*)\]|\{([^{}]*)\}/g;

/** Pure noise patterns inside or outside brackets */
const NOISE_PATTERNS = [
  /official\s+(?:music\s+)?video/i,
  /dance\s+performance\s+video/i,
  /official\s+visualizer/i,
  /visualizer/i,
  /official\s+audio/i,
  /audio\s+only/i,
  /full\s+audio/i,
  /lyric\s+video/i,
  /lyrics\s+video/i,
  /\blyrics?\b/i,
  /clip\s+officiel/i,
  /video\s+clip/i,
  /\bmv\b/i,
  /\b(?:hd|4k|1080p|720p|hq|60fps)\b/i,
  /(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?/i,
];

/** File extensions to strip from filenames */
const FILE_EXT_REGEX = /\.(mp3|flac|wav|m4a|aac|ogg|oga|opus|weba|webm|mp4|wma)$/i;

/** Track number prefix regex: e.g. "01 - ", "01. ", "01_ ", "01 " */
const TRACK_NUM_PREFIX = /^\s*\d{1,3}\s*[-._)]\s*/;

/** Quotes at boundaries */
const QUOTES_REGEX = /^["'“”‘’`]+|["'“”‘’`]+$/g;

/** In-memory cache for fast lookup */
const normalizedMetadataCache = new Map<string, NormalizedIdentity>();

export function extractVersionQualifiers(title: string): Set<string> {
  const qualifiers = new Set<string>();
  const lower = title.toLowerCase();
  for (const q of MEANINGFUL_QUALIFIERS) {
    if (q === "feat." || q === "ft." || q === "featuring") continue;
    const regex = new RegExp(`\\b${q.replace(" ", "\\s+")}\\b`, "i");
    if (regex.test(lower)) {
      qualifiers.add(q);
    }
  }
  return qualifiers;
}

export function extractPrimaryArtist(artist: string): string {
  if (!artist) return "";
  const primary = artist.replace(/\s*-\s*topic\b/i, "").trim();
  const split = primary.split(/\s+(?:feat|ft|featuring)\.?\s+|\s+&\s+|\s*,\s*|\s+x\s+|\s+with\s+|\s+vs\.?\s+/i);
  if (split.length > 0 && split[0].trim().length > 0) {
    return split[0].trim();
  }
  return primary;
}

/**
 * Removes non-musical noise (Official Music Video, Dance Performance Video,
 * Lyrics, HD, 4K, Remastered release descriptors, etc.) while preserving
 * meaningful song identifiers (Remix, Acoustic, Live, Radio Edit, feat. credits).
 */
export function cleanNoiseFromText(input: string): {
  cleaned: string;
  removedNoise: string[];
  preservedVersion?: string[];
} {
  if (!input) return { cleaned: "", removedNoise: [] };

  const removedNoise: string[] = [];
  let text = input.replace(FILE_EXT_REGEX, "").trim();

  // Strip track numbers at the beginning
  text = text.replace(TRACK_NUM_PREFIX, "").trim();

  // 1. Process bracketed segments
  text = text.replace(BRACKETED_SEGMENT_REGEX, (fullMatch, p1, p2, p3) => {
    const content = (p1 || p2 || p3 || "").trim();
    if (!content) return "";

    const hasMeaningful = VERSION_QUALIFIER_REGEX.test(content) || /\b(?:feat|ft|featuring)\b/i.test(content);
    const isPureNoise = NOISE_PATTERNS.some((pattern) => pattern.test(content));

    if (isPureNoise && !hasMeaningful) {
      removedNoise.push(content);
      return "";
    }

    if (isPureNoise && hasMeaningful) {
      // Partially noisy bracket, e.g. "(Live Acoustic - Official Video)"
      let cleanedContent = content;
      for (const pattern of NOISE_PATTERNS) {
        cleanedContent = cleanedContent.replace(pattern, "");
      }
      cleanedContent = cleanedContent.replace(/[-–—|~]\s*$/, "").replace(/^\s*[-–—|~]/, "").trim();
      removedNoise.push(fullMatch);
      return cleanedContent.length > 0 ? `(${cleanedContent})` : "";
    }

    // Check release descriptor like "[Remastered]" or "(2011 Remaster)"
    if (/(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?/i.test(content)) {
      removedNoise.push(content);
      return "";
    }

    return fullMatch;
  });

  // 2. Process unbracketed noise
  // Topic suffix
  text = text.replace(/\s*[-–—|~]\s*topic\b/i, (m) => {
    removedNoise.push(m);
    return "";
  });
  text = text.replace(/\s*\btopic\b$/i, (m) => {
    removedNoise.push(m);
    return "";
  });

  // Unbracketed video descriptors
  const unbracketedNoise = [
    /\b(?:official\s+music\s+video|official\s+video|dance\s+performance\s+video|official\s+audio|official\s+visualizer|lyric\s+video|lyrics\s+video)\b/gi,
    /\s+-\s+(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?$/i,
    /\b(?:remastered|remaster)\b$/i,
    /\b(?:hd|4k|1080p|720p|hq)\b/gi,
  ];

  for (const pattern of unbracketedNoise) {
    text = text.replace(pattern, (m) => {
      removedNoise.push(m);
      return "";
    });
  }

  // Trailing or isolated "lyrics"
  text = text.replace(/\s+\blyrics?\b$/i, (m) => {
    removedNoise.push(m);
    return "";
  });

  // 3. Clean up dangling delimiters and whitespace
  text = text
    .replace(QUOTES_REGEX, "")
    .replace(/\s*[-–—|~]\s*$/, "")
    .replace(/^\s*[-–—|~]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();

  const qualifiers = Array.from(extractVersionQualifiers(text));

  return {
    cleaned: text,
    removedNoise,
    preservedVersion: qualifiers.length > 0 ? qualifiers : undefined,
  };
}

/** Delimiter pattern matching spaced hyphens, em/en dashes, pipes, tildes, underscores */
const DELIMITER_REGEX = /\s+[-–—|~_]\s+|\s*\/\/\s*/;

export type ExtractArtistTitleResult = {
  artist: string;
  title: string;
  confidence: number;
  isFlipped: boolean;
};

/**
 * Intelligently separates Artist and Title from candidate text.
 * Never assumes the text before a delimiter is always the artist.
 */
export function extractArtistAndTitle(
  rawString: string,
  context?: {
    knownArtists?: Set<string>;
    tags?: { title?: string; artist?: string };
  },
): ExtractArtistTitleResult {
  const { cleaned } = cleanNoiseFromText(rawString);
  const known = context?.knownArtists ?? new Set<string>();

  const delimiterMatch = cleaned.match(DELIMITER_REGEX);
  if (delimiterMatch && delimiterMatch.index !== undefined) {
    const part0 = cleaned.slice(0, delimiterMatch.index).trim();
    const part1 = cleaned.slice(delimiterMatch.index + delimiterMatch[0].length).trim();

    const part0Clean = cleanNoiseFromText(part0).cleaned;
    const part1Clean = cleanNoiseFromText(part1).cleaned;

    const norm0 = normalizeForSearch(part0Clean);
    const norm1 = normalizeForSearch(part1Clean);

    // 1. Check known artists
    if (known.has(norm0) && !known.has(norm1)) {
      return { artist: part0Clean, title: part1Clean, confidence: 0.95, isFlipped: false };
    }
    if (known.has(norm1) && !known.has(norm0)) {
      return { artist: part1Clean, title: part0Clean, confidence: 0.95, isFlipped: true };
    }

    // 2. Check if embedded tags match
    if (context?.tags?.artist) {
      const tagArtist = normalizeForSearch(context.tags.artist);
      if (norm0 === tagArtist) {
        return { artist: part0Clean, title: part1Clean, confidence: 0.9, isFlipped: false };
      }
      if (norm1 === tagArtist) {
        return { artist: part1Clean, title: part0Clean, confidence: 0.9, isFlipped: true };
      }
    }

    // 3. Inspect version qualifiers and features
    // If one part carries (Live Acoustic) or (Remix), that part is almost certainly the title!
    const part0Qualifiers = extractVersionQualifiers(part0Clean);
    const part1Qualifiers = extractVersionQualifiers(part1Clean);
    if (part0Qualifiers.size > 0 && part1Qualifiers.size === 0) {
      return { artist: part1Clean, title: part0Clean, confidence: 0.85, isFlipped: true };
    }
    if (part1Qualifiers.size > 0 && part0Qualifiers.size === 0) {
      return { artist: part0Clean, title: part1Clean, confidence: 0.85, isFlipped: false };
    }

    // 4. Default: Standard "Artist - Title"
    return { artist: part0Clean, title: part1Clean, confidence: 0.75, isFlipped: false };
  }

  // No delimiter found: check if a known artist is a prefix
  const normClean = normalizeForSearch(cleaned);
  for (const knownArtist of known) {
    if (normClean.startsWith(knownArtist + " ")) {
      const artistLen = knownArtist.length;
      const artist = cleaned.slice(0, artistLen).trim();
      const title = cleaned.slice(artistLen).trim();
      if (title.length > 0) {
        return { artist, title, confidence: 0.85, isFlipped: false };
      }
    }
  }

  return { artist: "", title: cleaned, confidence: 0.5, isFlipped: false };
}

/**
 * Normalizes a track's metadata to produce its canonical music-library identity
 * and prioritized search candidates before querying lyrics providers.
 */
export function normalizeTrackMetadata(
  track: Pick<Track, "title" | "artist" | "album" | "durationMs" | "fileName">,
  context?: { libraryTracks?: Track[] },
): NormalizedIdentity {
  const cacheKey = `${track.fileName}:${track.title}:${track.artist}:${track.album}:${track.durationMs ?? 0}`;
  const cached = normalizedMetadataCache.get(cacheKey);
  if (cached) return cached;

  const knownArtists = new Set<string>();
  if (context?.libraryTracks) {
    for (const t of context.libraryTracks) {
      if (t.artist && t.artist.trim()) {
        knownArtists.add(normalizeForSearch(t.artist));
      }
    }
  }

  const rawTitle = track.title ?? "";
  const rawArtist = track.artist ?? "";
  const rawAlbum = track.album ?? "";
  const rawFileName = track.fileName ?? "";

  // 1. Analyze embedded tags vs filename
  let detectedArtist = rawArtist;
  let detectedTitle = rawTitle;
  let isFlipped = false;

  // If tags are empty or title looks like a complete "Artist - Title" string:
  if (!detectedArtist || DELIMITER_REGEX.test(detectedTitle)) {
    const candidateSource = DELIMITER_REGEX.test(detectedTitle) ? detectedTitle : rawFileName;
    const extracted = extractArtistAndTitle(candidateSource, {
      knownArtists,
      tags: { title: rawTitle, artist: rawArtist },
    });
    if (extracted.artist) {
      detectedArtist = extracted.artist;
      detectedTitle = extracted.title;
      isFlipped = extracted.isFlipped;
    }
  }

  // 2. Clean noise from title and artist
  const cleanTitleRes = cleanNoiseFromText(detectedTitle);
  const cleanArtistRes = cleanNoiseFromText(detectedArtist);
  const canonicalTitle = cleanTitleRes.cleaned || rawTitle;
  const canonicalArtist = cleanArtistRes.cleaned || rawArtist;

  // Cleaned title without any version qualifiers (for broad search query)
  const baseTitleWithoutBrackets = canonicalTitle
    .replace(BRACKETED_SEGMENT_REGEX, " ")
    .replace(/\s+/g, " ")
    .trim();

  const primaryArtist = extractPrimaryArtist(canonicalArtist);

  // 3. Generate alternative search queries (prioritized, deduplicated)
  const alternateQueries: Array<{ trackName: string; artistName: string; q?: string; reason: string }> = [];

  // If ordering might be reversed:
  if (canonicalArtist && canonicalTitle) {
    alternateQueries.push({
      trackName: canonicalArtist,
      artistName: canonicalTitle,
      reason: isFlipped ? "Original unswapped ordering" : "Alternative title/artist ordering (swapped)",
    });
  }

  // Cleaned title + normalized artist:
  if (baseTitleWithoutBrackets && baseTitleWithoutBrackets !== canonicalTitle) {
    alternateQueries.push({
      trackName: baseTitleWithoutBrackets,
      artistName: canonicalArtist,
      reason: "Cleaned base title without brackets",
    });
  }

  // Canonical title + primary artist (without featured artists):
  if (primaryArtist && primaryArtist !== canonicalArtist) {
    alternateQueries.push({
      trackName: canonicalTitle,
      artistName: primaryArtist,
      reason: "Primary artist without featured credits",
    });
    if (baseTitleWithoutBrackets && baseTitleWithoutBrackets !== canonicalTitle) {
      alternateQueries.push({
        trackName: baseTitleWithoutBrackets,
        artistName: primaryArtist,
        reason: "Cleaned base title with primary artist",
      });
    }
  }

  // Original title + normalized artist:
  if (rawTitle && rawTitle !== canonicalTitle) {
    alternateQueries.push({
      trackName: rawTitle,
      artistName: canonicalArtist,
      reason: "Original title with normalized artist",
    });
  }

  // Delimiter-less free query
  if (canonicalTitle && canonicalArtist) {
    alternateQueries.push({
      trackName: canonicalTitle,
      artistName: canonicalArtist,
      q: `${canonicalArtist} ${canonicalTitle}`.trim(),
      reason: "Combined query string",
    });
  }

  const result: NormalizedIdentity = {
    title: canonicalTitle,
    artist: canonicalArtist,
    album: rawAlbum ? cleanNoiseFromText(rawAlbum).cleaned : undefined,
    durationMs: track.durationMs,
    original: {
      title: rawTitle,
      artist: rawArtist,
      album: rawAlbum,
      fileName: rawFileName,
    },
    versionType: cleanTitleRes.preservedVersion,
    cleanedTitle: baseTitleWithoutBrackets || canonicalTitle,
    alternateQueries,
  };

  normalizedMetadataCache.set(cacheKey, result);
  return result;
}

export function clearNormalizedMetadataCache(): void {
  normalizedMetadataCache.clear();
}
