/**
 * AudioEngine abstraction. The real implementation wraps exactly one
 * HTMLAudioElement (rules §7: single source of truth, no page-owned elements).
 * The interface lets unit tests stub media behavior deterministically.
 */

export type MediaFailure = {
  /** MediaError code semantics: 1 aborted, 2 network, 3 decode, 4 unsupported source. */
  code: number;
  message: string;
};

export type EngineEvents = {
  onTimeUpdate: (currentTimeSec: number) => void;
  onDurationChange: (durationSec: number | null) => void;
  onPlayStateChange: (isPlaying: boolean) => void;
  onBufferingChange: (isBuffering: boolean) => void;
  /** Fired after a seek completes — lets the store verify the seek landed. */
  onSeeked: () => void;
  onEnded: () => void;
  onError: (failure: MediaFailure) => void;
  onDispose?: () => void;
};

export interface AudioEngine {
  readonly element: HTMLAudioElement | null;
  /**
   * Bumped on every setSource/dispose. Lets the store ignore media events
   * that belong to a source the engine has already replaced. Optional so
   * test doubles only implement it when they want that validation.
   */
  readonly sourceGeneration?: number;
  setSource(url: string | null): void;
  play(): Promise<void>;
  pause(): void;
  get currentTimeSec(): number;
  seekSec(seconds: number): void;
  get durationSec(): number | null;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  dispose(): void;
}

export class AutoplayBlockedError extends Error {
  constructor() {
    super("Playback was blocked by the browser's autoplay policy.");
    this.name = "AutoplayBlockedError";
  }
}

export function describeMediaError(code: number): string {
  switch (code) {
    case 1:
      return "Playback was aborted before it could start.";
    case 2:
      return "A network error interrupted loading. If you are offline, reconnect and try again.";
    case 3:
      return "The audio could not be decoded. The file may be corrupt or use an unsupported codec.";
    case 4:
      return "This audio format is not supported by your browser.";
    default:
      return "An unknown playback error occurred.";
  }
}

export class HtmlAudioEngine implements AudioEngine {
  private readonly audio: HTMLAudioElement;
  private readonly events: EngineEvents;
  /** Aborts every element and document listener on dispose. */
  private readonly listenerController = new AbortController();
  private sourceGenerationValue = 0;
  private playing = false;
  private disposed = false;
  private wakeLockSentinel: WakeLockSentinel | null = null;
  private wakeLockPending = false;

  constructor(events: EngineEvents) {
    this.events = events;
    this.audio = new Audio();
    this.audio.preload = "auto";
    // Inline playback (no fullscreen takeover) and invisible mounting keep
    // the one shared element out of the layout while it stays in the DOM.
    this.audio.setAttribute("playsinline", "true");
    this.audio.hidden = true;
    document.body?.appendChild(this.audio);
    this.bindEvents();
  }

  get element(): HTMLAudioElement {
    return this.audio;
  }

  get sourceGeneration(): number {
    return this.sourceGenerationValue;
  }

  private bindEvents(): void {
    const signal = this.listenerController.signal;
    const on = (type: string, listener: () => void): void => {
      this.audio.addEventListener(type, listener, { signal });
    };
    on("timeupdate", () => this.events.onTimeUpdate(this.audio.currentTime));
    on("durationchange", () => this.events.onDurationChange(this.normalizeDuration(this.audio.duration)));
    on("loadedmetadata", () => this.events.onDurationChange(this.normalizeDuration(this.audio.duration)));
    on("play", () => {
      this.playing = true;
      this.tryAcquireWakeLock();
      this.events.onPlayStateChange(true);
    });
    on("pause", () => {
      this.playing = false;
      this.releaseWakeLock();
      this.events.onPlayStateChange(false);
    });
    on("waiting", () => this.events.onBufferingChange(true));
    on("playing", () => this.events.onBufferingChange(false));
    on("canplay", () => this.events.onBufferingChange(false));
    on("seeked", () => this.events.onSeeked());
    on("ended", () => {
      this.playing = false;
      this.releaseWakeLock();
      this.events.onEnded();
    });
    on("error", () => {
      // An error event without a MediaError carries no information about the
      // current source — it surfaces from load() aborting an in-flight fetch
      // and must never become a fabricated code 0.
      const mediaError = this.audio.error;
      if (!mediaError) return;
      // Code 1 (MEDIA_ERR_ABORTED) is the signature of the shared element
      // switching sources: the new source reports its own outcome, so an
      // abort is a transition, not a playback failure.
      if (mediaError.code === 1) return;
      this.playing = false;
      this.releaseWakeLock();
      this.events.onError({ code: mediaError.code, message: mediaError.message });
    });
    // A screen wake lock only makes sense while the page is actually visible
    // and something is playing; visibility flips bracket acquisition.
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.hidden) {
          this.releaseWakeLock();
        } else {
          this.tryAcquireWakeLock();
        }
      },
      { signal },
    );
  }

  /**
   * Screen wake lock, best effort: acquire only while actually playing on a
   * visible document, release on pause/ended/error/hide/dispose. Request
   * failures are swallowed — the API never influences playback. Note the
   * API does not guarantee survival of real screen-off on every platform;
   * it is a hint, not a promise.
   */
  private tryAcquireWakeLock(): void {
    if (this.disposed || !this.playing || document.hidden) return;
    if (this.wakeLockSentinel || this.wakeLockPending) return;
    if (typeof navigator.wakeLock?.request !== "function") return;
    this.wakeLockPending = true;
    navigator.wakeLock
      .request("screen")
      .then((sentinel) => {
        this.wakeLockPending = false;
        // The request may outlive the intent that started it: honor the
        // engine state at resolution time, not at request time.
        if (this.disposed || !this.playing || document.hidden) {
          void sentinel.release().catch(() => undefined);
          return;
        }
        this.wakeLockSentinel = sentinel;
      })
      .catch(() => {
        this.wakeLockPending = false;
      });
  }

  private releaseWakeLock(): void {
    const sentinel = this.wakeLockSentinel;
    this.wakeLockSentinel = null;
    if (sentinel) {
      void sentinel.release().catch(() => undefined);
    }
  }

  private normalizeDuration(duration: number): number | null {
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  }

  setSource(url: string | null): void {
    this.sourceGenerationValue += 1;
    if (url === null) {
      // No source means nothing can be playing; drop the wake lock now so a
      // later visibility flip cannot silently reacquire it for dead media.
      this.playing = false;
      this.releaseWakeLock();
      this.audio.removeAttribute("src");
      this.audio.load();
      return;
    }
    if (this.audio.src !== url) {
      this.audio.src = url;
    }
  }

  async play(): Promise<void> {
    try {
      await this.audio.play();
    } catch (error) {
      if (error instanceof DOMException && (error.name === "NotAllowedError" || error.code === 0)) {
        throw new AutoplayBlockedError();
      }
      throw error;
    }
  }

  pause(): void {
    this.audio.pause();
  }

  get currentTimeSec(): number {
    return this.audio.currentTime;
  }

  seekSec(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    this.audio.currentTime = seconds;
  }

  get durationSec(): number | null {
    return this.normalizeDuration(this.audio.duration);
  }

  setVolume(volume: number): void {
    this.audio.volume = Math.min(1, Math.max(0, volume));
  }

  setMuted(muted: boolean): void {
    this.audio.muted = muted;
  }

  dispose(): void {
    this.sourceGenerationValue += 1;
    this.disposed = true;
    this.playing = false;
    // Abort every element/document listener first so cleanup events fired by
    // load() below cannot re-enter the (possibly store-owned) callbacks.
    this.listenerController.abort();
    this.releaseWakeLock();
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.audio.remove();
    this.events.onDispose?.();
  }
}
