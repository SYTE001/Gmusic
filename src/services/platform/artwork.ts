import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./desktop";

export interface NativeArtworkResult {
  url: string | null;
  source: "embedded" | "cache" | "musicbrainz-caa" | "itunes" | "none";
  releaseGroupMbid: string | null;
  releaseMbid: string | null;
  confidence: number;
  album: string | null;
  artist: string | null;
  transientFailure: boolean;
  fromCache: boolean;
  offline: boolean;
  contentHash: string | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  cachedPath: string | null;
  thumbPath500: string | null;
  thumbPath256: string | null;
  originalPath: string | null;
  failedHttpRequests: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || value === undefined || typeof value === "string";
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isValidNativeArtworkResult(value: unknown): value is NativeArtworkResult {
  if (!isObject(value)) return false;
  const validSources = ["embedded", "cache", "musicbrainz-caa", "itunes", "none"];
  return (
    validSources.includes(String(value.source)) &&
    isNullableString(value.url) &&
    isNullableString(value.releaseGroupMbid) &&
    isNullableString(value.releaseMbid) &&
    typeof value.confidence === "number" &&
    Number.isFinite(value.confidence) &&
    isNullableString(value.album) &&
    isNullableString(value.artist) &&
    typeof value.transientFailure === "boolean" &&
    typeof value.fromCache === "boolean" &&
    typeof value.offline === "boolean" &&
    isNullableString(value.contentHash) &&
    isNullableString(value.mimeType) &&
    isNullableNumber(value.width) &&
    isNullableNumber(value.height) &&
    isNullableString(value.cachedPath) &&
    isNullableString(value.thumbPath500) &&
    isNullableString(value.thumbPath256) &&
    isNullableString(value.originalPath) &&
    typeof value.failedHttpRequests === "number"
  );
}

function toBlobFromIpcBytes(raw: unknown, mimeType: string): Blob | null {
  if (raw instanceof ArrayBuffer) {
    return raw.byteLength > 0 ? new Blob([raw], { type: mimeType }) : null;
  }
  if (ArrayBuffer.isView(raw)) {
    const view = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    return view.byteLength > 0 ? new Blob([view.slice()], { type: mimeType }) : null;
  }
  if (Array.isArray(raw) && raw.length > 0) {
    return new Blob([new Uint8Array(raw)], { type: mimeType });
  }
  return null;
}

export async function readDesktopCachedArtworkBlob(
  path: string,
  mimeType = "image/jpeg",
): Promise<Blob | null> {
  if (!isTauriRuntime() || !path) return null;
  try {
    const raw = await invoke<unknown>("read_desktop_cached_artwork_bytes", { path });
    return toBlobFromIpcBytes(raw, mimeType);
  } catch (error) {
    console.warn("Could not read desktop cached artwork bytes.", error);
    return null;
  }
}

export async function extractDesktopEmbeddedArtwork(
  path: string,
  trackId?: string,
  size: "256" | "500" | "1200" = "500",
): Promise<Blob | null> {
  if (!isTauriRuntime() || !path) return null;
  try {
    const res = await invoke<unknown>("extract_desktop_embedded_artwork", {
      path,
      trackId: trackId ?? null,
      size,
    });
    if (!isValidNativeArtworkResult(res)) return null;
    const targetPath = res.cachedPath ?? res.thumbPath500 ?? res.originalPath;
    if (!targetPath) return null;
    return await readDesktopCachedArtworkBlob(targetPath, res.mimeType ?? "image/jpeg");
  } catch (error) {
    console.warn("Native embedded artwork extraction unavailable; using web fallback.", error);
    return null;
  }
}

export async function resolveDesktopArtwork(
  track: {
    id: string;
    title: string;
    artist: string;
    album?: string;
    durationMs?: number | null;
    desktopPath?: string | null;
  },
  options?: {
    size?: "256" | "500" | "1200";
    forceRefresh?: boolean;
    excludeUrls?: string[];
    downloadAndCache?: boolean;
  },
): Promise<NativeArtworkResult | null> {
  if (!isTauriRuntime()) return null;
  try {
    const result = await invoke<unknown>("resolve_desktop_artwork", {
      request: {
        track: {
          id: track.id,
          title: track.title,
          artist: track.artist,
          album: track.album ?? "",
          durationMs: track.durationMs ?? null,
        },
        desktopPath: track.desktopPath ?? null,
        size: options?.size ?? "500",
        forceRefresh: options?.forceRefresh ?? false,
        offline: typeof navigator !== "undefined" && navigator.onLine === false,
        excludeUrls: options?.excludeUrls ?? [],
        downloadAndCache: options?.downloadAndCache ?? false,
      },
    });
    if (!isValidNativeArtworkResult(result)) {
      throw new Error("Invalid native artwork resolution response.");
    }
    return result;
  } catch (error) {
    console.warn("Native artwork resolution unavailable; using web artwork services.", error);
    return null;
  }
}

export async function cacheDesktopRemoteArtwork(
  track: {
    id: string;
    title: string;
    artist: string;
    album?: string;
    durationMs?: number | null;
  },
  url: string,
  source = "itunes",
  size: "256" | "500" | "1200" = "500",
): Promise<Blob | null> {
  if (!isTauriRuntime() || !url) return null;
  try {
    const res = await invoke<unknown>("cache_desktop_remote_artwork", {
      track: {
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album ?? "",
        durationMs: track.durationMs ?? null,
      },
      url,
      source,
      size,
    });
    if (!isValidNativeArtworkResult(res)) return null;
    const targetPath = res.cachedPath ?? res.thumbPath500 ?? res.originalPath;
    if (!targetPath) return null;
    return await readDesktopCachedArtworkBlob(targetPath, res.mimeType ?? "image/jpeg");
  } catch {
    return null;
  }
}

export async function invalidateDesktopArtworkCache(params: {
  trackId?: string;
  title?: string;
  artist?: string;
  album?: string;
  includeAlbum?: boolean;
  clearAll?: boolean;
}): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invoke("invalidate_desktop_artwork_cache", {
      request: {
        trackId: params.trackId ?? null,
        title: params.title ?? null,
        artist: params.artist ?? null,
        album: params.album ?? null,
        includeAlbum: params.includeAlbum ?? true,
        clearAll: params.clearAll ?? false,
      },
    });
  } catch {
    // Ignore desktop cache invalidation errors
  }
}
