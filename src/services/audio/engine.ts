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
  private sourceGenerationValue = 0;

  constructor(events: EngineEvents) {
    this.events = events;
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.bindEvents();
  }

  get element(): HTMLAudioElement {
    return this.audio;
  }

  get sourceGeneration(): number {
    return this.sourceGenerationValue;
  }

  private bindEvents(): void {
    this.audio.addEventListener("timeupdate", () => this.events.onTimeUpdate(this.audio.currentTime));
    this.audio.addEventListener("durationchange", () => this.events.onDurationChange(this.normalizeDuration(this.audio.duration)));
    this.audio.addEventListener("loadedmetadata", () => this.events.onDurationChange(this.normalizeDuration(this.audio.duration)));
    this.audio.addEventListener("play", () => this.events.onPlayStateChange(true));
    this.audio.addEventListener("pause", () => this.events.onPlayStateChange(false));
    this.audio.addEventListener("waiting", () => this.events.onBufferingChange(true));
    this.audio.addEventListener("playing", () => this.events.onBufferingChange(false));
    this.audio.addEventListener("canplay", () => this.events.onBufferingChange(false));
    this.audio.addEventListener("seeked", () => this.events.onSeeked());
    this.audio.addEventListener("ended", () => this.events.onEnded());
    this.audio.addEventListener("error", () => {
      // An error event without a MediaError carries no information about the
      // current source — it surfaces from load() aborting an in-flight fetch
      // and must never become a fabricated code 0.
      const mediaError = this.audio.error;
      if (!mediaError) return;
      // Code 1 (MEDIA_ERR_ABORTED) is the signature of the shared element
      // switching sources: the new source reports its own outcome, so an
      // abort is a transition, not a playback failure.
      if (mediaError.code === 1) return;
      this.events.onError({ code: mediaError.code, message: mediaError.message });
    });
  }

  private normalizeDuration(duration: number): number | null {
    return Number.isFinite(duration) && duration > 0 ? duration : null;
  }

  setSource(url: string | null): void {
    this.sourceGenerationValue += 1;
    if (url === null) {
      this.audio.removeAttribute("src");
      this.audio.load();
      return;
    }
    this.audio.src = url;
    this.audio.load();
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
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
  }
}
