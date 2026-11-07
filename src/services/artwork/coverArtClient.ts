import { isValidMbid } from "./musicbrainzClient";

/**
 * Cover Art Archive (CAA) client.
 *
 * Official endpoints:
 *  - Release Group metadata: https://coverartarchive.org/release-group/{MBID}
 *  - Release Group front:    https://coverartarchive.org/release-group/{MBID}/front
 *  - Preferred thumbnail:    https://coverartarchive.org/release-group/{MBID}/front-500
 *  - Release fallback:       https://coverartarchive.org/release/{MBID}/front-500
 */

export const CAA_BASE_URL = "https://coverartarchive.org";

export type ArtworkThumbnailSize = "500" | "1200";

export type CoverArtStatus = "ok" | "not-found" | "transient-error" | "invalid-mbid";

export interface CoverArtResolution {
  status: CoverArtStatus;
  url: string | null;
  releaseGroupMbid: string | null;
  releaseMbid: string | null;
}

interface CaaThumbnails {
  "250"?: string;
  "500"?: string;
  "1200"?: string;
  small?: string;
  large?: string;
  xl?: string;
}

interface CaaImageEntry {
  front?: boolean;
  back?: boolean;
  approved?: boolean;
  image?: string;
  types?: string[];
  thumbnails?: CaaThumbnails;
}

interface CaaMetadataResponse {
  release?: string;
  images?: CaaImageEntry[];
}

const ALLOWED_ARTWORK_HOSTS = [
  "coverartarchive.org",
  "archive.org",
  "mzstatic.com",
];

/**
 * Validates that a candidate artwork URL is well-formed HTTP/HTTPS and points to
 * a trusted artwork host (Cover Art Archive, Internet Archive, or Apple mzstatic).
 * Never accepts `javascript:`, `data:`, or arbitrary third-party hosts.
 */
export function isValidArtworkUrl(rawUrl: string | null | undefined): rawUrl is string {
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) return false;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    return ALLOWED_ARTWORK_HOSTS.some(
      (allowed) => host === allowed || host.endsWith(`.${allowed}`),
    );
  } catch {
    return false;
  }
}

/**
 * Validates and upgrades `http://` CAA/Archive URLs to `https://` to prevent mixed-content warnings.
 */
export function sanitizeArtworkUrl(rawUrl: string | null | undefined): string | null {
  if (!isValidArtworkUrl(rawUrl)) return null;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol === "http:") {
      parsed.protocol = "https:";
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Constructs a validated Cover Art Archive Release Group front thumbnail URL.
 * Returns null if the MBID is not a valid UUID.
 */
export function buildReleaseGroupFrontUrl(
  mbid: string,
  size: ArtworkThumbnailSize | "full" = "500",
): string | null {
  if (!isValidMbid(mbid)) return null;
  const cleanMbid = mbid.trim().toLowerCase();
  if (size === "full") {
    return `${CAA_BASE_URL}/release-group/${cleanMbid}/front`;
  }
  return `${CAA_BASE_URL}/release-group/${cleanMbid}/front-${size}`;
}

/**
 * Constructs a validated Cover Art Archive Release front thumbnail URL.
 * Returns null if the MBID is not a valid UUID.
 */
export function buildReleaseFrontUrl(
  mbid: string,
  size: ArtworkThumbnailSize | "full" = "500",
): string | null {
  if (!isValidMbid(mbid)) return null;
  const cleanMbid = mbid.trim().toLowerCase();
  if (size === "full") {
    return `${CAA_BASE_URL}/release/${cleanMbid}/front`;
  }
  return `${CAA_BASE_URL}/release/${cleanMbid}/front-${size}`;
}

function extractMbidFromReleaseUrl(releaseUrl: string | undefined): string | null {
  if (typeof releaseUrl !== "string") return null;
  const match = releaseUrl.match(/\/release\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i);
  if (!match) return null;
  return isValidMbid(match[1]) ? match[1].toLowerCase() : null;
}

function selectPreferredFrontImageUrl(
  payload: CaaMetadataResponse,
  fallbackFrontUrl: string | null,
  size: ArtworkThumbnailSize,
): string | null {
  const images = Array.isArray(payload.images) ? payload.images : [];
  if (images.length === 0) return null;

  // 1. Prefer image explicitly marked `front: true`, then type containing "Front", then first image
  const frontEntry =
    images.find((img) => img && img.front === true) ??
    images.find((img) => Array.isArray(img?.types) && img.types.some((t) => t.toLowerCase() === "front")) ??
    images[0];

  if (!frontEntry) return null;

  const thumbs = frontEntry.thumbnails;
  const candidates: Array<string | undefined | null> =
    size === "1200"
      ? [thumbs?.["1200"], thumbs?.xl, frontEntry.image, thumbs?.["500"], thumbs?.large, fallbackFrontUrl]
      : [thumbs?.["500"], thumbs?.large, fallbackFrontUrl, thumbs?.["1200"], frontEntry.image, thumbs?.["250"], thumbs?.small];

  for (const candidate of candidates) {
    const sanitized = sanitizeArtworkUrl(candidate);
    if (sanitized) return sanitized;
  }

  return null;
}

async function fetchCaaEndpoint(
  entity: "release-group" | "release",
  mbid: string,
  size: ArtworkThumbnailSize = "500",
): Promise<CoverArtResolution> {
  if (!isValidMbid(mbid)) {
    return {
      status: "invalid-mbid",
      url: null,
      releaseGroupMbid: null,
      releaseMbid: null,
    };
  }

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return {
      status: "transient-error",
      url: null,
      releaseGroupMbid: entity === "release-group" ? mbid.toLowerCase() : null,
      releaseMbid: entity === "release" ? mbid.toLowerCase() : null,
    };
  }
  if (import.meta.env.MODE === "test" && typeof fetch === "function" && !("mock" in fetch)) {
    return {
      status: "transient-error",
      url: null,
      releaseGroupMbid: entity === "release-group" ? mbid.toLowerCase() : null,
      releaseMbid: entity === "release" ? mbid.toLowerCase() : null,
    };
  }

  const cleanMbid = mbid.trim().toLowerCase();
  const metadataUrl = `${CAA_BASE_URL}/${entity}/${cleanMbid}`;
  const canonicalThumbUrl =
    entity === "release-group"
      ? buildReleaseGroupFrontUrl(cleanMbid, size)
      : buildReleaseFrontUrl(cleanMbid, size);

  try {
    const response = await fetch(metadataUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (response.status === 404) {
      return {
        status: "not-found",
        url: null,
        releaseGroupMbid: entity === "release-group" ? cleanMbid : null,
        releaseMbid: entity === "release" ? cleanMbid : null,
      };
    }

    if (response.status === 429 || response.status === 503 || response.status >= 500) {
      return {
        status: "transient-error",
        url: null,
        releaseGroupMbid: entity === "release-group" ? cleanMbid : null,
        releaseMbid: entity === "release" ? cleanMbid : null,
      };
    }

    if (!response.ok) {
      return {
        status: "not-found",
        url: null,
        releaseGroupMbid: entity === "release-group" ? cleanMbid : null,
        releaseMbid: entity === "release" ? cleanMbid : null,
      };
    }

    const payload = (await response.json()) as CaaMetadataResponse;
    const selectedUrl = selectPreferredFrontImageUrl(payload, canonicalThumbUrl, size);
    const extractedReleaseMbid =
      entity === "release" ? cleanMbid : extractMbidFromReleaseUrl(payload.release);

    if (!selectedUrl) {
      return {
        status: "not-found",
        url: null,
        releaseGroupMbid: entity === "release-group" ? cleanMbid : null,
        releaseMbid: extractedReleaseMbid,
      };
    }

    // Prefer the canonical `/front-500` or `/front-1200` endpoint when on coverartarchive.org,
    // or the validated thumbnail URL returned by CAA metadata.
    return {
      status: "ok",
      url: selectedUrl,
      releaseGroupMbid: entity === "release-group" ? cleanMbid : null,
      releaseMbid: extractedReleaseMbid,
    };
  } catch {
    return {
      status: "transient-error",
      url: null,
      releaseGroupMbid: entity === "release-group" ? cleanMbid : null,
      releaseMbid: entity === "release" ? cleanMbid : null,
    };
  }
}

/**
 * Queries Cover Art Archive for a Release Group MBID.
 * Prefers `Front` artwork at `500px` thumbnail resolution (or `1200px` when requested).
 */
export async function fetchReleaseGroupCoverArt(
  releaseGroupMbid: string,
  options?: { size?: ArtworkThumbnailSize },
): Promise<CoverArtResolution> {
  return fetchCaaEndpoint("release-group", releaseGroupMbid, options?.size ?? "500");
}

/**
 * Queries Cover Art Archive for an individual Release MBID (`https://coverartarchive.org/release/{MBID}`).
 * Used as a fallback when Release Group cover art is unavailable.
 */
export async function fetchReleaseCoverArt(
  releaseMbid: string,
  options?: { size?: ArtworkThumbnailSize },
): Promise<CoverArtResolution> {
  return fetchCaaEndpoint("release", releaseMbid, options?.size ?? "500");
}
