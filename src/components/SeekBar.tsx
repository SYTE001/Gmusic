import { useCallback, useEffect, useRef, useState } from "react";
import { usePlaybackStore } from "../stores/playbackStore";
import { formatClock } from "../utils/misc";

/**
 * Interactive seek bar. The displayed position interpolates with
 * requestAnimationFrame straight from the audio element (the timing
 * authority) while playing, and pauses the rAF loop when hidden or paused
 * (PRD §7.7, rules §12).
 */
export function SeekBar({ compact = false }: { compact?: boolean }) {
  const durationMs = usePlaybackStore((state) => state.durationMs);
  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const seek = usePlaybackStore((state) => state.seek);
  const [scrubMs, setScrubMs] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const timeLabelRef = useRef<HTMLSpanElement>(null);
  const scrubbingRef = useRef(false);
  const rafAliveRef = useRef(0);
  const lastSecRef = useRef(-1);
  const lastFracRef = useRef(-1);
  const lastBarWriteRef = useRef(0);

  const applyVisualPosition = useCallback(
    (ms: number, force = false) => {
      const dur = durationMs ?? 0;
      const frac = dur > 0 ? Math.min(1, Math.max(0, ms / dur)) : 0;
      const safeFrac = Number.isFinite(frac) ? frac : 0;
      const now = performance.now();
      if (force || (Math.abs(safeFrac - lastFracRef.current) >= 0.0008 && now - lastBarWriteRef.current >= 50)) {
        lastFracRef.current = safeFrac;
        lastBarWriteRef.current = now;
        if (fillRef.current) {
          fillRef.current.style.transform = `scaleX(${safeFrac})`;
        }
        if (thumbRef.current) {
          thumbRef.current.style.transform = `translate3d(${safeFrac * 100}%, 0, 0)`;
        }
      }
      const sec = Math.floor(ms / 1000);
      if (sec !== lastSecRef.current) {
        lastSecRef.current = sec;
        if (timeLabelRef.current) {
          timeLabelRef.current.textContent = formatClock(ms);
        }
        if (barRef.current) {
          barRef.current.setAttribute("aria-valuenow", String(Math.round(ms / 1000)));
          barRef.current.setAttribute("aria-valuetext", `${formatClock(ms)} of ${formatClock(durationMs)}`);
        }
      }
    },
    [durationMs],
  );

  // Smooth interpolation while playing; static otherwise.
  useEffect(() => {
    lastSecRef.current = -1;
    lastFracRef.current = -1;
    if (!isPlaying) {
      applyVisualPosition(usePlaybackStore.getState().currentTimeMs, true);
      return;
    }
    let frame = 0;
    const tick = () => {
      rafAliveRef.current = Date.now();
      if (!scrubbingRef.current) {
        const engine = usePlaybackStore.getState().getEngine();
        const ms = engine.element ? engine.currentTimeSec * 1000 : usePlaybackStore.getState().currentTimeMs;
        applyVisualPosition(ms, false);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isPlaying, applyVisualPosition]);

  // Store-time fallback: covers seeking while paused/ended, and keeps the
  // display live when rAF is throttled (unfocused/background window) while
  // audio keeps playing, without subscribing React render state to currentTimeMs.
  useEffect(() => {
    return usePlaybackStore.subscribe((state) => {
      if (scrubbingRef.current) return;
      if (state.isPlaying && Date.now() - rafAliveRef.current < 500) return;
      applyVisualPosition(state.currentTimeMs, true);
    });
  }, [applyVisualPosition]);

  const positionFromEvent = useCallback(
    (clientX: number): number => {
      const bar = barRef.current;
      if (!bar || durationMs === null) return 0;
      const rect = bar.getBoundingClientRect();
      const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return fraction * durationMs;
    },
    [durationMs],
  );

  const disabled = durationMs === null || durationMs <= 0;

  const onPointerDown = (event: React.PointerEvent) => {
    if (disabled) return;
    scrubbingRef.current = true;
    const next = positionFromEvent(event.clientX);
    setScrubMs(next);
    applyVisualPosition(next, true);
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent) => {
    if (!scrubbingRef.current || disabled) return;
    const next = positionFromEvent(event.clientX);
    setScrubMs(next);
    applyVisualPosition(next, true);
  };
  const onPointerUp = (event: React.PointerEvent) => {
    if (!scrubbingRef.current || disabled) return;
    scrubbingRef.current = false;
    const target = positionFromEvent(event.clientX);
    setScrubMs(null);
    seek(target);
    applyVisualPosition(target, true);
  };

  const effectiveMs = scrubMs ?? 0;
  const fraction = durationMs ? Math.min(1, Math.max(0, effectiveMs / durationMs)) : 0;
  const safeFraction = Number.isFinite(fraction) ? fraction : 0;

  return (
    <div className={`flex w-full items-center ${compact ? "gap-2" : "gap-3"}`}>
      <span
        ref={timeLabelRef}
        className={`tabular-nums text-text-muted ${compact ? "w-9 text-[11px]" : "w-11 text-xs"}`}
      >
        {formatClock(effectiveMs)}
      </span>
      <div
        ref={barRef}
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={durationMs ? Math.round(durationMs / 1000) : 0}
        aria-valuenow={Math.round(effectiveMs / 1000)}
        aria-valuetext={`${formatClock(effectiveMs)} of ${formatClock(durationMs)}`}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        className="group relative h-5 flex-1 cursor-pointer touch-none"
        style={{ contain: "layout style" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
            event.preventDefault();
            const direction = event.key === "ArrowRight" ? 1 : -1;
            usePlaybackStore.getState().seekBy(direction * 5000);
          } else if (event.key === "Home") {
            seek(0);
          } else if (event.key === "End" && durationMs) {
            seek(durationMs - 500);
          }
        }}
      >
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-surface-hover" />
        {/* Fill uses scaleX: GPU-composited, perfectly in sync with the rAF
            clock, and immune to width-transition lag on resume/seek jumps. */}
        <div
          ref={fillRef}
          className="absolute left-0 top-1/2 h-1.5 w-full -translate-y-1/2 origin-left rounded-full bg-accent-strong"
          style={{ transform: `scaleX(${safeFraction})`, willChange: "transform" }}
        />
        <div
          ref={thumbRef}
          className="pointer-events-none absolute inset-x-0 top-1/2"
          style={{ transform: `translate3d(${safeFraction * 100}%, 0, 0)`, willChange: "transform" }}
        >
          <div
            className={`size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-text-primary transition-opacity ${
              scrubMs !== null || isPlaying ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            }`}
          />
        </div>
      </div>
      <span className={`tabular-nums text-text-muted ${compact ? "w-9 text-right text-[11px]" : "w-11 text-right text-xs"}`}>
        {formatClock(durationMs)}
      </span>
    </div>
  );
}
