import { useEffect, useRef } from "react";
import {
  DomLyricPlayer,
  LayoutReasonStrategyMap,
  type LyricLine,
  type LyricLineMouseEvent,
} from "@applemusic-like-lyrics/core";
import "@applemusic-like-lyrics/core/style.css";
import "./amll.css";
import { usePlaybackStore } from "../../stores/playbackStore";
import { lineSeekTargetMs, toLyricClockMs } from "../../services/lyrics/amllAdapter";

/** Settle window (ms) after pause/seek/offset changes. */
const SETTLE_MS = 400;

/**
 * Exact timestamp preservation options for AMLL's LyricDataManager.
 */
const EXACT_TIMING_OPTIMIZE_OPTIONS = {
  tryAdvanceStartTime: false,
  resetLineTimestamps: false,
  cleanUnintentionalOverlaps: false,
  syncMainAndBackgroundLines: false,
  normalizeSpaces: false,
} as const;

const FULL_TRACK_OVERSCAN_PX = 100000;

if (typeof LayoutReasonStrategyMap !== "undefined") {
  for (const entry of Object.values(LayoutReasonStrategyMap)) {
    if (entry) entry.disableStagger = true;
  }
}

/** Creates a lightweight noop Animation object to intercept unnecessary per-word float/glow animations. */
function createNoopAnimation(id: string): Animation {
  let currentTime = 0;
  let playbackRate = 1;
  let startTime: number | null = 0;
  const anim = {
    id,
    play: () => {},
    pause: () => {},
    cancel: () => {},
    finish: () => {},
    reverse: () => {},
    commitStyles: () => {},
    persist: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
    onfinish: null,
    oncancel: null,
    onremove: null,
    pending: false,
    replaceState: "active" as const,
    timeline: null,
    get startTime() {
      return startTime;
    },
    set startTime(val: number | null) {
      startTime = val;
    },
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
    get finished() {
      return Promise.resolve(anim as unknown as Animation);
    },
    get ready() {
      return Promise.resolve(anim as unknown as Animation);
    },
    effect: {
      getComputedTiming: () => ({ delay: 0, duration: 0 }),
    } as unknown as AnimationEffect,
  } as unknown as Animation;
  return anim;
}

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
  enable?: (currentTime: number, isPlaying: boolean) => void;
  disable?: () => void;
};

type InternalDomLyricPlayer = {
  currentLyricGroups?: InternalLyricGroup[];
  resizeObserver?: ResizeObserver;
  calcLayout?: (reason: unknown) => void;
  syncTime?: (currentTime: number, isSeek: boolean) => void;
};

/**
 * Binary search over sorted lyric line timestamps (`O(log N)`).
 * Returns the index of the latest line whose `startTime <= timeMs`, or `-1` if before line 0.
 */
export function findActiveLineBinary(lines: LyricLine[], timeMs: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (lines[mid].startTime <= timeMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

type SingleContainerController = {
  isNativeDomPlayer: boolean;
  rebuild: (lines: LyricLine[], lyricClockMs: number, isPlaying: boolean) => void;
  syncTime: (lyricClockMs: number, isSeek: boolean, isPlaying: boolean) => void;
  measure: () => void;
  dispose: () => void;
};

/**
 * Wraps AMLL's line elements inside a single scrolling container (`div.gm-amll-scroll-track`)
 * moved via `transform: translate3d(0, y, 0)` with cached line positions (`Float64Array`).
 *
 * - Measures line heights once on load and on container `ResizeObserver` (zero per-frame layout reads).
 * - Binary-searches line timestamps and updates DOM only when the active line index changes.
 * - Toggles `.FmKaba_active` only on the previous and new active line.
 * - Preserves full compatibility with unit-test `FakePlayer` when `currentLyricGroups` is absent.
 */
function createSingleContainerController(
  player: DomLyricPlayer,
  host: HTMLElement,
): SingleContainerController {
  const internal = player as unknown as InternalDomLyricPlayer;
  const playerRoot = player.getElement();
  const scrollTrack = document.createElement("div");
  scrollTrack.className = "gm-amll-scroll-track";

  let currentLines: LyricLine[] = [];
  let groups: InternalLyricGroup[] = [];
  let lineTops = new Float64Array(0);
  let lineHeights = new Float64Array(0);
  let viewportHeight = 400;
  let activeIndex = -2;
  let currentY = Number.NaN;
  let isNative = false;

  const applyScrollForActiveIndex = (idx: number, immediate: boolean) => {
    if (!isNative || groups.length === 0) return;
    const clampedIdx = idx >= 0 ? Math.min(idx, groups.length - 1) : 0;
    const top = lineTops[clampedIdx] ?? 0;
    const height = lineHeights[clampedIdx] ?? 48;
    const anchorY = viewportHeight * 0.36;
    const targetY = Math.round(anchorY - (top + height * 0.5));

    if (immediate) {
      host.classList.add("gm-amll-no-transition");
    }
    if (targetY !== currentY || immediate) {
      currentY = targetY;
      scrollTrack.style.transform = `translate3d(0, ${targetY}px, 0)`;
    }
    if (immediate) {
      requestAnimationFrame(() => {
        host.classList.remove("gm-amll-no-transition");
      });
    }
  };

  const measure = () => {
    if (!isNative) return;
    viewportHeight = host.clientHeight || playerRoot.clientHeight || 400;
    const count = groups.length;
    if (lineTops.length !== count) {
      lineTops = new Float64Array(count);
      lineHeights = new Float64Array(count);
    }
    let accTop = 0;
    for (let i = 0; i < count; i++) {
      const el = groups[i]?.getElement?.();
      const h = el ? el.offsetHeight || 48 : 48;
      lineTops[i] = accTop;
      lineHeights[i] = h;
      accTop += h;
    }
    applyScrollForActiveIndex(activeIndex, true);
  };

  const syncTime = (lyricClockMs: number, isSeek: boolean, isPlaying: boolean) => {
    if (!isNative) {
      player.setCurrentTime(lyricClockMs, isSeek);
      player.update(16);
      return;
    }

    const nextIdx = findActiveLineBinary(currentLines, lyricClockMs);

    // If the active line index has not changed and this is not a seek:
    if (nextIdx === activeIndex && !isSeek) {
      // Only update word-mask animator if the active line has word-by-word timestamps
      if (nextIdx >= 0 && (currentLines[nextIdx]?.words.length ?? 0) > 1) {
        groups[nextIdx]?.enable?.(lyricClockMs, isPlaying);
      }
      return;
    }

    // Active line index changed (or seek): toggle class ONLY on previous and new active line
    if (activeIndex >= 0 && activeIndex < groups.length && activeIndex !== nextIdx) {
      const prevGroup = groups[activeIndex];
      const prevEl = prevGroup?.getElement?.();
      if (prevEl) {
        prevEl.classList.remove("FmKaba_active");
        prevEl.removeAttribute("data-active");
      }
      prevGroup?.disable?.();
    }

    if (nextIdx >= 0 && nextIdx < groups.length) {
      const nextGroup = groups[nextIdx];
      const nextEl = nextGroup?.getElement?.();
      if (nextEl) {
        nextEl.classList.add("FmKaba_active");
        nextEl.setAttribute("data-active", "true");
      }
      if ((currentLines[nextIdx]?.words.length ?? 0) > 1) {
        nextGroup?.enable?.(lyricClockMs, isPlaying);
      }
    }

    activeIndex = nextIdx;
    applyScrollForActiveIndex(nextIdx, isSeek);
  };

  const rebuild = (lines: LyricLine[], lyricClockMs: number, isPlaying: boolean) => {
    currentLines = lines;
    activeIndex = -2;
    currentY = Number.NaN;

    host.classList.add("gm-amll-no-transition");
    player.setLyricLines(lines, lyricClockMs);

    if (Array.isArray(internal.currentLyricGroups)) {
      isNative = true;
      groups = internal.currentLyricGroups;

      // Disable AMLL's internal per-line absolute positioning & per-line ResizeObserver
      internal.calcLayout = () => {};
      internal.syncTime = () => {};
      internal.resizeObserver?.disconnect?.();

      if (scrollTrack.parentElement !== playerRoot) {
        playerRoot.appendChild(scrollTrack);
      }

      const elements: HTMLElement[] = [];
      for (let i = 0; i < groups.length; i++) {
        const el = groups[i]?.getElement?.();
        if (el) {
          el.style.transform = "";
          el.style.opacity = "";
          el.classList.remove("FmKaba_active");
          el.removeAttribute("data-active");
          elements.push(el);
        }
      }
      scrollTrack.replaceChildren(...elements);

      measure();
      syncTime(lyricClockMs, true, isPlaying);
    } else {
      isNative = false;
      player.setCurrentTime(lyricClockMs, true);
      player.update(0);
    }

    requestAnimationFrame(() => {
      host.classList.remove("gm-amll-no-transition");
    });
  };

  let resizeRaf = 0;
  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        measure();
      });
    });
    observer.observe(host);
  }

  return {
    get isNativeDomPlayer() {
      return isNative;
    },
    rebuild,
    syncTime,
    measure,
    dispose: () => {
      cancelAnimationFrame(resizeRaf);
      observer?.disconnect();
      scrollTrack.remove();
    },
  };
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
 * Synchronized lyric renderer with single-container GPU transform scrolling
 * (`translate3d(0, y, 0)`), cached line geometry, and binary-searched active line updates.
 */
export default function AmllLyricPlayer({ lines, offsetMs, isPlaying, fontSize, onSeek }: AmllLyricPlayerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<DomLyricPlayer | null>(null);
  const controllerRef = useRef<SingleContainerController | null>(null);
  const kickRef = useRef<() => void>(() => undefined);
  const offsetRef = useRef(offsetMs);
  const playingRef = useRef(isPlaying);
  const onSeekRef = useRef(onSeek);
  const linesRef = useRef(lines);

  useEffect(() => {
    offsetRef.current = offsetMs;
    onSeekRef.current = onSeek;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const player = new DomLyricPlayer();
    playerRef.current = player;
    const element = player.getElement();
    host.appendChild(element);

    player.setEnableBlur(false);
    player.setEnableSpring(false);
    player.setEnableScale(false);
    player.setEnableAutoSeekDetection?.(false);
    player.setOverscanPx?.(FULL_TRACK_OVERSCAN_PX);
    player.setLyricProcessConfig?.({
      optimizeOptions: { ...EXACT_TIMING_OPTIMIZE_OPTIONS },
    });

    const controller = createSingleContainerController(player, host);
    controllerRef.current = controller;

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

      const lyricClockMs = toLyricClockMs(audioMs, offsetRef.current);
      controller.syncTime(lyricClockMs, isSeek, playingRef.current);

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
        controller.syncTime(toLyricClockMs(targetAudioMs, offsetRef.current), true, playingRef.current);
        kick();
      }
    };
    player.addEventListener("click", onClick);

    const unsubscribe = usePlaybackStore.subscribe((state, previous) => {
      if (state.currentTimeMs !== previous.currentTimeMs) {
        const audioMs = readAudioClockMs();
        if (!state.isPlaying || Math.abs(audioMs - lastAudioMs) > 600) {
          lastAudioMs = audioMs;
          controller.syncTime(toLyricClockMs(audioMs, offsetRef.current), true, state.isPlaying);
          kick();
        }
      }
    });

    controller.rebuild(linesRef.current, toLyricClockMs(readAudioClockMs(), offsetRef.current), playingRef.current);
    if (playingRef.current) player.resume();
    else player.pause();
    kick();

    return () => {
      unsubscribe();
      player.removeEventListener("click", onClick);
      if (raf !== 0) cancelAnimationFrame(raf);
      kickRef.current = () => undefined;
      controller.dispose();
      controllerRef.current = null;
      player.dispose();
      element.remove();
      playerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller || linesRef.current === lines) return;
    linesRef.current = lines;
    controller.rebuild(lines, toLyricClockMs(readAudioClockMs(), offsetRef.current), playingRef.current);
    kickRef.current();
  }, [lines]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    controller.measure();
  }, [fontSize]);

  useEffect(() => {
    playingRef.current = isPlaying;
    const player = playerRef.current;
    if (!player) return;
    if (isPlaying) player.resume();
    else player.pause();
    kickRef.current();
  }, [isPlaying]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    controller.syncTime(toLyricClockMs(readAudioClockMs(), offsetMs), true, playingRef.current);
    kickRef.current();
  }, [offsetMs]);

  return <div ref={hostRef} className="gm-amll" style={{ ["--gm-lyric-font-size" as string]: fontSize }} />;
}
