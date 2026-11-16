import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useDynamicIslandStore, type IslandAnimationStage } from "../stores/dynamicIslandStore";
import { useLibraryStore, useTrackById } from "../stores/libraryStore";
import { usePlaybackStore } from "../stores/playbackStore";
import { formatClock } from "../utils/misc";
import { Artwork, useArtworkUrl } from "./Artwork";
import {
  CloseIcon,
  HeartIcon,
  MusicNoteIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
  QueueIcon,
  WarningIcon,
} from "./Icons";
import "./DynamicIslandMediaCard.css";

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined") return false;
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const attr = typeof document !== "undefined" ? document.documentElement.dataset.motion : undefined;
    return attr === "on" || (attr !== "off" && Boolean(media?.matches));
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const update = () => {
      const attr = document.documentElement.dataset.motion;
      setReduced(attr === "on" || (attr !== "off" && Boolean(media?.matches)));
    };

    media?.addEventListener?.("change", update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });

    return () => {
      media?.removeEventListener?.("change", update);
      observer.disconnect();
    };
  }, []);

  return reduced;
}

/** Vertical (swipe-up) intent threshold before pointer capture is taken. */
const SWIPE_INTENT_PX = 8;
/** Upward drag distance that confirms a swipe-to-dismiss gesture. */
const SWIPE_DISMISS_DISTANCE_PX = 48;

/**
 * Keys handled by the media card's own controls (buttons/slider). Stopping
 * their propagation keeps AppShell's global playback shortcuts (Space, Enter,
 * arrows) from double-firing on top of the focused control.
 */
const HANDLED_CONTROL_KEYS = new Set([" ", "Enter", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

function stopHandledControlKeys(event: KeyboardEvent<HTMLElement>) {
  if (HANDLED_CONTROL_KEYS.has(event.key)) {
    event.stopPropagation();
  }
}

/**
 * Interactive progress line for the media card: elapsed time, scrub track and
 * negative remaining time. Fill and both labels are written through refs from
 * a requestAnimationFrame loop reading the shared audio engine (the timing
 * authority) while playing, with a playback-store subscription as fallback —
 * there is no render-level subscription to high-frequency playback time.
 * Scrubbing is pointer- or keyboard-driven and seeks the shared engine on
 * release.
 */
function MediaProgress({ onScrubActiveChange }: { onScrubActiveChange: (active: boolean) => void }) {
  const durationMs = usePlaybackStore((state) => state.durationMs);
  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const barRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const elapsedRef = useRef<HTMLSpanElement>(null);
  const remainingRef = useRef<HTMLSpanElement>(null);
  const scrubbingRef = useRef(false);
  const rafAliveRef = useRef(0);

  const applyPosition = useCallback(
    (ms: number) => {
      const dur = durationMs ?? 0;
      const frac = dur > 0 ? Math.min(1, Math.max(0, ms / dur)) : 0;
      const safeFrac = Number.isFinite(frac) ? frac : 0;
      if (fillRef.current) {
        fillRef.current.style.transform = `translateY(-50%) scaleX(${safeFrac})`;
      }
      if (elapsedRef.current) {
        elapsedRef.current.textContent = formatClock(ms);
      }
      if (remainingRef.current) {
        remainingRef.current.textContent = dur > 0 ? `-${formatClock(Math.max(0, dur - ms))}` : "--:--";
      }
      if (barRef.current) {
        barRef.current.setAttribute("aria-valuenow", String(Math.round(ms / 1000)));
        barRef.current.setAttribute(
          "aria-valuetext",
          `${formatClock(ms)} of ${formatClock(durationMs)}, ${formatClock(Math.max(0, dur - ms))} remaining`,
        );
      }
    },
    [durationMs],
  );

  // Smooth interpolation while playing; static otherwise.
  useEffect(() => {
    applyPosition(usePlaybackStore.getState().currentTimeMs);
    if (!isPlaying) return;
    let frame = requestAnimationFrame(function tick() {
      rafAliveRef.current = Date.now();
      const state = usePlaybackStore.getState();
      if (!scrubbingRef.current) {
        const engine = state.getEngine();
        const ms = engine.element ? engine.currentTimeSec * 1000 : state.currentTimeMs;
        applyPosition(ms);
      }
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [isPlaying, applyPosition]);

  // Store-time fallback: covers seek-while-paused and keeps the fill live when
  // rAF is throttled (background window) while audio keeps playing.
  useEffect(() => {
    return usePlaybackStore.subscribe((state) => {
      if (scrubbingRef.current) return;
      if (state.isPlaying && Date.now() - rafAliveRef.current < 500) return;
      applyPosition(state.currentTimeMs);
    });
  }, [applyPosition]);

  const positionFromEvent = (clientX: number): number => {
    const bar = barRef.current;
    if (!bar || durationMs === null || durationMs <= 0) return 0;
    const rect = bar.getBoundingClientRect();
    const width = rect.width > 0 ? rect.width : 120;
    const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / width));
    return fraction * durationMs;
  };

  const disabled = durationMs === null || durationMs <= 0;

  return (
    <div className="dimc-progress" onKeyDown={stopHandledControlKeys}>
      <span
        ref={elapsedRef}
        className="dimc-time dimc-time-elapsed"
        aria-hidden="true"
      >
        {formatClock(usePlaybackStore.getState().currentTimeMs)}
      </span>
      <div
        ref={barRef}
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={durationMs ? Math.round(durationMs / 1000) : 0}
        aria-valuenow={Math.round(usePlaybackStore.getState().currentTimeMs / 1000)}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        className="dimc-track"
        onPointerDown={(event) => {
          if (disabled) return;
          event.stopPropagation();
          scrubbingRef.current = true;
          onScrubActiveChange(true);
          applyPosition(positionFromEvent(event.clientX));
          (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!scrubbingRef.current || disabled) return;
          event.stopPropagation();
          applyPosition(positionFromEvent(event.clientX));
        }}
        onPointerUp={(event) => {
          if (!scrubbingRef.current || disabled) return;
          event.stopPropagation();
          scrubbingRef.current = false;
          const target = positionFromEvent(event.clientX);
          onScrubActiveChange(false);
          usePlaybackStore.getState().seek(target);
          applyPosition(target);
        }}
        onPointerCancel={() => {
          if (!scrubbingRef.current) return;
          scrubbingRef.current = false;
          onScrubActiveChange(false);
          applyPosition(usePlaybackStore.getState().currentTimeMs);
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            event.preventDefault();
            event.stopPropagation();
            usePlaybackStore.getState().seekBy(event.key === "ArrowRight" ? 5000 : -5000);
          } else if (event.key === "Home") {
            event.preventDefault();
            event.stopPropagation();
            usePlaybackStore.getState().seek(0);
          } else if (event.key === "End" && durationMs) {
            event.preventDefault();
            event.stopPropagation();
            usePlaybackStore.getState().seek(durationMs - 500);
          }
        }}
      >
        <div ref={fillRef} className="dimc-fill" style={{ willChange: "transform" }} />
      </div>
      <span
        ref={remainingRef}
        className="dimc-time dimc-time-remaining"
        aria-hidden="true"
      >
        {durationMs
          ? `-${formatClock(Math.max(0, durationMs - usePlaybackStore.getState().currentTimeMs))}`
          : "--:--"}
      </span>
    </div>
  );
}

/**
 * Floating dark frosted media card with an ambient blurred artwork layer.
 * Mirrors the playing track with artwork, title/artist, a playing-state
 * equalizer at the right edge of the identity row, elapsed/remaining progress
 * scrubbing and five equal columns of controls with a larger central play
 * button. Auto-dismissal pauses for the union of hover, focus, pointer and
 * scrub activity (including interactions that begin before the card finishes
 * expanding); a vertical swipe-up dismisses; Escape or the close button also
 * dismiss. The card is keyed by track id so the spring entry replays on track
 * change.
 */
function MediaIslandCard({
  trackId,
  stage,
  reducedMotion,
  onOpenQueue,
}: {
  trackId: string;
  stage: IslandAnimationStage;
  reducedMotion: boolean;
  onOpenQueue?: () => void;
}) {
  const track = useTrackById(trackId);
  const artworkUrl = useArtworkUrl(trackId);
  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const toggleLike = useLibraryStore((state) => state.toggleLike);
  const pauseAutoDismiss = useDynamicIslandStore((state) => state.pauseAutoDismiss);
  const resumeAutoDismiss = useDynamicIslandStore((state) => state.resumeAutoDismiss);
  const dismiss = useDynamicIslandStore((state) => state.dismissNotification);

  const cardRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef(false);
  const focusRef = useRef(false);
  const pointerRef = useRef(false);
  const scrubRef = useRef(false);
  const swipeRef = useRef(false);
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const swipeDeltaRef = useRef(0);

  const isExpanded = stage === "expanded";
  const isCollapsing = stage === "collapsing";

  // Resume only when no interaction channel is still active; pause otherwise.
  // This keeps overlapping interactions (hover + focus + scrub) robust.
  const syncAutoDismiss = useCallback(() => {
    if (hoverRef.current || focusRef.current || pointerRef.current || scrubRef.current) {
      pauseAutoDismiss();
    } else {
      resumeAutoDismiss();
    }
  }, [pauseAutoDismiss, resumeAutoDismiss]);

  // Interactions that began while the card was still in its 60ms initial
  // stage are not yet pausable (the store pauses only in the expanded stage);
  // once expanded, re-sync so hover/focus/touch/scrub carry through.
  useEffect(() => {
    if (isExpanded) {
      syncAutoDismiss();
    }
  }, [isExpanded, syncAutoDismiss]);

  // Escape dismisses the card. Editable targets keep their own Escape
  // semantics; the card never hijacks text entry.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      dismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dismiss]);

  const onPointerDown = (event: ReactPointerEvent) => {
    if (!event.isPrimary) return;
    pointerRef.current = true;
    swipeRef.current = false;
    swipeDeltaRef.current = 0;
    swipeStartRef.current = { x: event.clientX, y: event.clientY };
    syncAutoDismiss();
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    const start = swipeStartRef.current;
    if (!start || !pointerRef.current) return;
    const dx = event.clientX - start.x;
    const up = start.y - event.clientY; // upward distance is positive
    if (!swipeRef.current) {
      // Only vertical intent starts a swipe; horizontal movement belongs to
      // scrubbing and small drags belong to button clicks.
      if (up > SWIPE_INTENT_PX && Math.abs(up) > Math.abs(dx)) {
        swipeRef.current = true;
        try {
          cardRef.current?.setPointerCapture?.(event.pointerId);
        } catch {
          // Capture is an optimization for dragging outside the card; the
          // gesture still works within the card without it.
        }
      } else {
        return;
      }
    }
    swipeDeltaRef.current = Math.max(0, up);
    if (cardRef.current) {
      // Half-rate follow gives the gesture natural resistance.
      cardRef.current.style.transform = `translate3d(0, ${-swipeDeltaRef.current * 0.5}px, 0)`;
    }
  };

  const endPointer = () => {
    if (!pointerRef.current) return;
    pointerRef.current = false;
    swipeStartRef.current = null;
    const dismissed = swipeRef.current && swipeDeltaRef.current >= SWIPE_DISMISS_DISTANCE_PX;
    swipeRef.current = false;
    if (cardRef.current) {
      cardRef.current.style.transform = "";
    }
    if (dismissed) {
      dismiss();
      return;
    }
    syncAutoDismiss();
  };

  // Cancellation and lost capture never dismiss a swipe: restore the card and
  // the interaction refs so a later gesture starts clean.
  const cancelPointer = () => {
    if (!pointerRef.current && !swipeRef.current) return;
    pointerRef.current = false;
    swipeRef.current = false;
    swipeStartRef.current = null;
    swipeDeltaRef.current = 0;
    if (cardRef.current) {
      cardRef.current.style.transform = "";
    }
    syncAutoDismiss();
  };

  const handleScrubActiveChange = useCallback(
    (active: boolean) => {
      scrubRef.current = active;
      syncAutoDismiss();
    },
    [syncAutoDismiss],
  );

  const title = track?.title || "Untitled track";
  const artist = track?.artist || "Unknown artist";

  return (
    <div className="pointer-events-none fixed top-3 left-1/2 z-50 flex w-full -translate-x-1/2 items-center justify-center px-3 md:top-4">
      <div
        key={trackId}
        ref={cardRef}
        role="group"
        aria-label={`Now playing: ${title}`}
        data-kind="media"
        className={`dimc-card pointer-events-auto select-none ${
          isCollapsing ? "dimc-card-collapsing" : reducedMotion ? "" : "dimc-card-spring"
        }`}
        onMouseEnter={() => {
          hoverRef.current = true;
          syncAutoDismiss();
        }}
        onMouseLeave={() => {
          hoverRef.current = false;
          syncAutoDismiss();
        }}
        onFocus={() => {
          focusRef.current = true;
          syncAutoDismiss();
        }}
        onBlur={(event) => {
          // Focus moving between controls inside the card must not resume the
          // dismissal countdown (blur fires before the next focus).
          const next = event.relatedTarget as Node | null;
          if (next && cardRef.current?.contains(next)) return;
          focusRef.current = false;
          syncAutoDismiss();
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={cancelPointer}
        onLostPointerCapture={cancelPointer}
      >
        {/* Dark blurred ambient artwork backdrop */}
        {artworkUrl && (
          <div
            className="dimc-ambient"
            style={{ backgroundImage: `url("${artworkUrl}")` }}
            aria-hidden="true"
          />
        )}

        <div className="dimc-content">
          {/* Artwork + track identity row, equalizer at the row's right edge */}
          <div className="flex min-w-0 items-center gap-3 pr-7">
            <Artwork trackId={trackId} alt="" className="size-14 shrink-0" rounded="rounded-xl" />
            <div className="min-w-0 flex-1">
              <span className="dimc-title">{title}</span>
              <span className="dimc-artist">{artist}</span>
            </div>
            <span
              className={`dimc-eq ${isPlaying && !reducedMotion ? "dimc-eq-active" : ""}`}
              aria-hidden="true"
            >
              {Array.from({ length: 5 }, (_, index) => (
                <span key={index} className="dimc-eq-bar" style={{ animationDelay: `${index * 0.12}s` }} />
              ))}
            </span>
          </div>

          {/* Elapsed + scrub track + negative remaining; seeks the shared engine on release */}
          <MediaProgress onScrubActiveChange={handleScrubActiveChange} />

          {/* Controls: five equal columns, larger central play button */}
          <div className="dimc-controls" onKeyDown={stopHandledControlKeys}>
            <button
              type="button"
              className="dimc-btn"
              title="Like (L)"
              aria-label={track?.isLiked ? "Remove from liked songs" : "Add to liked songs"}
              aria-pressed={Boolean(track?.isLiked)}
              disabled={!track}
              onClick={() => {
                if (track) void toggleLike(track.id);
              }}
            >
              <HeartIcon size={20} filled={Boolean(track?.isLiked)} />
            </button>
            <button
              type="button"
              className="dimc-btn"
              title="Previous (Shift+←)"
              aria-label="Previous track"
              onClick={() => usePlaybackStore.getState().previous()}
            >
              <PrevIcon size={20} />
            </button>
            <button
              type="button"
              className="dimc-btn dimc-btn-play"
              title="Play/Pause (Space)"
              aria-label={isPlaying ? "Pause" : "Play"}
              onClick={() => usePlaybackStore.getState().togglePlay()}
            >
              {isPlaying ? <PauseIcon size={30} /> : <PlayIcon size={30} />}
            </button>
            <button
              type="button"
              className="dimc-btn"
              title="Next (Shift+→)"
              aria-label="Next track"
              onClick={() => usePlaybackStore.getState().next(true)}
            >
              <NextIcon size={20} />
            </button>
            <button
              type="button"
              className="dimc-btn"
              title="Queue (Q)"
              aria-label="Open queue"
              onClick={() => onOpenQueue?.()}
            >
              <QueueIcon size={20} />
            </button>
          </div>
        </div>

        {/* Manual close control (Escape also dismisses) */}
        <button
          type="button"
          className="dimc-btn dimc-btn-close"
          aria-label="Dismiss notification"
          onKeyDown={stopHandledControlKeys}
          onClick={(event) => {
            event.stopPropagation();
            dismiss();
          }}
        >
          <CloseIcon size={14} />
        </button>
      </div>
    </div>
  );
}

export function DynamicIslandNotification({ onOpenQueue }: { onOpenQueue?: () => void } = {}) {
  const current = useDynamicIslandStore((state) => state.current);
  const stage = useDynamicIslandStore((state) => state.stage);
  const dismiss = useDynamicIslandStore((state) => state.dismissNotification);
  const pauseAutoDismiss = useDynamicIslandStore((state) => state.pauseAutoDismiss);
  const resumeAutoDismiss = useDynamicIslandStore((state) => state.resumeAutoDismiss);
  const reset = useDynamicIslandStore((state) => state.reset);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const reducedMotion = usePrefersReducedMotion();
  const navigate = useNavigate();

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      reset();
    };
  }, [reset]);

  if (!current || stage === "idle") {
    return null;
  }

  // Transient media card variant (user-requested frosted glass override).
  if (current.kind === "media" && current.trackId) {
    return (
      <MediaIslandCard
        trackId={current.trackId}
        stage={stage}
        reducedMotion={reducedMotion}
        onOpenQueue={onOpenQueue}
      />
    );
  }

  const isExpanded = stage === "expanded";
  const isCollapsing = stage === "collapsing";

  const handleOpenBroken = () => {
    dismiss();
    const url = current.trackId ? `/broken?trackId=${encodeURIComponent(current.trackId)}` : "/broken";
    navigate(url);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleOpenBroken();
    }
  };

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="pointer-events-none fixed top-4 left-1/2 z-50 hidden w-full -translate-x-1/2 items-center justify-center px-4 min-[900px]:flex"
    >
      <div
        role="button"
        tabIndex={0}
        aria-label={`${current.title}${current.song ? ` — ${current.song}` : ""}`}
        onClick={handleOpenBroken}
        onKeyDown={handleKeyDown}
        onMouseEnter={pauseAutoDismiss}
        onMouseLeave={resumeAutoDismiss}
        onFocus={pauseAutoDismiss}
        onBlur={resumeAutoDismiss}
        className={`pointer-events-auto relative flex cursor-pointer select-none items-center overflow-hidden border bg-surface ${
          reducedMotion ? "" : "transition-all"
        } ${
          isExpanded
            ? "min-h-[74px] w-[min(540px,calc(100vw-32px))] rounded-[30px] p-2.5 md:p-3 shadow-[var(--shadow-overlay)] hover:border-text-secondary/40 focus-visible:outline-2 focus-visible:outline-accent"
            : "size-12 rounded-[18px] p-1 shadow-md"
        } ${isCollapsing ? "scale-90 opacity-0" : "scale-100 opacity-100"}`}
        style={{
          borderColor: "var(--border-subtle)",
          transitionDuration: reducedMotion ? "0.01ms" : isExpanded ? "340ms" : "240ms",
          transitionTimingFunction: reducedMotion
            ? "linear"
            : isExpanded
              ? "cubic-bezier(0.34, 1.45, 0.64, 1)"
              : "cubic-bezier(0.4, 0, 0.2, 1)",
        }}
      >
        {/* Red icon container with rounded corners and white warning triangle */}
        <div
          className={`grid shrink-0 place-items-center bg-[#EF233C] text-white shadow-sm transition-all duration-300 ${
            isExpanded
              ? "size-13 md:size-14 rounded-[20px]"
              : "size-10 rounded-[14px]"
          }`}
          aria-hidden
        >
          <WarningIcon size={isExpanded ? 24 : 18} className="text-white" />
        </div>

        {/* Content: Big typography title + track pill (no cluttered description) */}
        <div
          className={`min-w-0 flex-1 flex-col justify-center pl-3.5 pr-8 ${
            reducedMotion ? "" : "transition-opacity duration-200"
          } ${
            isExpanded
              ? reducedMotion
                ? "flex opacity-100"
                : "flex opacity-100 delay-100"
              : "pointer-events-none hidden opacity-0"
          }`}
        >
          {/* Big Typography Error Title */}
          <div className="flex items-center leading-tight">
            <span className="truncate text-[16px] md:text-[17px] font-bold tracking-tight text-text-primary">
              {current.title}
            </span>
          </div>

          {/* Track Information Pill */}
          {current.song && (
            <div className="mt-1.5 inline-flex max-w-full items-center gap-1.5 self-start overflow-hidden rounded-full bg-surface-raised px-2.5 py-1 text-[11.5px] md:text-[12px] text-text-primary leading-none">
              <MusicNoteIcon size={12} className="shrink-0 text-text-secondary" />
              <span className="truncate font-medium">{current.song}</span>
            </div>
          )}
        </div>

        {/* Close button on top-right side */}
        <button
          ref={closeButtonRef}
          type="button"
          aria-label="Dismiss notification"
          onClick={(e) => {
            e.stopPropagation();
            dismiss();
          }}
          className={`absolute top-3 right-3.5 grid size-7 shrink-0 place-items-center rounded-full text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary ${
            isExpanded
              ? reducedMotion
                ? "opacity-100"
                : "opacity-100 delay-100"
              : "pointer-events-none opacity-0"
          }`}
        >
          <CloseIcon size={14} />
        </button>
      </div>
    </div>
  );
}
