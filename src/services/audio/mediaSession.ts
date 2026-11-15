/**
 * MediaSessionController. Bridges the shared audio engine's playback state to
 * the browser Media Session API (lock-screen / OS media controls). It owns no
 * audio element and no playback clock — the caller (playbackStore) passes
 * already-resolved track text, artwork URLs and playback positions; the
 * controller only validates, converts and publishes.
 *
 * Every Media Session feature is feature-detected and failures are contained:
 * unsupported actions, metadata construction or canvas conversion degrade to
 * the previous state and never impact audio playback. Artwork conversion only
 * runs when the session is actually supported, is bounded by a load timeout,
 * and is cancelled whenever the track/artwork target changes or the
 * controller is cleared/disposed.
 */

export type MediaSessionActions = {
  play: () => void;
  pause: () => void;
  previous: () => void;
  next: () => void;
  /** Seek to an absolute position in seconds (validated by the caller's store). */
  seek: (seconds: number) => void;
  /** Seek relative to the current position; negative is backwards. */
  seekBy: (deltaSeconds: number) => void;
};

export type MediaSessionTrack = {
  title: string;
  artist: string;
  album: string;
};

export type MediaSessionPlaybackPosition = {
  duration: number;
  position: number;
  playbackRate?: number;
};

/** Default hardware seek step when the platform does not supply an offset. */
const DEFAULT_SEEK_STEP_SEC = 10;
/** Square JPEG renditions published with the metadata (spec caps at 512). */
const ARTWORK_SIZES_PX = [96, 256, 512] as const;
const JPEG_DATA_URL_PREFIX = "data:image/jpeg";
/** Bounded wait for artwork image loads; stale loads are cancelled, not awaited forever. */
export const IMAGE_LOAD_TIMEOUT_MS = 10_000;

type ArtworkConversion = {
  url: string;
  artwork: MediaImage[];
};

function getSession(): MediaSession | null {
  if (typeof navigator === "undefined") return null;
  const session = navigator.mediaSession;
  if (!session || typeof session.setActionHandler !== "function") return null;
  return session;
}

function supportsMediaMetadata(): boolean {
  return typeof MediaMetadata === "function";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** An absent offset means the 10s default; a broken offset means "do nothing". */
function normalizeSeekOffset(offset: number | undefined): number | null {
  if (offset === undefined) return DEFAULT_SEEK_STEP_SEC;
  return isFiniteNumber(offset) && offset > 0 ? offset : null;
}

function isRemoteHttpUrl(url: string): boolean {
  return /^https?:/i.test(url);
}

/**
 * blob: URLs must never reach final metadata (they die with the document and
 * the requirement is that they are converted). Other directly fetchable URLs
 * may be published as-is when canvas conversion is impossible.
 */
function isDirectlyUsableArtworkUrl(url: string): boolean {
  return /^(https?:|data:)/i.test(url);
}

/**
 * Loads an image, bounded by `signal` cancellation and a hard timeout. The
 * listeners are always cleaned up and the fetch is cancelled on abort, so a
 * superseded conversion never retains an image load indefinitely.
 */
function loadImage(url: string, signal: AbortSignal, crossOrigin?: "anonymous"): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (typeof Image !== "function" || signal.aborted) {
      resolve(null);
      return;
    }
    let image: HTMLImageElement;
    try {
      image = new Image();
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    // Hoisted helpers keep the timeout/abort wiring single-assignment.
    function cleanup(): void {
      image.onload = null;
      image.onerror = null;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
    function fail(): void {
      if (settled) return;
      settled = true;
      cleanup();
      // Cancel the in-flight fetch so superseded conversions release the image.
      try {
        image.removeAttribute("src");
      } catch {
        // Ignore.
      }
      resolve(null);
    }
    function succeed(): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(image);
    }
    const onAbort = (): void => fail();
    const timer = setTimeout(fail, IMAGE_LOAD_TIMEOUT_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    if (crossOrigin) {
      try {
        image.crossOrigin = crossOrigin;
      } catch {
        // Ignore.
      }
    }
    image.onload = succeed;
    image.onerror = fail;
    try {
      image.src = url;
    } catch {
      fail();
    }
  });
}

/**
 * Remote artwork is loaded with CORS first so the canvas stays clean; if the
 * host refuses CORS the load is retried without it, in which case conversion
 * fails and the direct-URL fallback applies instead.
 */
async function loadImageForArtwork(url: string, signal: AbortSignal): Promise<HTMLImageElement | null> {
  if (!isRemoteHttpUrl(url)) return loadImage(url, signal);
  const clean = await loadImage(url, signal, "anonymous");
  if (clean || signal.aborted) return clean;
  return loadImage(url, signal);
}

/**
 * Canvas conversion failed but some sizes may already have been converted;
 * otherwise, for URLs the OS can fetch itself, publish the original URL (the
 * requirement to convert applies to blob: URLs only). blob: gets no fallback.
 */
function fallbackOrPartial(url: string, artwork: MediaImage[]): MediaImage[] | null {
  if (artwork.length > 0) return artwork;
  return isDirectlyUsableArtworkUrl(url) ? [{ src: url, sizes: "512x512" }] : null;
}

/**
 * Converts the artwork at `url` into square center-cropped JPEG data URLs of
 * 96/256/512 px. Data URLs (never blob: URLs) are required in final metadata
 * so OS media surfaces can consume them independently of the document's
 * lifetime. Never throws: any failure resolves null or a direct-URL fallback,
 * keeping text-only metadata.
 */
async function convertToJpegArtwork(url: string, signal: AbortSignal): Promise<MediaImage[] | null> {
  if (typeof document === "undefined") return null;
  try {
    const image = await loadImageForArtwork(url, signal);
    if (!image || signal.aborted || !image.naturalWidth || !image.naturalHeight) return null;
    const artwork: MediaImage[] = [];
    for (const size of ARTWORK_SIZES_PX) {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d");
        if (!context) return fallbackOrPartial(url, artwork);
        // Cover-fit: scale to fill the square, center-crop the overflow.
        const scale = Math.max(size / image.naturalWidth, size / image.naturalHeight);
        const width = image.naturalWidth * scale;
        const height = image.naturalHeight * scale;
        context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
        const src = canvas.toDataURL("image/jpeg");
        if (!src.startsWith(JPEG_DATA_URL_PREFIX)) return fallbackOrPartial(url, artwork);
        artwork.push({ src, sizes: `${size}x${size}`, type: "image/jpeg" });
      } catch {
        // Tainted canvas, missing rasterizer, etc. — degrade, never throw.
        return fallbackOrPartial(url, artwork);
      }
    }
    return artwork;
  } catch {
    // The whole pipeline is contained: conversion problems can never escape.
    return null;
  }
}

export class MediaSessionController {
  private readonly session: MediaSession | null;
  private readonly actions: MediaSessionActions;
  private readonly registeredActions = new Set<MediaSessionAction>();
  private track: MediaSessionTrack | null = null;
  /** Current artwork target; also the setArtwork dedupe key. */
  private artworkUrl: string | undefined;
  /** Single-entry cache: at most the current URL's conversion is retained. */
  private cachedArtwork: ArtworkConversion | null = null;
  /** Bumped on every track/artwork/clear/dispose to invalidate stale async work. */
  private generation = 0;
  /** Cancellable handle for the at-most-one in-flight artwork conversion. */
  private activeConversion: AbortController | null = null;
  private disposed = false;

  constructor(actions: MediaSessionActions) {
    this.actions = actions;
    this.session = getSession();
    if (!this.session) return;
    this.registerAction("play", () => this.actions.play());
    this.registerAction("pause", () => this.actions.pause());
    this.registerAction("previoustrack", () => this.actions.previous());
    this.registerAction("nexttrack", () => this.actions.next());
    this.registerAction("seekto", (details) => {
      const seekTime = details.seekTime;
      if (isFiniteNumber(seekTime) && seekTime >= 0) {
        this.actions.seek(seekTime);
      }
    });
    this.registerAction("seekbackward", (details) => {
      const offset = normalizeSeekOffset(details.seekOffset);
      if (offset !== null) this.actions.seekBy(-offset);
    });
    this.registerAction("seekforward", (details) => {
      const offset = normalizeSeekOffset(details.seekOffset);
      if (offset !== null) this.actions.seekBy(offset);
    });
  }

  private registerAction(action: MediaSessionAction, handler: MediaSessionActionHandler): void {
    if (!this.session) return;
    try {
      this.session.setActionHandler(action, handler);
      this.registeredActions.add(action);
    } catch {
      // This action type is unsupported on this platform — skip it alone.
    }
  }

  /**
   * Publishes track text immediately (metadata without artwork), then
   * upgrades the metadata asynchronously if artwork was provided. Passing no
   * artworkUrl publishes text-only metadata. Resets the setArtwork dedupe and
   * cancels any pending conversion.
   */
  setTrack(track: MediaSessionTrack, artworkUrl?: string): void {
    this.generation += 1;
    const generation = this.generation;
    this.cancelActiveConversion();
    this.track = { title: track.title, artist: track.artist, album: track.album };
    this.artworkUrl = artworkUrl;
    this.cachedArtwork = artworkUrl !== undefined && this.cachedArtwork?.url === artworkUrl ? this.cachedArtwork : null;
    this.applyMetadata();
    if (artworkUrl === undefined || this.cachedArtwork) return;
    this.startConversion(generation, artworkUrl);
  }

  /**
   * Updates or clears artwork without touching the track text. Duplicate
   * calls with the URL already targeted (cached or conversion still pending)
   * are deduped; callers may publish the same URL repeatedly.
   */
  setArtwork(url?: string): void {
    if (url !== undefined && url === this.artworkUrl) return;
    if (url === undefined && this.artworkUrl === undefined) return;
    this.generation += 1;
    const generation = this.generation;
    this.cancelActiveConversion();
    this.artworkUrl = url;
    this.cachedArtwork = null;
    this.applyMetadata();
    if (url === undefined) return;
    this.startConversion(generation, url);
  }

  /**
   * Publishes playbackState, and the position state. Omitting `position`
   * clears the OS-side position; an invalid one (non-finite values or a
   * non-positive duration) is cleared too, never fabricated.
   */
  syncPlayback(isPlaying: boolean, position?: MediaSessionPlaybackPosition): void {
    if (this.disposed || !this.session) return;
    try {
      this.session.playbackState = isPlaying ? "playing" : "paused";
    } catch {
      // State sync is best effort.
    }
    if (position === undefined) {
      this.clearPositionState();
      return;
    }
    const { duration, position: rawPosition, playbackRate } = position;
    if (!isFiniteNumber(duration) || duration <= 0 || !isFiniteNumber(rawPosition)) {
      this.clearPositionState();
      return;
    }
    const clampedPosition = Math.min(Math.max(rawPosition, 0), duration);
    const rate = playbackRate !== undefined && isFiniteNumber(playbackRate) && playbackRate > 0 ? playbackRate : 1;
    try {
      this.session.setPositionState({ duration, position: clampedPosition, playbackRate: rate });
    } catch {
      // The platform rejected the state — clear rather than leave a stale one.
      this.clearPositionState();
    }
  }

  /** Clears published track/artwork/position state but keeps the controller usable. */
  clear(): void {
    this.generation += 1;
    this.cancelActiveConversion();
    this.track = null;
    this.artworkUrl = undefined;
    this.cachedArtwork = null;
    if (!this.session) return;
    try {
      this.session.metadata = null;
    } catch {
      // Ignore.
    }
    try {
      this.session.playbackState = "none";
    } catch {
      // Ignore.
    }
    this.clearPositionState();
  }

  /** Removes every handler and all published state; the controller is dead after this. */
  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.cancelActiveConversion();
    this.track = null;
    this.artworkUrl = undefined;
    this.cachedArtwork = null;
    if (!this.session) return;
    for (const action of this.registeredActions) {
      try {
        this.session.setActionHandler(action, null);
      } catch {
        // Ignore — disposal must never throw.
      }
    }
    this.registeredActions.clear();
    try {
      this.session.metadata = null;
    } catch {
      // Ignore.
    }
    try {
      this.session.playbackState = "none";
    } catch {
      // Ignore.
    }
    this.clearPositionState();
  }

  private applyMetadata(): void {
    if (this.disposed || !this.session || !supportsMediaMetadata()) return;
    try {
      this.session.metadata = new MediaMetadata({
        title: this.track?.title ?? "",
        artist: this.track?.artist ?? "",
        album: this.track?.album ?? "",
        artwork: this.cachedArtwork?.artwork ?? [],
      });
    } catch {
      // Metadata construction is optional platform behavior; text-only or no
      // metadata is acceptable and must not affect audio.
    }
  }

  /**
   * Starts the at-most-one artwork conversion. Skipped entirely when the
   * Media Session (or MediaMetadata) is unsupported — no image is ever
   * fetched for metadata nobody can display.
   */
  private startConversion(generation: number, url: string): void {
    if (this.disposed || !this.session || !supportsMediaMetadata()) return;
    const controller = new AbortController();
    this.activeConversion = controller;
    void this.applyArtwork(controller, generation, url);
  }

  /** Applies a completed artwork conversion only if it is still current. */
  private async applyArtwork(controller: AbortController, generation: number, url: string): Promise<void> {
    let artwork: MediaImage[] | null = null;
    try {
      artwork = await convertToJpegArtwork(url, controller.signal);
    } catch {
      // The conversion pipeline is fully contained; this is a second belt so
      // a rejected promise can never escape as an unhandled rejection.
      artwork = null;
    } finally {
      if (this.activeConversion === controller) this.activeConversion = null;
    }
    if (controller.signal.aborted || this.disposed || generation !== this.generation || this.artworkUrl !== url) return;
    if (!artwork) return;
    // Replace (never accumulate) the conversion cache.
    this.cachedArtwork = { url, artwork };
    this.applyMetadata();
  }

  private cancelActiveConversion(): void {
    const controller = this.activeConversion;
    this.activeConversion = null;
    controller?.abort();
  }

  private clearPositionState(): void {
    if (!this.session) return;
    try {
      this.session.setPositionState();
    } catch {
      // Ignore.
    }
  }
}
