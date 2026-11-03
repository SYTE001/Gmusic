import { useEffect, useRef } from "react";
import {
  DomLyricPlayer,
  LayoutReason,
  LayoutReasonStrategyMap,
  type LyricLine,
  type LyricLineMouseEvent,
} from "@applemusic-like-lyrics/core";
import "@applemusic-like-lyrics/core/style.css";
import "./amll.css";
import { usePlaybackStore } from "../../stores/playbackStore";
import { lineSeekTargetMs, toLyricClockMs } from "../../services/lyrics/amllAdapter";

/** Without physics springs, line transitions settle within 340ms; 400ms gives plenty of headroom while paused. */
const SETTLE_MS = 400;

/**
 * Exact timestamp preservation options for AMLL's LyricDataManager.
 * By default AMLL enables `tryAdvanceStartTime = true`, which subtracts up to 600ms
 * from `line.startTime` on the first line and after every inter-line gap, causing
 * lyrics to scroll and highlight up to 0.6s before the singer actually sings them.
 */
const EXACT_TIMING_OPTIMIZE_OPTIONS = {
  tryAdvanceStartTime: false,
  resetLineTimestamps: false,
  cleanUnintentionalOverlaps: false,
  syncMainAndBackgroundLines: false,
  normalizeSpaces: false,
} as const;

/**
 * Keep all lines in a track mounted so scrolling never triggers mid-playback
 * DOM insertion/removal, synchronous layout reads, or ResizeObserver height jumps.
 */
const FULL_TRACK_OVERSCAN_PX = 100000;

// Eliminate staggered delays between lyric lines during normal playback ticks
// and resize/config updates so lines move in unified synchronization without sequential lag.
if (typeof LayoutReasonStrategyMap !== "undefined") {
  for (const entry of Object.values(LayoutReasonStrategyMap)) {
    if (entry) entry.disableStagger = true;
  }
}

/** Creates a lightweight noop Animation object to intercept unnecessary per-word float/glow animations. */
function createNoopAnimation(id: string): Animation {
  let currentTime = 0;
  let playbackRate = 1;
  return {
    id,
    play: () => {},
    pause: () => {},
    cancel: () => {},
    finish: () => {},
    reverse: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
    get playState() {
      return "idle" as AnimationPlayState;
    },
    get currentTime() {
      return currentTime;
    },
    set currentTime(val: number | CSSNumericValue | null) {
      currentTime = typeof val === "number" ? val : 0;
    },
    get playbackRate() {
      return playbackRate;
    },
    set playbackRate(val: number) {
      playbackRate = val;
    },
    effect: {
      getComputedTiming: () => ({ delay: 0, duration: 0 }),
    } as unknown as AnimationEffect,
  } as unknown as Animation;
}

// Eliminate redundant per-word float and per-character emphasize/matrix3d Web Animations
// instances while preserving the `fade-word` mask-image animations responsible for
// word-by-word highlight synchronization.
if (typeof Element !== "undefined" && Element.prototype) {
  const proto = Element.prototype as unknown as {
    animate: typeof Element.prototype.animate;
    __gmLyricPatched?: boolean;
  };
  if (!proto.__gmLyricPatched) {
    const originalAnimate = proto.animate;
    proto.animate = function (
      keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
      options?: number | KeyframeAnimationOptions,
    ): Animation {
      if (typeof options === "object" && options !== null) {
        const id = options.id;
        if (id === "float-word" || (typeof id === "string" && id.startsWith("emphasize-word"))) {
          return createNoopAnimation(id);
        }
      }
      return originalAnimate.call(this, keyframes, options);
    };
    proto.__gmLyricPatched = true;
  }
}

type InternalLyricGroup = {
  getElement?: () => HTMLElement;
  onLineSizeChange?: (size: [number, number]) => void;
};

type InternalDomLyricPlayer = DomLyricPlayer & {
  size?: [number, number];
  currentLyricGroups?: InternalLyricGroup[];
  lyricGroupSize?: WeakMap<object, [number, number]>;
  layoutCalculator?: {
    setLineHeight?: (index: number, height: number) => void;
  };
  calcLayout?: (reason: unknown) => void;
};

/**
 * Sets lyric lines and synchronously pre-measures all mounted line heights before paint
 * so lines render at their final vertical coordinates immediately without a delayed
 * ResizeObserver height shift on the next frame.
 */
function applyLyricLinesSynchronously(
  player: DomLyricPlayer,
  host: HTMLElement,
  lines: LyricLine[],
  lyricClockMs: number,
): void {
  const internal = player as InternalDomLyricPlayer;
  host.classList.add("gm-amll-no-transition");

  if (Array.isArray(internal.size) && host.clientHeight > 0) {
    internal.size[0] = host.clientWidth;
    internal.size[1] = host.clientHeight;
  }

  player.setLyricLines(lines, lyricClockMs);

  if (
    Array.isArray(internal.currentLyricGroups) &&
    internal.layoutCalculator?.setLineHeight &&
    internal.lyricGroupSize
  ) {
    let measuredAny = false;
    internal.currentLyricGroups.forEach((group, index) => {
      const el = group.getElement?.();
      if (!el) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (w > 0 || h > 0) {
        internal.lyricGroupSize?.set(group, [w, h]);
        group.onLineSizeChange?.([w, h]);
        internal.layoutCalculator?.setLineHeight?.(index, h);
        measuredAny = true;
      }
    });
    if (measuredAny) {
      internal.calcLayout?.(LayoutReason?.RebuildView ?? 0);
      player.update(0);
    }
  }

  requestAnimationFrame(() => {
    host.classList.remove("gm-amll-no-transition");
  });
}

export type AmllLyricPlayerProps = {
  lines: LyricLine[];
  /** Per-song offset (ms). Applied to the player clock only; lines are never rewritten. */
  offsetMs: number;
  isPlaying: boolean;
  /** CSS font-size for the lyric text (existing Gmusic lyric size setting). */
  fontSize: string;
  /** Called with the audio-clock position a clicked line should seek to. */
  onSeek: (audioMs: number) => void;
};

/** Audio element clock in ms — the single source of truth for lyric timing. */
function readAudioClockMs(): number {
  const state = usePlaybackStore.getState();
  const engine = state.getEngine();
  return engine.element ? engine.currentTimeSec * 1000 : state.currentTimeMs;
}

/**
 * AMLL lyric renderer. The time value never touches React state: a
 * requestAnimationFrame loop reads the audio clock and feeds the player
 * imperatively, only while playing (plus a short settle window after
 * pause/seek/offset/line changes). Rendering concerns only — loading, badges,
 * offset persistence and seeking stay in LyricsView.
 */
export default function AmllLyricPlayer({ lines, offsetMs, isPlaying, fontSize, onSeek }: AmllLyricPlayerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<DomLyricPlayer | null>(null);
  const kickRef = useRef<() => void>(() => undefined);
  const offsetRef = useRef(offsetMs);
  const playingRef = useRef(isPlaying);
  const onSeekRef = useRef(onSeek);
  const linesRef = useRef(lines);

  useEffect(() => {
    offsetRef.current = offsetMs;
    onSeekRef.current = onSeek;
  });

  // Create the player once per mount; dispose on unmount (view hidden).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const player = new DomLyricPlayer();
    playerRef.current = player;
    const element = player.getElement();
    host.appendChild(element);

    // Disable blur, spring physics, JS scale loops, and timestamp-mutating optimizers.
    player.setEnableBlur(false);
    player.setEnableSpring(false);
    player.setEnableScale(false);
    player.setEnableAutoSeekDetection?.(false);
    player.setOverscanPx?.(FULL_TRACK_OVERSCAN_PX);
    player.setLyricProcessConfig?.({
      optimizeOptions: { ...EXACT_TIMING_OPTIMIZE_OPTIONS },
    });

    let raf = 0;
    let lastFrame = 0;
    let lastAudioMs = readAudioClockMs();
    let settleUntil = 0;

    const frame = (now: number) => {
      raf = 0;
      const delta = lastFrame === 0 ? 0 : now - lastFrame;
      lastFrame = now;
      const audioMs = readAudioClockMs();
      const audioDelta = Math.abs(audioMs - lastAudioMs);
      const isSeek = lastFrame !== 0 && audioDelta > Math.max(600, delta * 3);
      lastAudioMs = audioMs;
      player.setCurrentTime(toLyricClockMs(audioMs, offsetRef.current), isSeek);
      player.update(delta);
      if (playingRef.current || now < settleUntil) {
        raf = requestAnimationFrame(frame);
      } else {
        lastFrame = 0;
      }
    };
    const kick = () => {
      settleUntil = performance.now() + SETTLE_MS;
      if (raf === 0) raf = requestAnimationFrame(frame);
    };
    kickRef.current = kick;

    const onClick = (event: Event) => {
      const line = (event as LyricLineMouseEvent).line?.getLine();
      if (line) {
        const targetAudioMs = lineSeekTargetMs(line.startTime, offsetRef.current);
        lastAudioMs = targetAudioMs;
        onSeekRef.current(targetAudioMs);
        player.setCurrentTime(toLyricClockMs(targetAudioMs, offsetRef.current), true);
        kick();
      }
    };
    player.addEventListener("click", onClick);

    // Paused seeks update the store clock; follow them without a running loop.
    const unsubscribe = usePlaybackStore.subscribe((state, previous) => {
      if (state.currentTimeMs !== previous.currentTimeMs) {
        const audioMs = readAudioClockMs();
        if (!state.isPlaying || Math.abs(audioMs - lastAudioMs) > 600) {
          lastAudioMs = audioMs;
          player.setCurrentTime(toLyricClockMs(audioMs, offsetRef.current), true);
          kick();
        }
      }
    });

    applyLyricLinesSynchronously(player, host, linesRef.current, toLyricClockMs(readAudioClockMs(), offsetRef.current));
    if (playingRef.current) player.resume();
    else player.pause();
    kick();

    return () => {
      unsubscribe();
      player.removeEventListener("click", onClick);
      if (raf !== 0) cancelAnimationFrame(raf);
      kickRef.current = () => undefined;
      player.dispose();
      element.remove();
      playerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const player = playerRef.current;
    const host = hostRef.current;
    if (!player || !host || linesRef.current === lines) return;
    linesRef.current = lines;
    applyLyricLinesSynchronously(player, host, lines, toLyricClockMs(readAudioClockMs(), offsetRef.current));
    kickRef.current();
  }, [lines]);

  useEffect(() => {
    playingRef.current = isPlaying;
    const player = playerRef.current;
    if (!player) return;
    if (isPlaying) player.resume();
    else player.pause();
    kickRef.current();
  }, [isPlaying]);

  // Offset change: re-sync immediately as a seek, whether playing or paused.
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    player.setCurrentTime(toLyricClockMs(readAudioClockMs(), offsetMs), true);
    kickRef.current();
  }, [offsetMs]);

  return <div ref={hostRef} className="gm-amll" style={{ ["--gm-lyric-font-size" as string]: fontSize }} />;
}
