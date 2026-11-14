export type ArtworkHealthState = "VALID" | "MISSING" | "CORRUPTED" | "BROKEN_URL" | "STALE";

export type ArtworkFailureReason =
  | "METADATA_INSUFFICIENT"
  | "NO_PROVIDER_MATCH"
  | "MUSICBRAINZ_NOT_FOUND"
  | "CAA_ARTWORK_NOT_FOUND"
  | "ITUNES_NO_MATCH"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_TIMEOUT"
  | "NETWORK_ERROR"
  | "CANDIDATE_REJECTED"
  | "IMAGE_DOWNLOAD_FAILED"
  | "IMAGE_DECODE_FAILED"
  | "INDEXEDDB_WRITE_FAILED";

export interface CandidateScoreDiagnostic {
  title: string;
  artist?: string;
  confidence: number;
  accepted: boolean;
  rejectionReason?: string;
}

export type ProviderStageClassification =
  | "ok"
  | "not-found"
  | "no-results"
  | "candidates-rejected"
  | "rate-limited"
  | "timeout"
  | "network-error"
  | "http-error"
  | "skipped"
  | "not-queried";

export interface MusicBrainzStageDiagnostic {
  skipped: boolean;
  skipReason?: string;
  httpStatus: number | null;
  classification: ProviderStageClassification;
  releaseGroupCount: number;
  acceptedCandidateCount: number;
  rejectedCandidateCount: number;
  candidateScores: CandidateScoreDiagnostic[];
  failedRequests: number;
  directReleaseFallback: {
    queried: boolean;
    httpStatus: number | null;
    classification: ProviderStageClassification;
    releaseCount: number;
    acceptedCount: number;
    rejectedCount: number;
    topScore?: number;
    rejectionReason?: string;
  };
}

export interface CaaStageDiagnostic {
  queried: boolean;
  releaseGroupHttpStatus: number | null;
  releaseGroupClassification: ProviderStageClassification;
  releaseHttpStatus: number | null;
  releaseClassification: ProviderStageClassification;
  failedRequests: number;
}

export interface ItunesStageDiagnostic {
  queried: boolean;
  httpStatus: number | null;
  classification: ProviderStageClassification;
  queriesAttempted: number;
  resultCount: number;
  acceptedCount: number;
  rejectedCount: number;
  candidateScores: CandidateScoreDiagnostic[];
  usedAlbumFallback: boolean;
  failedRequests: number;
}

export interface ImageDownloadDiagnostic {
  attempted: boolean;
  httpStatus: number | null;
  classification:
    | "ok"
    | "cors-displayable"
    | "cors-blocked"
    | "http-error"
    | "rate-limited"
    | "timeout"
    | "network-error"
    | "offline"
    | "not-attempted";
  failedRequests: number;
}

export interface ImageDecodeDiagnostic {
  attempted: boolean;
  valid: boolean | null;
  reason?:
    | "ok"
    | "cors-displayable"
    | "invalid-mime"
    | "html-or-json"
    | "undersized"
    | "oversized"
    | "decode-failed"
    | "not-attempted";
}

export interface IndexedDbPersistenceDiagnostic {
  attempted: boolean;
  ok: boolean | null;
  reason?: "ok" | "write-failed" | "skipped-cors" | "not-attempted";
}

export interface TrackDiscoveryDiagnostic {
  originalTitle: string;
  originalArtist: string;
  originalAlbum: string;
  normalizedTitle: string;
  normalizedArtist: string;
  normalizedAlbum?: string;
  musicbrainz: MusicBrainzStageDiagnostic;
  caa: CaaStageDiagnostic;
  itunes: ItunesStageDiagnostic;
  selectedProvider: "musicbrainz-caa" | "itunes" | "none";
  selectedArtworkHost: string | null;
  failedHttpRequests: number;
  observedFailures: ArtworkFailureReason[];
}

export interface TrackArtworkDiagnostic {
  trackId: string;
  originalTitle: string;
  originalArtist: string;
  originalAlbum: string;
  normalizedTitle: string;
  normalizedArtist: string;
  normalizedAlbum?: string;
  healthBefore: ArtworkHealthState;
  outcome: "restored" | "failed" | "skipped-offline";
  primaryReason: ArtworkFailureReason | null;
  secondaryReasons: ArtworkFailureReason[];
  selectedProvider: "cloud" | "sibling-album" | "musicbrainz-caa" | "itunes" | "none";
  selectedArtworkHost: string | null;
  musicbrainz: MusicBrainzStageDiagnostic;
  caa: CaaStageDiagnostic;
  itunes: ItunesStageDiagnostic;
  imageDownload: ImageDownloadDiagnostic;
  imageDecode: ImageDecodeDiagnostic;
  indexedDb: IndexedDbPersistenceDiagnostic;
  failedHttpRequests: number;
}

export function createEmptyMusicBrainzDiagnostic(): MusicBrainzStageDiagnostic {
  return {
    skipped: false,
    httpStatus: null,
    classification: "not-queried",
    releaseGroupCount: 0,
    acceptedCandidateCount: 0,
    rejectedCandidateCount: 0,
    candidateScores: [],
    failedRequests: 0,
    directReleaseFallback: {
      queried: false,
      httpStatus: null,
      classification: "not-queried",
      releaseCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
    },
  };
}

export function createEmptyCaaDiagnostic(): CaaStageDiagnostic {
  return {
    queried: false,
    releaseGroupHttpStatus: null,
    releaseGroupClassification: "not-queried",
    releaseHttpStatus: null,
    releaseClassification: "not-queried",
    failedRequests: 0,
  };
}

export function createEmptyItunesDiagnostic(): ItunesStageDiagnostic {
  return {
    queried: false,
    httpStatus: null,
    classification: "not-queried",
    queriesAttempted: 0,
    resultCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    candidateScores: [],
    usedAlbumFallback: false,
    failedRequests: 0,
  };
}

/**
 * Extracts only the hostname from a remote HTTP(S) URL so signed query strings,
 * auth tokens, and local blob URIs are never logged or displayed.
 */
export function extractSafeUrlHost(rawUrl: string | null | undefined): string | null {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith("blob:") || trimmed.startsWith("data:")) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname || null;
  } catch {
    return null;
  }
}

const FAILURE_PRECEDENCE: ArtworkFailureReason[] = [
  "INDEXEDDB_WRITE_FAILED",
  "IMAGE_DECODE_FAILED",
  "IMAGE_DOWNLOAD_FAILED",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_TIMEOUT",
  "NETWORK_ERROR",
  "CANDIDATE_REJECTED",
  "METADATA_INSUFFICIENT",
  "CAA_ARTWORK_NOT_FOUND",
  "ITUNES_NO_MATCH",
  "MUSICBRAINZ_NOT_FOUND",
  "NO_PROVIDER_MATCH",
];

export function classifyTrackFailure(params: {
  musicbrainz: MusicBrainzStageDiagnostic;
  caa: CaaStageDiagnostic;
  itunes: ItunesStageDiagnostic;
  imageDownload: ImageDownloadDiagnostic;
  imageDecode: ImageDecodeDiagnostic;
  indexedDb: IndexedDbPersistenceDiagnostic;
  observedFailures: ArtworkFailureReason[];
}): { primaryReason: ArtworkFailureReason; secondaryReasons: ArtworkFailureReason[] } {
  const collected = new Set<ArtworkFailureReason>(params.observedFailures);

  const mb = params.musicbrainz;
  const caa = params.caa;
  const it = params.itunes;
  const dl = params.imageDownload;
  const dec = params.imageDecode;
  const idb = params.indexedDb;

  if (idb.attempted && idb.ok === false) {
    collected.add("INDEXEDDB_WRITE_FAILED");
  }
  if (dec.attempted && dec.valid === false) {
    collected.add("IMAGE_DECODE_FAILED");
  }
  if (dl.attempted && dl.classification !== "ok" && dl.classification !== "cors-displayable" && dl.classification !== "not-attempted") {
    if (dl.classification === "timeout") {
      collected.add("PROVIDER_TIMEOUT");
      collected.add("IMAGE_DOWNLOAD_FAILED");
    } else if (dl.classification === "rate-limited") {
      collected.add("PROVIDER_RATE_LIMITED");
      collected.add("IMAGE_DOWNLOAD_FAILED");
    } else if (dl.classification === "network-error" || dl.classification === "offline") {
      collected.add("NETWORK_ERROR");
      collected.add("IMAGE_DOWNLOAD_FAILED");
    } else if (dec.valid !== false) {
      collected.add("IMAGE_DOWNLOAD_FAILED");
    }
  }

  // Classify provider transport failures without masking missing catalogue results as network errors.
  const stages: Array<{ classification: ProviderStageClassification }> = [
    { classification: mb.classification },
    { classification: mb.directReleaseFallback.classification },
    { classification: caa.releaseGroupClassification },
    { classification: caa.releaseClassification },
    { classification: it.classification },
  ];

  for (const s of stages) {
    if (s.classification === "rate-limited") collected.add("PROVIDER_RATE_LIMITED");
    if (s.classification === "timeout") collected.add("PROVIDER_TIMEOUT");
    if (s.classification === "network-error") collected.add("NETWORK_ERROR");
    if (s.classification === "http-error") collected.add("NETWORK_ERROR");
  }

  const anyCandidateRejected =
    (mb.releaseGroupCount > 0 && mb.acceptedCandidateCount === 0) ||
    (mb.directReleaseFallback.releaseCount > 0 && mb.directReleaseFallback.acceptedCount === 0) ||
    (it.resultCount > 0 && it.acceptedCount === 0);

  if (anyCandidateRejected) {
    collected.add("CANDIDATE_REJECTED");
  }

  if (mb.skipped && (!it.queried || it.classification === "skipped")) {
    collected.add("METADATA_INSUFFICIENT");
  }

  const mbFoundAcceptableReleaseGroup = mb.acceptedCandidateCount > 0 || mb.directReleaseFallback.acceptedCount > 0;
  const caaMissed =
    caa.queried &&
    (caa.releaseGroupClassification === "not-found" ||
      caa.releaseClassification === "not-found" ||
      caa.releaseGroupClassification === "not-queried");
  if (mbFoundAcceptableReleaseGroup && caaMissed) {
    collected.add("CAA_ARTWORK_NOT_FOUND");
  } else if (mb.classification === "not-found" && mb.releaseGroupCount === 0) {
    collected.add("MUSICBRAINZ_NOT_FOUND");
  }

  if (it.queried && (it.classification === "no-results" || (it.classification === "not-found" && it.resultCount === 0))) {
    collected.add("ITUNES_NO_MATCH");
  }

  if (
    collected.has("MUSICBRAINZ_NOT_FOUND") &&
    (collected.has("ITUNES_NO_MATCH") || !it.queried) &&
    !collected.has("CANDIDATE_REJECTED")
  ) {
    collected.add("NO_PROVIDER_MATCH");
  }

  if (collected.size === 0) {
    collected.add("NO_PROVIDER_MATCH");
  }

  // Choose primary failure reason respecting explicit priority while keeping all secondary failures.
  let primary: ArtworkFailureReason | undefined;

  // Prefer IMAGE_DOWNLOAD_FAILED over generic NETWORK_ERROR when an already-selected URL download returned broken/404 or failed after CORS fallback.
  if (collected.has("IMAGE_DECODE_FAILED")) {
    primary = "IMAGE_DECODE_FAILED";
  } else if (collected.has("INDEXEDDB_WRITE_FAILED")) {
    primary = "INDEXEDDB_WRITE_FAILED";
  } else if (
    collected.has("IMAGE_DOWNLOAD_FAILED") &&
    !collected.has("PROVIDER_RATE_LIMITED") &&
    !collected.has("PROVIDER_TIMEOUT")
  ) {
    primary = "IMAGE_DOWNLOAD_FAILED";
  } else if (
    collected.has("NO_PROVIDER_MATCH") &&
    !collected.has("PROVIDER_RATE_LIMITED") &&
    !collected.has("PROVIDER_TIMEOUT") &&
    !collected.has("NETWORK_ERROR") &&
    !collected.has("CANDIDATE_REJECTED") &&
    !collected.has("CAA_ARTWORK_NOT_FOUND") &&
    !collected.has("IMAGE_DOWNLOAD_FAILED") &&
    !collected.has("IMAGE_DECODE_FAILED") &&
    !collected.has("INDEXEDDB_WRITE_FAILED")
  ) {
    primary = "NO_PROVIDER_MATCH";
  } else {
    for (const reason of FAILURE_PRECEDENCE) {
      if (collected.has(reason)) {
        primary = reason;
        break;
      }
    }
  }

  const finalPrimary = primary ?? "NO_PROVIDER_MATCH";
  const secondaryReasons = Array.from(collected).filter((r) => r !== finalPrimary);
  return { primaryReason: finalPrimary, secondaryReasons };
}

export function formatMusicBrainzStatusLine(mb: MusicBrainzStageDiagnostic): string {
  if (mb.skipped) {
    return `Skipped (${mb.skipReason ?? "insufficient metadata"})`;
  }
  switch (mb.classification) {
    case "rate-limited":
      return mb.httpStatus ? `HTTP ${mb.httpStatus} (rate limited)` : "Rate limited";
    case "timeout":
      return "Request timeout";
    case "network-error":
      return "Network error";
    case "http-error":
      return mb.httpStatus ? `HTTP ${mb.httpStatus}` : "HTTP error";
    case "candidates-rejected": {
      const top = mb.candidateScores[0];
      return top
        ? `${mb.rejectedCandidateCount} release group${mb.rejectedCandidateCount === 1 ? "" : "s"} rejected (${top.rejectionReason ?? `score ${top.confidence}`})`
        : "Candidates rejected";
    }
    case "not-found":
      return mb.directReleaseFallback.queried && mb.directReleaseFallback.classification === "candidates-rejected"
        ? `No matching release group; ${mb.directReleaseFallback.rejectedCount} release candidate${mb.directReleaseFallback.rejectedCount === 1 ? "" : "s"} rejected`
        : "No matching release group";
    case "ok":
      return `Matched release group (${mb.acceptedCandidateCount} accepted)`;
    case "not-queried":
    default:
      return "Not queried";
  }
}

export function formatCaaStatusLine(caa: CaaStageDiagnostic): string {
  if (!caa.queried) return "Not queried";
  const pickLabel = (status: number | null, cls: ProviderStageClassification) => {
    switch (cls) {
      case "ok":
        return "OK";
      case "not-found":
        return status === 404 ? "HTTP 404 (no artwork)" : "No cover art found";
      case "rate-limited":
        return status ? `HTTP ${status} (rate limited)` : "Rate limited";
      case "timeout":
        return "Request timeout";
      case "network-error":
        return "Network error";
      case "http-error":
        return status ? `HTTP ${status}` : "HTTP error";
      default:
        return "Not queried";
    }
  };
  if (caa.releaseClassification !== "not-queried") {
    return `${pickLabel(caa.releaseGroupHttpStatus, caa.releaseGroupClassification)} / Release: ${pickLabel(caa.releaseHttpStatus, caa.releaseClassification)}`;
  }
  return pickLabel(caa.releaseGroupHttpStatus, caa.releaseGroupClassification);
}

export function formatItunesStatusLine(it: ItunesStageDiagnostic): string {
  if (!it.queried) return "Not queried";
  switch (it.classification) {
    case "ok":
      return `Matched (${it.acceptedCount} acceptable candidate${it.acceptedCount === 1 ? "" : "s"})`;
    case "no-results":
    case "not-found":
      return "0 results";
    case "candidates-rejected": {
      const top = it.candidateScores[0];
      return top
        ? `0 acceptable candidates (${it.resultCount} rejected: ${top.rejectionReason ?? `score ${top.confidence}`})`
        : `0 acceptable candidates (${it.resultCount} returned)`;
    }
    case "rate-limited":
      return it.httpStatus ? `HTTP ${it.httpStatus} (rate limited)` : "Rate limited";
    case "timeout":
      return "Request timeout";
    case "network-error":
      return "Network error";
    case "http-error":
      return it.httpStatus ? `HTTP ${it.httpStatus}` : "HTTP error";
    case "skipped":
      return "Skipped (insufficient metadata)";
    case "not-queried":
    default:
      return "Not queried";
  }
}

export function isProviderFailureReason(reason: ArtworkFailureReason): boolean {
  return (
    reason === "PROVIDER_RATE_LIMITED" ||
    reason === "PROVIDER_TIMEOUT" ||
    reason === "NETWORK_ERROR" ||
    reason === "IMAGE_DOWNLOAD_FAILED"
  );
}

/**
 * Recognizes AbortError across DOMException, standard Error subclasses, and fetch polyfills.
 */
export function isAbortError(err: unknown): boolean {
  return (
    err != null &&
    typeof err === "object" &&
    "name" in err &&
    (err as { name?: unknown }).name === "AbortError"
  );
}
