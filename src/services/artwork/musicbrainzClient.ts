import { workerConfigured, workerUrl } from "../cloud/cloudAuthService";
import { cleanNoiseFromText, extractPrimaryArtist, normalizeTrackMetadata } from "../metadata/normalization";
import { normalizeForSearch } from "../../utils/misc";

/**
 * MusicBrainz Web Service (WS/2) discovery and intelligent release-group / release matcher.
 *
 * Official endpoint: https://musicbrainz.org/ws/2/
 * When the optional Cloudflare Worker proxy is configured (`VITE_WORKER_URL` or
 * `VITE_METADATA_PROXY_URL`), requests route through `/api/musicbrainz/*` so the
 * Worker attaches the required identifiable User-Agent and edge caching.
 * When the Worker is unavailable or unconfigured, falls back cleanly without breaking.
 */

export const MUSICBRAINZ_WS_BASE = "https://musicbrainz.org/ws/2";
export const GMUSIC_USER_AGENT = "Gmusic/1.1.0 ( https://github.com/SYTE001/Gmusic )";

const MBID_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ConfidenceThresholds {
  /** Minimum score (0..100) to automatically accept a candidate. Default: 80. */
  high: number;
  /** Minimum score (0..100) to treat as a medium-confidence candidate. Default: 62. */
  medium: number;
}

export const DEFAULT_CONFIDENCE_THRESHOLDS: ConfidenceThresholds = {
  high: 80,
  medium: 62,
};

const DEFAULT_RATE_LIMIT_MS = import.meta.env.MODE === "test" ? 0 : 1000;
let activeThresholds: ConfidenceThresholds = { ...DEFAULT_CONFIDENCE_THRESHOLDS };
let minRequestIntervalMs = DEFAULT_RATE_LIMIT_MS;
let nextAllowedAtMs = 0;

export function getConfidenceThresholds(): ConfidenceThresholds {
  return { ...activeThresholds };
}

export function setConfidenceThresholds(thresholds: Partial<ConfidenceThresholds>): void {
  activeThresholds = {
    high: thresholds.high ?? activeThresholds.high,
    medium: thresholds.medium ?? activeThresholds.medium,
  };
}

/** Test hook to configure rate limit interval and thresholds in unit tests. */
export function __configureMusicBrainzForTests(options?: {
  rateLimitMs?: number;
  thresholds?: Partial<ConfidenceThresholds>;
}): void {
  minRequestIntervalMs = options?.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
  nextAllowedAtMs = 0;
  activeThresholds = {
    high: options?.thresholds?.high ?? DEFAULT_CONFIDENCE_THRESHOLDS.high,
    medium: options?.thresholds?.medium ?? DEFAULT_CONFIDENCE_THRESHOLDS.medium,
  };
}

export function isValidMbid(value: string | null | undefined): value is string {
  if (typeof value !== "string") return false;
  return MBID_UUID_REGEX.test(value.trim());
}

export interface MusicBrainzAlias {
  name?: string;
  "sort-name"?: string;
}

export interface MusicBrainzArtist {
  id?: string;
  name?: string;
  "sort-name"?: string;
  aliases?: MusicBrainzAlias[];
}

export interface MusicBrainzArtistCreditEntry {
  name?: string;
  joinphrase?: string;
  artist?: MusicBrainzArtist;
}

export interface MusicBrainzReleaseSummary {
  id: string;
  title?: string;
  status?: string;
  date?: string;
  country?: string;
  disambiguation?: string;
  "track-count"?: number;
  "artist-credit"?: MusicBrainzArtistCreditEntry[];
  "release-group"?: {
    id?: string;
    title?: string;
    "primary-type"?: string;
    "secondary-types"?: string[];
  };
  media?: Array<{
    format?: string;
    "track-count"?: number;
    tracks?: Array<{
      id?: string;
      title?: string;
      length?: number;
    }>;
  }>;
}

export interface MusicBrainzReleaseGroup {
  id: string;
  title: string;
  score?: number | string;
  "primary-type"?: string;
  "secondary-types"?: string[];
  "first-release-date"?: string;
  disambiguation?: string;
  "artist-credit"?: MusicBrainzArtistCreditEntry[];
  releases?: MusicBrainzReleaseSummary[];
}

export type ConfidenceTier = "high" | "medium" | "low";

export interface ScoredReleaseGroupCandidate {
  releaseGroup: MusicBrainzReleaseGroup;
  mbid: string;
  confidence: number;
  tier: ConfidenceTier;
  artistScore: number;
  titleScore: number;
  releaseMbids: string[];
}

export interface ScoredReleaseCandidate {
  release: MusicBrainzReleaseSummary;
  mbid: string;
  releaseGroupMbid: string | null;
  confidence: number;
  tier: ConfidenceTier;
}

export interface MusicBrainzTrackQuery {
  artist: string;
  album?: string;
  title?: string;
  durationMs?: number | null;
}

export type MusicBrainzFetchStatus = "ok" | "not-found" | "transient-error" | "skipped";

export interface MusicBrainzDiscoveryResult {
  status: MusicBrainzFetchStatus;
  candidates: ScoredReleaseGroupCandidate[];
  bestCandidate: ScoredReleaseGroupCandidate | null;
  secondaryCandidates: ScoredReleaseGroupCandidate[];
}

const PLACEHOLDER_VALUES = new Set([
  "",
  "unknown",
  "unknown artist",
  "unknown album",
  "various",
  "untitled",
  "none",
  "n a",
  "na",
  "null",
  "undefined",
  "audio",
  "track",
]);

function isPlaceholderMetadata(value: string | undefined | null): boolean {
  if (!value) return true;
  const cleaned = normalizeForSearch(cleanNoiseFromText(value).cleaned);
  if (!cleaned || PLACEHOLDER_VALUES.has(cleaned)) return true;
  if (/^track\s*\d+$/i.test(cleaned) || /^audio\s*track\s*\d*$/i.test(cleaned)) return true;
  return false;
}

/**
 * Avoid unnecessary MusicBrainz queries when existing metadata is incomplete.
 * Requires a meaningful artist AND at least one of album or track title.
 */
export function hasSufficientMetadataForMusicBrainz(query: MusicBrainzTrackQuery): boolean {
  if (isPlaceholderMetadata(query.artist)) return false;
  if (isPlaceholderMetadata(query.album) && isPlaceholderMetadata(query.title)) return false;
  return true;
}

interface EditionFlags {
  deluxe: boolean;
  live: boolean;
  remix: boolean;
  compilation: boolean;
  soundtrack: boolean;
  ep: boolean;
  single: boolean;
  remaster: boolean;
}

export function extractEditionFlags(text: string | undefined | null): EditionFlags {
  const lower = (text ?? "").toLowerCase();
  return {
    deluxe: /\b(deluxe|expanded|special\s+edition|collector'?s?\s+edition|anniversary\s+edition|super\s+deluxe|bonus\s+track)\b/i.test(lower),
    live: /\b(live|unplugged|in\s+concert|mtv\s+unplugged)\b/i.test(lower),
    remix: /\b(remix|remixes|reworked|dub\s+mix|club\s+mix|vip\s+mix)\b/i.test(lower),
    compilation: /\b(greatest\s+hits|best\s+of|anthology|the\s+essentials|complete\s+collection|singles\s+collection|compilation)\b/i.test(lower),
    soundtrack: /\b(soundtrack|o\.?s\.?t\.?|original\s+motion\s+picture|original\s+score)\b/i.test(lower),
    ep: /\b(e\.?p\.?)\b/i.test(lower),
    single: /\b(single)\b/i.test(lower),
    remaster: /\b(remaster|remastered)\b/i.test(lower),
  };
}

/**
 * Strips parenthetical/bracketed edition qualifiers and trailing dash suffixes
 * so core album titles can be compared cleanly while edition flags are scored separately.
 */
export function normalizeCoreTitle(raw: string | undefined | null): string {
  if (!raw) return "";
  let text = cleanNoiseFromText(raw).cleaned;
  // Strip parenthetical/bracketed qualifiers that describe editions/remasters
  text = text.replace(
    /\s*[([][^)\]]*\b(deluxe|expanded|special|collector|anniversary|remaster|remastered|bonus|edition|version|live|remix|remixes|explicit|clean|disc\s*\d+|cd\s*\d+|vol\.?\s*\d+|ep|single|soundtrack|ost)\b[^)\]]*[)\]]/gi,
    "",
  );
  // Strip trailing "- Deluxe Edition", "- Remastered 2020", etc.
  text = text.replace(
    /\s+[-–—:]\s*([0-9]{4}\s+)?(deluxe|expanded|special|anniversary|remaster|remastered|edition|version|bonus\s+track|live|ep|single)\b.*$/i,
    "",
  );
  return normalizeForSearch(text);
}

/**
 * Splits an artist string into normalized primary & featured artist tokens.
 */
export function extractArtistVariants(rawArtist: string): string[] {
  const cleaned = cleanNoiseFromText(rawArtist).cleaned;
  const primary = extractPrimaryArtist(cleaned);
  const parts = cleaned
    .split(/(?:\s+(?:feat\.?|ft\.?|featuring|with|vs\.?|x)\s+|\s*[,;&/]\s*)/i)
    .map((part: string) => normalizeForSearch(part))
    .filter(Boolean);

  const set = new Set<string>();
  const fullNorm = normalizeForSearch(cleaned);
  const primaryNorm = normalizeForSearch(primary);
  if (fullNorm) set.add(fullNorm);
  if (primaryNorm) set.add(primaryNorm);
  for (const part of parts) set.add(part);
  return Array.from(set);
}

function collectCandidateArtistNames(credits: MusicBrainzArtistCreditEntry[] | undefined): string[] {
  if (!Array.isArray(credits)) return [];
  const names = new Set<string>();
  const joinedParts: string[] = [];

  for (const entry of credits) {
    if (entry.name) {
      const norm = normalizeForSearch(entry.name);
      if (norm) names.add(norm);
      joinedParts.push(entry.name + (entry.joinphrase ?? " "));
    }
    if (entry.artist?.name) {
      const norm = normalizeForSearch(entry.artist.name);
      if (norm) names.add(norm);
    }
    if (entry.artist?.["sort-name"]) {
      const norm = normalizeForSearch(entry.artist["sort-name"]);
      if (norm) names.add(norm);
      // Also reverse "Last, First" sort-name to "First Last"
      if (entry.artist["sort-name"].includes(",")) {
        const reversed = entry.artist["sort-name"]
          .split(",")
          .map((s) => s.trim())
          .reverse()
          .join(" ");
        const revNorm = normalizeForSearch(reversed);
        if (revNorm) names.add(revNorm);
      }
    }
    if (Array.isArray(entry.artist?.aliases)) {
      for (const alias of entry.artist.aliases) {
        if (alias.name) {
          const norm = normalizeForSearch(alias.name);
          if (norm) names.add(norm);
        }
      }
    }
  }

  if (joinedParts.length > 0) {
    const fullJoined = normalizeForSearch(joinedParts.join(""));
    if (fullJoined) names.add(fullJoined);
  }

  return Array.from(names);
}

/**
 * Computes string similarity in [0..1] combining exact match, core equality,
 * and token Jaccard / containment.
 */
export function computeTextSimilarity(targetRaw: string, candidateRaw: string): number {
  const targetFull = normalizeForSearch(targetRaw);
  const candidateFull = normalizeForSearch(candidateRaw);
  if (!targetFull || !candidateFull) return 0;
  if (targetFull === candidateFull) return 1.0;

  const targetCore = normalizeCoreTitle(targetRaw);
  const candidateCore = normalizeCoreTitle(candidateRaw);
  if (targetCore && candidateCore && targetCore === candidateCore) {
    return 0.96;
  }

  const a = targetCore || targetFull;
  const b = candidateCore || candidateFull;

  const tokensA = a.split(" ").filter(Boolean);
  const tokensB = b.split(" ").filter(Boolean);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection += 1;
  }

  if (intersection === 0) return 0;

  const union = new Set([...setA, ...setB]).size;
  const jaccard = intersection / union;
  const containment = intersection / Math.min(setA.size, setB.size);

  // Substring containment when one is a prefix/phrase of the other
  if (a.includes(b) || b.includes(a)) {
    return Math.max(0.78, jaccard * 0.6 + containment * 0.4);
  }

  return jaccard * 0.65 + containment * 0.35;
}

export function computeArtistSimilarity(
  queryArtist: string,
  candidateCredits: MusicBrainzArtistCreditEntry[] | undefined,
): number {
  const queryVariants = extractArtistVariants(queryArtist);
  const candidateNames = collectCandidateArtistNames(candidateCredits);
  if (queryVariants.length === 0 || candidateNames.length === 0) return 0;

  let best = 0;
  for (const q of queryVariants) {
    for (const c of candidateNames) {
      if (q === c) return 1.0;
      // Handle "The Beatles" vs "Beatles"
      const qNoThe = q.replace(/^the\s+/, "");
      const cNoThe = c.replace(/^the\s+/, "");
      if (qNoThe && qNoThe === cNoThe) {
        best = Math.max(best, 0.98);
        continue;
      }
      const sim = computeTextSimilarity(q, c);
      if (sim > best) best = sim;
    }
  }
  return best;
}

function classifyTier(confidence: number, thresholds: ConfidenceThresholds = activeThresholds): ConfidenceTier {
  if (confidence >= thresholds.high) return "high";
  if (confidence >= thresholds.medium) return "medium";
  return "low";
}

/**
 * Scores a MusicBrainz Release Group candidate against normalized query metadata.
 * Returns a confidence score in [0..100] and a tier ("high" | "medium" | "low").
 */
export function scoreReleaseGroupCandidate(
  candidate: MusicBrainzReleaseGroup,
  query: MusicBrainzTrackQuery,
  thresholds: ConfidenceThresholds = activeThresholds,
): ScoredReleaseGroupCandidate {
  const targetTitle = !isPlaceholderMetadata(query.album) ? query.album! : (query.title ?? "");
  const artistSim = computeArtistSimilarity(query.artist, candidate["artist-credit"]);
  const titleSim = computeTextSimilarity(targetTitle, candidate.title ?? "");

  // Hard guard: never accept a clearly unrelated artist or title
  if (artistSim < 0.45 || titleSim < 0.5) {
    const lowScore = Math.min(35, Math.round((artistSim * 40 + titleSim * 40) * 0.5));
    return {
      releaseGroup: candidate,
      mbid: candidate.id,
      confidence: lowScore,
      tier: "low",
      artistScore: artistSim,
      titleScore: titleSim,
      releaseMbids: extractReleaseMbids(candidate.releases),
    };
  }

  // Base weighted score: Artist (45 pts) + Album/Title (45 pts) + Official/Type (10 pts)
  let score = artistSim * 45 + titleSim * 45;

  const primaryType = (candidate["primary-type"] ?? "").toLowerCase();
  const secondaryTypes = (candidate["secondary-types"] ?? []).map((t) => t.toLowerCase());
  const candidateMetaText = `${candidate.title ?? ""} ${candidate.disambiguation ?? ""}`;

  const queryFlags = extractEditionFlags(`${query.album ?? ""} ${query.title ?? ""}`);
  const candidateFlags = extractEditionFlags(candidateMetaText);

  const hasAlbumMetadata = !isPlaceholderMetadata(query.album);

  // Primary type alignment
  if (hasAlbumMetadata) {
    if (queryFlags.ep && primaryType === "ep") {
      score += 8;
    } else if (queryFlags.single && primaryType === "single") {
      score += 8;
    } else if (primaryType === "album") {
      score += 10;
    } else if (primaryType === "ep") {
      score += 5;
    } else if (primaryType === "single") {
      score += 3;
    }
  } else {
    // Track-based fallback when album is missing: Singles and Albums are both good
    if (primaryType === "album" || primaryType === "single" || primaryType === "ep") {
      score += 8;
    }
  }

  // Secondary type & edition penalties/bonuses
  const isCandidateLive = secondaryTypes.includes("live") || candidateFlags.live;
  const isCandidateRemix =
    secondaryTypes.includes("remix") || secondaryTypes.includes("dj-mix") || candidateFlags.remix;
  const isCandidateCompilation = secondaryTypes.includes("compilation") || candidateFlags.compilation;
  const isCandidateSoundtrack = secondaryTypes.includes("soundtrack") || candidateFlags.soundtrack;

  if (isCandidateLive && !queryFlags.live) {
    score -= 28;
  } else if (isCandidateLive && queryFlags.live) {
    score += 6;
  }

  if (isCandidateRemix && !queryFlags.remix) {
    score -= 28;
  } else if (isCandidateRemix && queryFlags.remix) {
    score += 6;
  }

  if (isCandidateCompilation && !queryFlags.compilation) {
    score -= 22;
  } else if (isCandidateCompilation && queryFlags.compilation) {
    score += 6;
  }

  if (isCandidateSoundtrack && !queryFlags.soundtrack) {
    score -= 16;
  } else if (isCandidateSoundtrack && queryFlags.soundtrack) {
    score += 6;
  }

  // Deluxe vs Standard edition distinction
  if (queryFlags.deluxe) {
    if (candidateFlags.deluxe) {
      score += 5;
    } else {
      score -= 3;
    }
  } else if (candidateFlags.deluxe) {
    // Standard query vs Deluxe candidate: small penalty so standard edition wins when both exist,
    // while still allowing Deluxe if it's a strong match.
    score -= 4;
  }

  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  return {
    releaseGroup: candidate,
    mbid: candidate.id,
    confidence: clamped,
    tier: classifyTier(clamped, thresholds),
    artistScore: artistSim,
    titleScore: titleSim,
    releaseMbids: extractReleaseMbids(candidate.releases),
  };
}

function extractReleaseMbids(releases: MusicBrainzReleaseSummary[] | undefined): string[] {
  if (!Array.isArray(releases)) return [];
  // Prefer "Official" status releases first
  const sorted = [...releases].sort((a, b) => {
    const aOfficial = (a.status ?? "").toLowerCase() === "official" ? 0 : 1;
    const bOfficial = (b.status ?? "").toLowerCase() === "official" ? 0 : 1;
    return aOfficial - bOfficial;
  });
  return sorted.map((r) => r.id).filter((id) => isValidMbid(id));
}

/**
 * Scores an individual MusicBrainz Release candidate, incorporating duration and track evidence
 * when available.
 */
export function scoreReleaseCandidate(
  release: MusicBrainzReleaseSummary,
  query: MusicBrainzTrackQuery,
  thresholds: ConfidenceThresholds = activeThresholds,
): ScoredReleaseCandidate {
  const targetTitle = !isPlaceholderMetadata(query.album) ? query.album! : (query.title ?? "");
  const artistSim =
    release["artist-credit"] && release["artist-credit"].length > 0
      ? computeArtistSimilarity(query.artist, release["artist-credit"])
      : 0.85; // When fetched via release-group={MBID}, artist is already validated
  const titleSim = computeTextSimilarity(targetTitle, release.title ?? targetTitle);

  if (artistSim < 0.45 || titleSim < 0.5) {
    return {
      release,
      mbid: release.id,
      releaseGroupMbid: isValidMbid(release["release-group"]?.id) ? release["release-group"]!.id! : null,
      confidence: 25,
      tier: "low",
    };
  }

  let score = artistSim * 45 + titleSim * 42;

  if ((release.status ?? "").toLowerCase() === "official") {
    score += 8;
  }

  const queryFlags = extractEditionFlags(`${query.album ?? ""} ${query.title ?? ""}`);
  const releaseFlags = extractEditionFlags(`${release.title ?? ""} ${release.disambiguation ?? ""}`);

  const secTypes = (release["release-group"]?.["secondary-types"] ?? []).map((t) => t.toLowerCase());
  if ((secTypes.includes("live") || releaseFlags.live) && !queryFlags.live) score -= 25;
  if ((secTypes.includes("remix") || releaseFlags.remix) && !queryFlags.remix) score -= 25;
  if ((secTypes.includes("compilation") || releaseFlags.compilation) && !queryFlags.compilation) score -= 20;

  if (queryFlags.deluxe && releaseFlags.deluxe) score += 5;
  else if (!queryFlags.deluxe && releaseFlags.deluxe) score -= 4;

  // Duration and track title validation evidence when media tracks are present
  if (Array.isArray(release.media) && release.media.length > 0) {
    const allTracks = release.media.flatMap((m) => m.tracks ?? []);
    if (allTracks.length > 0 && query.title && !isPlaceholderMetadata(query.title)) {
      const matchedTrack = allTracks.find((t) => computeTextSimilarity(query.title!, t.title ?? "") >= 0.8);
      if (matchedTrack) {
        score += 5;
        if (query.durationMs && query.durationMs > 0 && matchedTrack.length && matchedTrack.length > 0) {
          const diffMs = Math.abs(query.durationMs - matchedTrack.length);
          if (diffMs <= 5000) score += 6;
          else if (diffMs <= 15000) score += 3;
          else if (diffMs > 45000) score -= 12;
        }
      }
    }
  }

  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  return {
    release,
    mbid: release.id,
    releaseGroupMbid: isValidMbid(release["release-group"]?.id) ? release["release-group"]!.id! : null,
    confidence: clamped,
    tier: classifyTier(clamped, thresholds),
  };
}

function escapeLucenePhrase(input: string): string {
  return input
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .trim();
}

export function buildReleaseGroupSearchQuery(query: MusicBrainzTrackQuery): string {
  const norm = normalizeTrackMetadata({
    title: query.title ?? "",
    artist: query.artist,
    album: query.album ?? "",
    durationMs: query.durationMs ?? null,
    fileName: "",
  });

  const primaryArtist = extractPrimaryArtist(norm.artist || query.artist);
  const targetTitle = !isPlaceholderMetadata(norm.album)
    ? norm.album!
    : !isPlaceholderMetadata(query.album)
      ? cleanNoiseFromText(query.album!).cleaned
      : cleanNoiseFromText(norm.title || query.title || "").cleaned;

  // Use core album title without "(Deluxe Edition)" noise for broader recall,
  // then rank editions with scoreReleaseGroupCandidate.
  const coreAlbum = normalizeCoreTitle(targetTitle) || targetTitle;
  const escapedArtist = escapeLucenePhrase(primaryArtist);
  const escapedAlbum = escapeLucenePhrase(coreAlbum);

  return `artist:"${escapedArtist}" AND releasegroup:"${escapedAlbum}"`;
}

export function buildReleaseSearchQuery(query: MusicBrainzTrackQuery): string {
  const norm = normalizeTrackMetadata({
    title: query.title ?? "",
    artist: query.artist,
    album: query.album ?? "",
    durationMs: query.durationMs ?? null,
    fileName: "",
  });
  const primaryArtist = extractPrimaryArtist(norm.artist || query.artist);
  const hasAlbum = !isPlaceholderMetadata(norm.album) || !isPlaceholderMetadata(query.album);
  const albumOrTrack = hasAlbum
    ? normalizeCoreTitle(norm.album || query.album) || norm.album || query.album || ""
    : normalizeCoreTitle(norm.title || query.title) || norm.title || query.title || "";

  const escapedArtist = escapeLucenePhrase(primaryArtist);
  const escapedTarget = escapeLucenePhrase(albumOrTrack);

  if (hasAlbum) {
    return `artist:"${escapedArtist}" AND release:"${escapedTarget}"`;
  }
  return `artist:"${escapedArtist}" AND (release:"${escapedTarget}" OR recording:"${escapedTarget}")`;
}

function getMetadataProxyBaseUrl(): string | null {
  const customProxy = (import.meta.env.VITE_METADATA_PROXY_URL ?? "").trim().replace(/\/+$/, "");
  if (customProxy) return customProxy;
  if (workerConfigured()) return workerUrl();
  return null;
}

async function waitForRateLimitSlot(): Promise<void> {
  if (minRequestIntervalMs <= 0) return;
  const now = Date.now();
  const scheduled = Math.max(now, nextAllowedAtMs);
  const waitMs = scheduled - now;
  nextAllowedAtMs = scheduled + minRequestIntervalMs;
  if (waitMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  }
}

interface RawMusicBrainzResponse<T> {
  status: MusicBrainzFetchStatus;
  data: T | null;
}

async function fetchMusicBrainzJson<T>(
  entity: "release-group" | "release",
  params: Record<string, string>,
): Promise<RawMusicBrainzResponse<T>> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { status: "transient-error", data: null };
  }
  // Never make real external network calls in unit tests when fetch is not mocked
  if (import.meta.env.MODE === "test" && typeof fetch === "function" && !("mock" in fetch)) {
    return { status: "transient-error", data: null };
  }

  await waitForRateLimitSlot();

  const searchParams = new URLSearchParams({ ...params, fmt: "json" });
  const proxyBase = getMetadataProxyBaseUrl();

  // 1. Try optional Cloudflare Worker proxy first when configured
  if (proxyBase) {
    const proxyUrl = `${proxyBase}/api/musicbrainz/${entity}?${searchParams.toString()}`;
    try {
      const response = await fetch(proxyUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (response.ok) {
        const json = (await response.json()) as T;
        return { status: "ok", data: json };
      }
      if (response.status === 429 || response.status === 503) {
        return { status: "transient-error", data: null };
      }
      // If proxy route returns 404 with an entity not-found code, treat as not-found;
      // if Worker is older and returns 400 "Unknown endpoint", fall through to direct MusicBrainz WS/2.
      if (response.status === 404) {
        return { status: "not-found", data: null };
      }
    } catch {
      // Worker unreachable -> fall through to direct MusicBrainz WS/2
    }
  }

  // 2. Direct MusicBrainz WS/2 request (with identifiable User-Agent header)
  const directUrl = `${MUSICBRAINZ_WS_BASE}/${entity}?${searchParams.toString()}`;
  try {
    const response = await fetch(directUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": GMUSIC_USER_AGENT,
      },
    });
    if (response.status === 404) {
      return { status: "not-found", data: null };
    }
    if (response.status === 429 || response.status === 503 || response.status >= 500) {
      return { status: "transient-error", data: null };
    }
    if (!response.ok) {
      return { status: "not-found", data: null };
    }
    const json = (await response.json()) as T;
    return { status: "ok", data: json };
  } catch {
    return { status: "transient-error", data: null };
  }
}

/**
 * Searches MusicBrainz Release Groups and ranks candidates by confidence score.
 */
export async function searchMusicBrainzReleaseGroups(
  query: MusicBrainzTrackQuery,
  thresholds: ConfidenceThresholds = activeThresholds,
): Promise<MusicBrainzDiscoveryResult> {
  if (!hasSufficientMetadataForMusicBrainz(query)) {
    return {
      status: "skipped",
      candidates: [],
      bestCandidate: null,
      secondaryCandidates: [],
    };
  }

  const luceneQuery = buildReleaseGroupSearchQuery(query);
  const response = await fetchMusicBrainzJson<{ "release-groups"?: MusicBrainzReleaseGroup[] }>(
    "release-group",
    {
      query: luceneQuery,
      limit: "10",
    },
  );

  if (response.status !== "ok" || !response.data) {
    return {
      status: response.status,
      candidates: [],
      bestCandidate: null,
      secondaryCandidates: [],
    };
  }

  const rawGroups = Array.isArray(response.data["release-groups"])
    ? response.data["release-groups"].filter((g) => g && isValidMbid(g.id))
    : [];

  if (rawGroups.length === 0) {
    return {
      status: "not-found",
      candidates: [],
      bestCandidate: null,
      secondaryCandidates: [],
    };
  }

  const scored = rawGroups
    .map((group) => scoreReleaseGroupCandidate(group, query, thresholds))
    .filter((candidate) => candidate.tier !== "low")
    .sort((a, b) => b.confidence - a.confidence);

  if (scored.length === 0) {
    return {
      status: "not-found",
      candidates: [],
      bestCandidate: null,
      secondaryCandidates: [],
    };
  }

  return {
    status: "ok",
    candidates: scored,
    bestCandidate: scored[0],
    secondaryCandidates: scored.slice(1),
  };
}

/**
 * Fetches releases belonging to a known Release Group MBID so release-level CAA artwork
 * can be inspected when release-group artwork is missing.
 */
export async function fetchReleasesForReleaseGroup(
  releaseGroupMbid: string,
  query: MusicBrainzTrackQuery,
  thresholds: ConfidenceThresholds = activeThresholds,
): Promise<{ status: MusicBrainzFetchStatus; releases: ScoredReleaseCandidate[] }> {
  if (!isValidMbid(releaseGroupMbid)) {
    return { status: "not-found", releases: [] };
  }

  const response = await fetchMusicBrainzJson<{ releases?: MusicBrainzReleaseSummary[] }>("release", {
    "release-group": releaseGroupMbid.toLowerCase(),
    inc: "recordings+media+artist-credits",
    limit: "10",
  });

  if (response.status !== "ok" || !response.data) {
    return { status: response.status, releases: [] };
  }

  const rawReleases = Array.isArray(response.data.releases)
    ? response.data.releases.filter((r) => r && isValidMbid(r.id))
    : [];

  if (rawReleases.length === 0) {
    return { status: "not-found", releases: [] };
  }

  const scored = rawReleases
    .map((rel) => scoreReleaseCandidate(rel, query, thresholds))
    .filter((rel) => rel.tier !== "low")
    .sort((a, b) => b.confidence - a.confidence);

  return {
    status: scored.length > 0 ? "ok" : "not-found",
    releases: scored,
  };
}

/**
 * Additional fallback: searches MusicBrainz Releases directly when Release Group search
 * had no match or only medium confidence without release-group artwork.
 */
export async function searchMusicBrainzReleases(
  query: MusicBrainzTrackQuery,
  thresholds: ConfidenceThresholds = activeThresholds,
): Promise<{ status: MusicBrainzFetchStatus; releases: ScoredReleaseCandidate[] }> {
  if (!hasSufficientMetadataForMusicBrainz(query)) {
    return { status: "skipped", releases: [] };
  }

  const luceneQuery = buildReleaseSearchQuery(query);
  const response = await fetchMusicBrainzJson<{ releases?: MusicBrainzReleaseSummary[] }>("release", {
    query: luceneQuery,
    limit: "10",
  });

  if (response.status !== "ok" || !response.data) {
    return { status: response.status, releases: [] };
  }

  const rawReleases = Array.isArray(response.data.releases)
    ? response.data.releases.filter((r) => r && isValidMbid(r.id))
    : [];

  if (rawReleases.length === 0) {
    return { status: "not-found", releases: [] };
  }

  const scored = rawReleases
    .map((rel) => scoreReleaseCandidate(rel, query, thresholds))
    .filter((rel) => rel.tier !== "low")
    .sort((a, b) => b.confidence - a.confidence);

  return {
    status: scored.length > 0 ? "ok" : "not-found",
    releases: scored,
  };
}
