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

/** Without physics springs, line transitions settle within 280ms; 350ms gives plenty of headroom while paused. */
const SETTLE_MS = 350;

// Eliminate staggered delays between lyric lines during normal playback ticks
// so lines update in unified synchronization without sequential lag.
if (
  typeof LayoutReasonStrategyMap !== "undefined" &&
  typeof LayoutReason !== "undefined" &&
  LayoutReason?.PlaybackTick &&
  LayoutReasonStrategyMap[LayoutReason.PlaybackTick]
) {
  LayoutReasonStrategyMap[LayoutReason.PlaybackTick].disableStagger = true;
}

/** Creates a lightweight noop Animation object to intercept unnecessary per-word float animations. */
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

// Eliminate redundant per-word float and bounce Web Animations instances while preserving
// the `fade-word` mask-image animations responsible for word-by-word highlight sync.
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
        if (id === "float-word" || (typeof id === "string" && id.includes("emphasize-word-float"))) {
          return createNoopAnimation(id);
        }
      }
      return originalAnimate.call(this, keyframes, options);
    };
    proto.__gmLyricPatched = true;
  }
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
    // Disable blur, spring physics, and JS scale loops unconditionally.
    // Line transforms, solid 3D spin rotation, and transitions are rendered purely
    // by GPU-composited CSS transitions in amll.css without spring bounce or rubber overshoot.
    player.setEnableBlur(false);
    player.setEnableSpring(false);
    player.setEnableScale(false);

    const onClick = (event: Event) => {
      const line = (event as LyricLineMouseEvent).line?.getLine();
      if (line) onSeekRef.current(lineSeekTargetMs(line.startTime, offsetRef.current));
    };
    player.addEventListener("click", onClick);

    let raf = 0;
    let lastFrame = 0;
    let settleUntil = 0;
    const frame = (now: number) => {
      raf = 0;
      const delta = lastFrame === 0 ? 0 : now - lastFrame;
      lastFrame = now;
      player.setCurrentTime(toLyricClockMs(readAudioClockMs(), offsetRef.current));
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

    // Paused seeks update the store clock; follow them without a running loop.
    const unsubscribe = usePlaybackStore.subscribe((state, previous) => {
      if (!state.isPlaying && state.currentTimeMs !== previous.currentTimeMs) {
        player.setCurrentTime(toLyricClockMs(readAudioClockMs(), offsetRef.current), true);
        kick();
      }
    });

    player.setLyricLines(linesRef.current, toLyricClockMs(readAudioClockMs(), offsetRef.current));
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
    if (!player || linesRef.current === lines) return;
    linesRef.current = lines;
    player.setLyricLines(lines, toLyricClockMs(readAudioClockMs(), offsetRef.current));
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
