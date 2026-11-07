/**
 * Deterministic rule-based error summarization for Gmusic playback errors.
 * Produces high-level summary and classification for notifications while preserving
 * the verbatim raw message for Broken page inspection.
 */

export type PlaybackErrorCategory =
  | "missing"
  | "corrupted"
  | "unsupported"
  | "decoding"
  | "permission"
  | "network"
  | "unreadable"
  | "playback";

export type PlaybackErrorSummary = {
  title: string;
  summary: string;
  category: PlaybackErrorCategory;
  originalMessage: string;
  errorCode?: string;
};

interface MediaErrorLike {
  code?: number;
  message?: string;
}

/** Strips local file paths, stack traces, and noise for clean user summary */
function sanitizeSummaryText(text: string): string {
  return text
    // Remove stack trace lines
    .replace(/^\s*at\s+.*$/gm, "")
    // Remove Windows/Unix file paths
    .replace(/[a-zA-Z]:\\[^\s:;,)]+/g, "")
    .replace(/\/(?:[a-zA-Z0-9._-]+\/)+[a-zA-Z0-9._-]+/g, "")
    // Remove file:/// URIs
    .replace(/file:\/\/\/[^\s:;,)]+/g, "")
    // Collapse excess spaces/newlines
    .replace(/\s+/g, " ")
    .trim();
}

export function summarizePlaybackError(
  error: unknown,
  _context?: { trackTitle?: string; artist?: string }
): PlaybackErrorSummary {
  let rawMessage = "";
  let errorCode: string | undefined;

  // Extract raw message and code
  if (typeof error === "string") {
    rawMessage = error;
  } else if (error && typeof error === "object") {
    const errObj = error as Record<string, unknown>;

    // DOMException check
    if (typeof DOMException !== "undefined" && error instanceof DOMException) {
      errorCode = error.name;
      rawMessage = error.message ? `${error.name}: ${error.message}` : error.name;
    } else if (error instanceof Error) {
      rawMessage = error.message || error.name;
      if (error.name && error.name !== "Error") {
        errorCode = error.name;
      }
    } else if ("code" in errObj && typeof (errObj as MediaErrorLike).code === "number") {
      const code = (errObj as MediaErrorLike).code;
      const msg = typeof (errObj as MediaErrorLike).message === "string" ? (errObj as MediaErrorLike).message : "";
      switch (code) {
        case 1:
          errorCode = "MEDIA_ERR_ABORTED (1)";
          break;
        case 2:
          errorCode = "MEDIA_ERR_NETWORK (2)";
          break;
        case 3:
          errorCode = "MEDIA_ERR_DECODE (3)";
          break;
        case 4:
          errorCode = "MEDIA_ERR_SRC_NOT_SUPPORTED (4)";
          break;
        default:
          errorCode = `MEDIA_ERR (${code})`;
      }
      rawMessage = msg ? `${errorCode}: ${msg}` : errorCode;
    } else {
      rawMessage = typeof errObj.message === "string" ? errObj.message : JSON.stringify(error);
    }
  }

  const clean = sanitizeSummaryText(rawMessage);
  const lower = (rawMessage + " " + (errorCode ?? "")).toLowerCase();

  // 1. Missing / Not Found
  if (
    errorCode === "NotFoundError" ||
    lower.includes("not found") ||
    lower.includes("notfound") ||
    lower.includes("no such file") ||
    lower.includes("missing")
  ) {
    return {
      title: "Audio not found",
      summary: "The audio file could not be found or opened.",
      category: "missing",
      originalMessage: rawMessage,
      errorCode,
    };
  }

  // 2. Source unavailable
  if (
    (lower.includes("source") && (lower.includes("no longer available") || lower.includes("unavailable"))) ||
    lower.includes("source unavailable")
  ) {
    return {
      title: "Source unavailable",
      summary: "The audio source is no longer available.",
      category: "missing",
      originalMessage: rawMessage,
      errorCode,
    };
  }

  // 3. Permission / Access denied
  if (
    errorCode === "SecurityError" ||
    errorCode === "NotAllowedError" ||
    lower.includes("permission") ||
    lower.includes("access denied") ||
    lower.includes("not allowed")
  ) {
    return {
      title: "Access denied",
      summary: "Permission to access this audio file was denied.",
      category: "permission",
      originalMessage: rawMessage,
      errorCode,
    };
  }

  // 4. Unsupported audio format
  if (
    errorCode?.includes("MEDIA_ERR_SRC_NOT_SUPPORTED") ||
    errorCode === "NotSupportedError" ||
    lower.includes("not supported") ||
    lower.includes("unsupported") ||
    lower.includes("codec")
  ) {
    return {
      title: "Unsupported audio",
      summary: "This audio format is not supported.",
      category: "unsupported",
      originalMessage: rawMessage,
      errorCode,
    };
  }

  // 5. Decoding failure
  if (
    errorCode?.includes("MEDIA_ERR_DECODE") ||
    lower.includes("decode error") ||
    lower.includes("could not decode") ||
    lower.includes("decoding failed") ||
    lower.includes("undecodable")
  ) {
    const summary = lower.includes("could not decode")
      ? "This audio file could not be decoded or played."
      : "The audio file could not be decoded.";
    return {
      title: "Playback failed",
      summary,
      category: "decoding",
      originalMessage: rawMessage,
      errorCode,
    };
  }

  // 6. Damaged / corrupted
  if (
    lower.includes("corrupt") ||
    lower.includes("damaged") ||
    lower.includes("malformed")
  ) {
    return {
      title: "Damaged audio",
      summary: "This audio file appears to be damaged.",
      category: "corrupted",
      originalMessage: rawMessage,
      errorCode,
    };
  }

  // 7. Unreadable
  if (lower.includes("unreadable")) {
    return {
      title: "Unreadable audio",
      summary: "The audio file could not be read or accessed.",
      category: "unreadable",
      originalMessage: rawMessage,
      errorCode,
    };
  }

  // 8. Network failure
  if (
    errorCode?.includes("MEDIA_ERR_NETWORK") ||
    lower.includes("network") ||
    lower.includes("offline")
  ) {
    return {
      title: "Network error",
      summary: "A network error interrupted loading.",
      category: "network",
      originalMessage: rawMessage,
      errorCode,
    };
  }

  // Default fallback for general / unknown playback errors
  const fallbackSummary = clean && clean.length > 0 && clean.length <= 90 && !clean.includes("at ")
    ? (clean.endsWith(".") ? clean : `${clean}.`)
    : "This track could not be played.";

  return {
    title: "Playback error",
    summary: fallbackSummary,
    category: "playback",
    originalMessage: rawMessage,
    errorCode,
  };
}
